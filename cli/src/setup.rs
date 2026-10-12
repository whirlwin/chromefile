//! Everything install sets up besides the extension itself: the extracted
//! host, the node it runs on, native messaging host manifests, the Claude
//! Code MCP registration, and migration from the old claude-browser-bridge
//! names.

use crate::{files, host};
use anyhow::{Context, Result, bail};
use serde_json::json;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

pub const HOST_NAME: &str = "io.whirlwin.chromefile";
pub const MCP_NAME: &str = "chromefile";
pub const EXTENSION_ID: &str = "cbapdndkoijjfggigdfalnjgjopdebid";

// The names before the project became chromefile, only for migration.
const OLD_HOST_NAME: &str = "io.whirlwin.claude_browser_bridge";
const OLD_MCP_NAME: &str = "claude-browser-bridge";
const OLD_APP_DIR: &str = "claude-browser-bridge";

/// Chromium browsers: data folder relative to ~/Library/Application Support,
/// and a label.
pub const BROWSERS: &[(&str, &str)] = &[
    ("Google/Chrome", "Chrome"),
    ("Google/Chrome Beta", "Chrome Beta"),
    ("Google/Chrome Canary", "Chrome Canary"),
    ("Google/Chrome for Testing", "Chrome for Testing"),
    ("Chromium", "Chromium"),
    ("BraveSoftware/Brave-Browser", "Brave"),
    ("Microsoft Edge", "Edge"),
    ("Vivaldi", "Vivaldi"),
    ("Arc/User Data", "Arc"),
];

pub struct Env {
    /// ~/Library/Application Support/chromefile, or CHROMEFILE_HOME.
    pub app_dir: PathBuf,
    /// ~/Library/Application Support, or CHROMEFILE_BROWSER_ROOT.
    pub browser_root: PathBuf,
    pub home: Option<PathBuf>,
    /// This binary, canonicalized: what Chrome and Claude Code run.
    pub exe: PathBuf,
    /// CHROMEFILE_CLAUDE, else `claude` from PATH.
    pub claude: Option<PathBuf>,
}

impl Env {
    pub fn pretty(&self, path: &Path) -> String {
        crate::commands::pretty_path(path, self.home.as_deref())
    }

    /// Installed browsers as (label, NativeMessagingHosts folder).
    fn browsers(&self) -> Vec<(&'static str, PathBuf)> {
        BROWSERS
            .iter()
            .map(|(dir, label)| (*label, self.browser_root.join(dir)))
            .filter(|(_, dir)| dir.is_dir())
            .map(|(label, dir)| (label, dir.join("NativeMessagingHosts")))
            .collect()
    }
}

/// Collects outcome lines and whether any step failed.
#[derive(Default)]
pub struct Report {
    pub failed: bool,
}

impl Report {
    pub fn say(&self, item: &str, outcome: &str, detail: &str) {
        println!("{item}: {outcome} ({detail})");
    }

    pub fn fail(&mut self, item: &str, e: &anyhow::Error) {
        eprintln!("{item}: failed ({e:#})");
        self.failed = true;
    }
}

/// The native messaging host manifest pointing Chrome at `exe`.
pub fn host_manifest(exe: &Path) -> String {
    let manifest = json!({
        "name": HOST_NAME,
        "description": "Chromefile native messaging host",
        "path": exe,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });
    let mut s = serde_json::to_string_pretty(&manifest).expect("JSON values serialize");
    s.push('\n');
    s
}

// Claude Code ------------------------------------------------------------------

fn claude(claude: &Path, args: &[&str]) -> Result<Output> {
    Command::new(claude)
        .args(args)
        .output()
        .with_context(|| format!("could not run {}", claude.display()))
}

fn stderr_of(out: &Output) -> String {
    let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if e.is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        e
    }
}

/// The `Command:` and `Args:` lines of `claude mcp get` output.
pub fn parse_mcp_get(stdout: &str) -> (Option<String>, Option<String>) {
    let field = |name: &str| {
        stdout
            .lines()
            .find_map(|l| l.trim_start().strip_prefix(name))
            .map(|v| v.trim().to_string())
    };
    (field("Command:"), field("Args:"))
}

#[derive(Debug, PartialEq, Eq)]
pub enum Mcp {
    Missing,
    Matches,
    /// Registered with another command, shown as "command args".
    Differs(String),
}

