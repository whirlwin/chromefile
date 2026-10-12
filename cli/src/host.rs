//! The Node host (native messaging host, MCP server and `call`), embedded at
//! build time from `host/chromefile-host.js` (see `scripts/vendor.sh`). The
//! binary extracts it to the app folder and runs it with node, so Chrome,
//! Claude Code and scripts only ever need to know the chromefile binary.

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Map, Value};
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

pub static HOST_JS: &[u8] = include_bytes!("../host/chromefile-host.js");

const MIN_NODE_MAJOR: u32 = 24;

/// Where the host file is extracted to.
pub fn host_path(app_dir: &Path) -> PathBuf {
    app_dir.join("host").join("chromefile-host.js")
}

/// Whether Chrome started this binary as a native messaging host: it passes
/// the calling extension's origin as the first argument.
pub fn is_host_invocation(first_arg: Option<&OsStr>) -> bool {
    first_arg
        .and_then(OsStr::to_str)
        .is_some_and(|a| a.starts_with("chrome-extension://"))
}

/// Creates the app folder, private to the user.
pub fn ensure_app_dir(app_dir: &Path) -> io::Result<()> {
    fs::create_dir_all(app_dir)?;
    fs::set_permissions(app_dir, fs::Permissions::from_mode(0o700))
}

/// Writes `bytes` to `path` through a temporary file and a rename, so a
/// reader (a second host Chrome starts, say) never sees half a file.
fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("no parent folder"))?;
    fs::create_dir_all(parent)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = parent.join(format!(".{name}.{}", std::process::id()));
    let result = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(&tmp)
        .and_then(|mut f| f.write_all(bytes))
        .and_then(|_| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// Extracts the embedded host file unless it is already there with the same
/// bytes. Returns whether it wrote anything.
pub fn extract(app_dir: &Path) -> io::Result<bool> {
    let path = host_path(app_dir);
    if fs::read(&path).is_ok_and(|b| b == HOST_JS) {
        return Ok(false);
    }
    ensure_app_dir(app_dir)?;
    write_atomic(&path, HOST_JS, 0o644)?;
    Ok(true)
}

pub fn host_matches(app_dir: &Path) -> bool {
    fs::read(host_path(app_dir)).is_ok_and(|b| b == HOST_JS)
}

pub fn config_path(app_dir: &Path) -> PathBuf {
    app_dir.join("config.json")
}

/// Reads a config.json; a missing file is an empty object.
pub fn read_config(path: &Path) -> Result<Map<String, Value>> {
    let raw = match fs::read(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(e).with_context(|| format!("could not read {}", path.display())),
    };
    match serde_json::from_slice(&raw) {
        Ok(Value::Object(map)) => Ok(map),
        _ => bail!("{} is not a JSON object; fix or remove it", path.display()),
    }
}

/// Writes config.json (mode 0600), creating the app folder if needed.
pub fn write_config(app_dir: &Path, config: &Map<String, Value>) -> Result<()> {
    ensure_app_dir(app_dir)?;
    let mut bytes = serde_json::to_vec_pretty(config)?;
    bytes.push(b'\n');
    let path = config_path(app_dir);
    write_atomic(&path, &bytes, 0o600)
        .with_context(|| format!("could not write {}", path.display()))
}

/// Copies keys from an old config into a new one; keys the new one already
/// has win. Returns the keys copied, sorted.
pub fn merge_config(new: &mut Map<String, Value>, old: Map<String, Value>) -> Vec<String> {
    let mut copied = Vec::new();
    for (k, v) in old {
        if !new.contains_key(&k) {
            new.insert(k.clone(), v);
            copied.push(k);
        }
    }
    copied.sort();
    copied
}

/// Finds an executable on PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|p| fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0))
}

#[derive(Debug, PartialEq, Eq)]
pub struct Node {
    pub path: PathBuf,
    pub version: String,
}