/// How `name` is registered in Claude Code, compared with `<exe> mcp`.
pub fn mcp_state(claude_bin: &Path, name: &str, exe: &Path) -> Result<Mcp> {
    let out = claude(claude_bin, &["mcp", "get", name])?;
    if !out.status.success() {
        return Ok(Mcp::Missing);
    }
    let (command, args) = parse_mcp_get(&String::from_utf8_lossy(&out.stdout));
    let command = command.unwrap_or_default();
    let args = args.unwrap_or_default();
    if Path::new(&command) == exe && args == "mcp" {
        Ok(Mcp::Matches)
    } else {
        Ok(Mcp::Differs(format!("{command} {args}").trim().to_string()))
    }
}

fn mcp_remove(claude_bin: &Path, name: &str) -> Result<()> {
    let out = claude(claude_bin, &["mcp", "remove", "--scope", "user", name])?;
    if !out.status.success() {
        bail!("claude mcp remove {name} failed: {}", stderr_of(&out));
    }
    Ok(())
}

/// Registers `<exe> mcp` as the chromefile MCP server at user scope, unless
/// it already is. Returns the outcome and its detail.
pub fn ensure_mcp(claude_bin: &Path, exe: &Path) -> Result<(&'static str, String)> {
    let replaced = match mcp_state(claude_bin, MCP_NAME, exe)? {
        Mcp::Matches => return Ok(("unchanged", format!("{} mcp", exe.display()))),
        Mcp::Missing => None,
        Mcp::Differs(old) => {
            mcp_remove(claude_bin, MCP_NAME)?;
            Some(old)
        }
    };
    let exe_s = exe.to_string_lossy();
    let out = claude(
        claude_bin,
        &[
            "mcp", "add", "--scope", "user", MCP_NAME, "--", &exe_s, "mcp",
        ],
    )?;
    if !out.status.success() {
        bail!("claude mcp add failed: {}", stderr_of(&out));
    }
    Ok(match replaced {
        None => ("changed", format!("registered {exe_s} mcp")),
        Some(old) => (
            "changed",
            format!("registered {exe_s} mcp, replacing {old}"),
        ),
    })
}

// install ----------------------------------------------------------------------

/// Removes what the old claude-browser-bridge installer left behind. Each
/// step only runs when there is something to remove.
fn migrate(env: &Env, r: &mut Report) {
    let old_dir = env.browser_root.join(OLD_APP_DIR);
    if fs::symlink_metadata(&old_dir).is_ok() {
        let item = "migration app folder";
        match migrate_app_dir(&old_dir, &env.app_dir) {
            Ok(copied) => {
                let keys = if copied.is_empty() {
                    String::new()
                } else {
                    format!(", after copying config.json keys {}", copied.join(", "))
                };
                r.say(
                    item,
                    "changed",
                    &format!("removed {}{keys}", env.pretty(&old_dir)),
                );
            }
            Err(e) => r.fail(item, &e),
        }
    }

    for (label, dir) in env.browsers() {
        let old = dir.join(format!("{OLD_HOST_NAME}.json"));
        if fs::symlink_metadata(&old).is_err() {
            continue;
        }
        let item = format!("migration native host {label}");
        match fs::remove_file(&old) {
            Ok(()) => r.say(&item, "changed", &format!("removed {}", env.pretty(&old))),
            Err(e) => r.fail(&item, &anyhow::Error::new(e)),
        }
    }

    if let Some(claude_bin) = &env.claude {
        let item = "migration mcp";
        let present = claude(claude_bin, &["mcp", "get", OLD_MCP_NAME]).map(|o| o.status.success());
        match present {
            Ok(false) => {}
            Ok(true) => match mcp_remove(claude_bin, OLD_MCP_NAME) {
                Ok(()) => r.say(
                    item,
                    "changed",
                    &format!("removed {OLD_MCP_NAME} from Claude Code"),
                ),
                Err(e) => r.fail(item, &e),
            },
            Err(e) => r.fail(item, &e),
        }
    }
}

/// Copies the old config.json keys into the new one (new keys win), then
/// deletes exactly the old folder. Returns the keys copied.
pub fn migrate_app_dir(old_dir: &Path, app_dir: &Path) -> Result<Vec<String>> {
    let old = host::read_config(&host::config_path(old_dir))?;
    let mut copied = Vec::new();
    if !old.is_empty() {
        let mut config = host::read_config(&host::config_path(app_dir))?;
        copied = host::merge_config(&mut config, old);
        if !copied.is_empty() {
            host::write_config(app_dir, &config)?;
        }
    }
    files::remove_dir(old_dir)
        .with_context(|| format!("could not delete {}", old_dir.display()))?;
    Ok(copied)
}