/// Resolves `candidate` (usually `node` from PATH) to the real node binary
/// and checks its version. Chrome starts native hosts without the shell's
/// PATH, and a mise or asdf shim (or any other wrapper) only works from a
/// shell, so the absolute path of the executable that actually runs is
/// recorded: node reports it as process.execPath.
pub fn resolve_node(candidate: &Path) -> Result<Node> {
    let out = Command::new(candidate)
        .arg("-e")
        .arg(r#"process.stdout.write(process.execPath + "\n" + process.versions.node)"#)
        .output()
        .with_context(|| format!("could not run {}", candidate.display()))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut lines = stdout.lines();
    let (Some(path), Some(version), true) = (lines.next(), lines.next(), out.status.success())
    else {
        bail!(
            "{} did not report its path and version: {}",
            candidate.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    };
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() || !path.is_file() {
        bail!(
            "{} reported {} as its executable, which is not a file",
            candidate.display(),
            path.display()
        );
    }
    let version = version.trim().to_string();
    let major: u32 = version
        .split('.')
        .next()
        .and_then(|m| m.parse().ok())
        .ok_or_else(|| anyhow!("unexpected node version {version}"))?;
    if major < MIN_NODE_MAJOR {
        bail!(
            "{} is Node {version}; Node {MIN_NODE_MAJOR} or newer is required",
            path.display()
        );
    }
    Ok(Node { path, version })
}

/// The node to run the host with: CHROMEFILE_NODE, else the one recorded
/// in config.json at install, else `node` from PATH.
pub fn node_for_run(env_node: Option<OsString>, config: &Map<String, Value>) -> PathBuf {
    if let Some(n) = env_node.filter(|n| !n.is_empty()) {
        return PathBuf::from(n);
    }
    match config.get("node").and_then(Value::as_str) {
        Some(n) if !n.is_empty() => PathBuf::from(n),
        _ => PathBuf::from("node"),
    }
}

/// Replaces this process with `node <host file> <mode> <args...>`, so stdio,
/// signals and the exit status are node's. Extracts the host file first if
/// it is missing or stale. Only returns on failure. Writes nothing to
/// stdout: in every mode it is a protocol channel.
pub fn exec(app_dir: &Path, mode: &str, args: &[OsString]) -> anyhow::Error {
    if let Err(e) = extract(app_dir) {
        return anyhow!(e).context(format!(
            "could not extract the host to {}",
            host_path(app_dir).display()
        ));
    }
    let config = read_config(&config_path(app_dir)).unwrap_or_default();
    let node = node_for_run(std::env::var_os("CHROMEFILE_NODE"), &config);
    let err = Command::new(&node)
        .arg(host_path(app_dir))
        .arg(mode)
        .args(args)
        .exec();
    anyhow!(err).context(format!(
        "could not run node ({}); install Node {MIN_NODE_MAJOR} or newer and run chromefile \
         install again, or set CHROMEFILE_NODE",
        node.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("chromefile-host-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn script(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn detects_chrome_starting_a_native_host() {
        let yes = OsString::from("chrome-extension://cbapdndkoijjfggigdfalnjgjopdebid/");
        assert!(is_host_invocation(Some(&yes)));
        for no in [
            "install",
            "mcp",
            "chrome-extension:",
            "--parent-window=0",
            "",
        ] {
            assert!(!is_host_invocation(Some(OsStr::new(no))), "{no}");
        }
        assert!(!is_host_invocation(None));
    }

    #[test]
    fn resolves_a_shim_to_the_real_node() {
        let dir = temp_dir("shim");
        let real = dir.join("installs/node/24.3.0/bin/node");
        script(&real, "exit 0");
        let shim = dir.join("shims/node");
        script(
            &shim,
            &format!("printf '%s\\n%s' '{}' '24.3.0'", real.display()),
        );
        assert_eq!(
            resolve_node(&shim).unwrap(),
            Node {
                path: real,
                version: "24.3.0".into()
            }
        );

        let old = dir.join("old/node");
        script(
            &old,
            &format!("printf '%s\\n%s' '{}' '22.11.0'", old.display()),
        );
        let e = resolve_node(&old).unwrap_err().to_string();
        assert!(e.contains("Node 24 or newer"), "{e}");

        let broken = dir.join("broken/node");
        script(&broken, "echo nope >&2; exit 1");
        assert!(resolve_node(&broken).is_err());

        let missing = dir.join("bad/node");
        script(&missing, "printf '/nonexistent/node\\n24.0.0'");
        assert!(resolve_node(&missing).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn picks_the_node_to_run() {
        let config = json!({ "node": "/opt/node/bin/node" });
        let config = config.as_object().unwrap();
        assert_eq!(
            node_for_run(Some("/env/node".into()), config),
            PathBuf::from("/env/node")
        );
        assert_eq!(
            node_for_run(None, config),
            PathBuf::from("/opt/node/bin/node")
        );
        assert_eq!(
            node_for_run(Some("".into()), &Map::new()),
            PathBuf::from("node")
        );
    }

    #[test]
    fn merges_old_config_keys_without_overwriting() {
        let mut new = json!({ "claude": { "cwd": "/new" }, "node": "/n" })
            .as_object()
            .unwrap()
            .clone();
        let old = json!({ "claude": { "cwd": "/old" }, "extra": 1, "more": [true] })
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(merge_config(&mut new, old), vec!["extra", "more"]);
        assert_eq!(
            Value::Object(new),
            json!({ "claude": { "cwd": "/new" }, "node": "/n", "extra": 1, "more": [true] })
        );
    }

    #[test]
    fn extracts_the_host_once_and_writes_private_config() {
        let dir = temp_dir("extract");
        let app = dir.join("app");
        assert!(extract(&app).unwrap());
        assert!(host_matches(&app));
        assert!(!extract(&app).unwrap());
        fs::write(host_path(&app), "stale").unwrap();
        assert!(!host_matches(&app));
        assert!(extract(&app).unwrap());
        assert_eq!(
            fs::metadata(&app).unwrap().permissions().mode() & 0o777,
            0o700
        );

        let mut config = read_config(&config_path(&app)).unwrap();
        assert!(config.is_empty());
        config.insert("node".into(), json!("/n"));
        write_config(&app, &config).unwrap();
        assert_eq!(read_config(&config_path(&app)).unwrap(), config);
        let mode = fs::metadata(config_path(&app))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        fs::write(config_path(&app), "[1]").unwrap();
        assert!(read_config(&config_path(&app)).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