fn install_host(env: &Env, r: &mut Report) {
    let path = host::host_path(&env.app_dir);
    match host::extract(&env.app_dir) {
        Ok(true) => r.say("host", "changed", &format!("wrote {}", env.pretty(&path))),
        Ok(false) => r.say("host", "unchanged", &env.pretty(&path)),
        Err(e) => r.fail(
            "host",
            &anyhow::Error::new(e).context(format!("could not write {}", path.display())),
        ),
    }

    match record_node(env) {
        Ok((outcome, detail)) => r.say("node", outcome, &detail),
        Err(e) => r.fail("node", &e),
    }
}

/// Resolves node from PATH and records it in config.json (other keys kept).
fn record_node(env: &Env) -> Result<(&'static str, String)> {
    let Some(candidate) = host::which("node") else {
        bail!("node not found on PATH; install Node 24 or newer and run this again");
    };
    let node = host::resolve_node(&candidate)?;
    let detail = format!("{}, v{}", node.path.display(), node.version);
    let mut config = host::read_config(&host::config_path(&env.app_dir))?;
    let path = json!(node.path);
    if config.get("node") == Some(&path) {
        return Ok(("unchanged", detail));
    }
    config.insert("node".into(), path);
    host::write_config(&env.app_dir, &config)?;
    Ok(("changed", format!("recorded {detail} in config.json")))
}

fn install_manifests(env: &Env, r: &mut Report) {
    let manifest = host_manifest(&env.exe);
    let browsers = env.browsers();
    if browsers.is_empty() {
        r.fail(
            "native host",
            &anyhow::anyhow!(
                "no Chromium browser data folder in {}; start your browser once and run this again",
                env.pretty(&env.browser_root)
            ),
        );
    }
    for (label, dir) in browsers {
        let item = format!("native host {label}");
        let path = dir.join(format!("{HOST_NAME}.json"));
        if fs::read(&path).is_ok_and(|b| b == manifest.as_bytes()) {
            r.say(&item, "unchanged", &env.pretty(&path));
            continue;
        }
        match fs::create_dir_all(&dir).and_then(|_| fs::write(&path, &manifest)) {
            Ok(()) => r.say(&item, "changed", &format!("wrote {}", env.pretty(&path))),
            Err(e) => r.fail(
                &item,
                &anyhow::Error::new(e).context(format!("could not write {}", path.display())),
            ),
        }
    }
}

fn install_mcp(env: &Env, r: &mut Report) {
    let Some(claude_bin) = &env.claude else {
        println!("mcp: unsupported (claude not on PATH)");
        return;
    };
    match ensure_mcp(claude_bin, &env.exe) {
        Ok((outcome, detail)) => r.say("mcp", outcome, &detail),
        Err(e) => r.fail("mcp", &e),
    }
}

/// Install steps 1 to 4: migration, host, native host manifests, MCP.
pub fn install(env: &Env, r: &mut Report) {
    migrate(env, r);
    install_host(env, r);
    install_manifests(env, r);
    install_mcp(env, r);
}

// uninstall --------------------------------------------------------------------

pub fn uninstall(env: &Env, r: &mut Report) {
    let mut removed_any = false;
    for (label, dir) in env.browsers() {
        let path = dir.join(format!("{HOST_NAME}.json"));
        if fs::symlink_metadata(&path).is_err() {
            continue;
        }
        let item = format!("native host {label}");
        removed_any = true;
        match fs::remove_file(&path) {
            Ok(()) => r.say(&item, "changed", &format!("removed {}", env.pretty(&path))),
            Err(e) => r.fail(&item, &anyhow::Error::new(e)),
        }
    }
    if !removed_any {
        r.say("native host", "unchanged", "no manifests");
    }

    match &env.claude {
        None => println!("mcp: unsupported (claude not on PATH)"),
        Some(claude_bin) => {
            let result = mcp_state(claude_bin, MCP_NAME, &env.exe).and_then(|state| {
                if state == Mcp::Missing {
                    return Ok(("unchanged", "not registered".to_string()));
                }
                mcp_remove(claude_bin, MCP_NAME)?;
                Ok(("changed", format!("removed {MCP_NAME} from Claude Code")))
            });
            match result {
                Ok((outcome, detail)) => r.say("mcp", outcome, &detail),
                Err(e) => r.fail("mcp", &e),
            }
        }
    }

    let host_dir = env.app_dir.join("host");
    match files::remove_dir(&host_dir) {
        Ok(true) => r.say(
            "host",
            "changed",
            &format!("deleted {}", env.pretty(&host_dir)),
        ),
        Ok(false) => r.say(
            "host",
            "unchanged",
            &format!("{} does not exist", env.pretty(&host_dir)),
        ),
        Err(e) => r.fail("host", &anyhow::Error::new(e)),
    }
    println!(
        "note: kept {} and {} (delete them by hand if you want)",
        env.pretty(&host::config_path(&env.app_dir)),
        env.pretty(&env.app_dir.join("sessions"))
    );
}

// status -----------------------------------------------------------------------

/// Prints the state of each piece; returns whether all are in place.
pub fn status(env: &Env) -> bool {
    let mut ok = true;
    let path = host::host_path(&env.app_dir);
    if host::host_matches(&env.app_dir) {
        println!("host: matches ({})", env.pretty(&path));
    } else if path.exists() {
        println!(
            "host: differs ({} is not the embedded copy)",
            env.pretty(&path)
        );
        ok = false;
    } else {
        println!("host: missing ({})", env.pretty(&path));
        ok = false;
    }

    match host::read_config(&host::config_path(&env.app_dir)) {
        Ok(config) => match config.get("node").and_then(|v| v.as_str()) {
            Some(n) if Path::new(n).is_file() => println!("node: {n}"),
            Some(n) => {
                println!("node: missing ({n} no longer exists; run chromefile install)");
                ok = false;
            }
            None => {
                println!("node: not recorded");
                ok = false;
            }
        },
        Err(e) => {
            println!("node: unknown ({e:#})");
            ok = false;
        }
    }

    let manifest = host_manifest(&env.exe);
    let browsers = env.browsers();
    if browsers.is_empty() {
        println!("native host: no Chromium browser found");
        ok = false;
    }
    for (label, dir) in browsers {
        let path = dir.join(format!("{HOST_NAME}.json"));
        let state = match fs::read(&path) {
            Ok(b) if b == manifest.as_bytes() => "registered",
            Ok(_) => {
                ok = false;
                "differs"
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                ok = false;
                "not registered"
            }
            Err(_) => {
                ok = false;
                "unreadable"
            }
        };
        println!("native host {label}: {state} ({})", env.pretty(&path));
    }

    match &env.claude {
        None => println!("mcp: unsupported (claude not on PATH)"),
        Some(claude_bin) => match mcp_state(claude_bin, MCP_NAME, &env.exe) {
            Ok(Mcp::Matches) => println!("mcp: registered ({} mcp)", env.exe.display()),
            Ok(Mcp::Differs(other)) => {
                println!("mcp: differs (runs {other})");
                ok = false;
            }
            Ok(Mcp::Missing) => {
                println!("mcp: not registered");
                ok = false;
            }
            Err(e) => {
                println!("mcp: unknown ({e:#})");
                ok = false;
            }
        },
    }

    let old_dir = env.browser_root.join(OLD_APP_DIR);
    if fs::symlink_metadata(&old_dir).is_ok() {
        println!(
            "migration: pending ({} still exists; run chromefile install)",
            env.pretty(&old_dir)
        );
        ok = false;
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("chromefile-setup-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A stand-in for `claude` that logs its arguments and keeps one file per
    /// registered server, printing them the way `claude mcp get` does.
    fn stub_claude(dir: &Path) -> PathBuf {
        let state = dir.join("state");
        fs::create_dir_all(&state).unwrap();
        let path = dir.join("claude");
        fs::write(
            &path,
            format!(
                r#"#!/bin/sh
echo "$*" >> '{log}'
state='{state}'
case "$1 $2" in
  "mcp get")
    [ -f "$state/$3" ] || {{ echo "No MCP server named \"$3\"" >&2; exit 1; }}
    cat "$state/$3" ;;
  "mcp remove")
    [ -f "$state/$5" ] || {{ echo "No user-scoped MCP server named $5" >&2; exit 1; }}
    rm "$state/$5" ;;
  "mcp add")
    name="$5"; shift 6; cmd="$1"; shift
    printf '%s:\n  Scope: User config\n  Type: stdio\n  Command: %s\n  Args: %s\n  Environment:\n' "$name" "$cmd" "$*" > "$state/$name" ;;
esac
"#,
                log = dir.join("log").display(),
                state = state.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    fn log(dir: &Path) -> Vec<String> {
        let log = fs::read_to_string(dir.join("log")).unwrap_or_default();
        let lines = log.lines().map(str::to_string).collect();
        let _ = fs::remove_file(dir.join("log"));
        lines
    }

    #[test]
    fn host_manifest_allows_only_the_extension() {
        let m: serde_json::Value =
            serde_json::from_str(&host_manifest(Path::new("/opt/bin/chromefile"))).unwrap();
        assert_eq!(
            m,
            json!({
                "name": "io.whirlwin.chromefile",
                "description": "Chromefile native messaging host",
                "path": "/opt/bin/chromefile",
                "type": "stdio",
                "allowed_origins": ["chrome-extension://cbapdndkoijjfggigdfalnjgjopdebid/"],
            })
        );
        assert!(host_manifest(Path::new("/x")).ends_with("}\n"));
    }

    #[test]
    fn parses_claude_mcp_get() {
        let out = "chromefile:\n  Scope: User config (available in all your projects)\n  \
                   Status: ✓ Connected\n  Type: stdio\n  Command: /a b/chromefile\n  Args: mcp\n  \
                   Environment:\n\nTo remove this server, run: claude mcp remove chromefile -s user\n";
        assert_eq!(
            parse_mcp_get(out),
            (Some("/a b/chromefile".into()), Some("mcp".into()))
        );
        assert_eq!(parse_mcp_get(""), (None, None));
    }

    #[test]
    fn adds_keeps_and_replaces_the_mcp_registration() {
        let dir = temp_dir("mcp");
        let claude = stub_claude(&dir);
        let exe = Path::new("/opt/bin/chromefile");

        assert_eq!(mcp_state(&claude, MCP_NAME, exe).unwrap(), Mcp::Missing);
        let _ = log(&dir);
        assert_eq!(ensure_mcp(&claude, exe).unwrap().0, "changed");
        assert_eq!(
            log(&dir),
            vec![
                "mcp get chromefile",
                "mcp add --scope user chromefile -- /opt/bin/chromefile mcp"
            ]
        );

        assert_eq!(ensure_mcp(&claude, exe).unwrap().0, "unchanged");
        assert_eq!(log(&dir), vec!["mcp get chromefile"]);

        let moved = Path::new("/new/bin/chromefile");
        let (outcome, detail) = ensure_mcp(&claude, moved).unwrap();
        assert_eq!(outcome, "changed");
        assert!(
            detail.contains("replacing /opt/bin/chromefile mcp"),
            "{detail}"
        );
        assert_eq!(
            log(&dir),
            vec![
                "mcp get chromefile",
                "mcp remove --scope user chromefile",
                "mcp add --scope user chromefile -- /new/bin/chromefile mcp"
            ]
        );
        assert_eq!(mcp_state(&claude, MCP_NAME, moved).unwrap(), Mcp::Matches);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn migrates_the_old_app_folder() {
        let dir = temp_dir("migrate");
        let old = dir.join("claude-browser-bridge");
        let app = dir.join("chromefile");
        fs::create_dir_all(old.join("sessions")).unwrap();
        fs::write(
            old.join("config.json"),
            r#"{"claude":{"cwd":"/old"},"theme":"dark"}"#,
        )
        .unwrap();
        host::write_config(
            &app,
            json!({ "claude": { "cwd": "/new" } }).as_object().unwrap(),
        )
        .unwrap();

        assert_eq!(migrate_app_dir(&old, &app).unwrap(), vec!["theme"]);
        assert!(!old.exists());
        assert_eq!(
            serde_json::Value::Object(host::read_config(&host::config_path(&app)).unwrap()),
            json!({ "claude": { "cwd": "/new" }, "theme": "dark" })
        );

        // An unreadable old config stops the migration before anything is deleted.
        fs::create_dir_all(&old).unwrap();
        fs::write(old.join("config.json"), "not json").unwrap();
        assert!(migrate_app_dir(&old, &app).is_err());
        assert!(old.exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
