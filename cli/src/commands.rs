//! The install, status and uninstall commands.

use crate::chrome::{CallResult, Chrome, Tab, instances, is_running, pause};
use crate::{embedded, files};
use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

// Functions run on chrome://extensions as func(D, done); see chrome::build_call_js.
const GET_PROFILE: &str =
    "function(D,done){chrome.developerPrivate.getProfileConfiguration(done);}";
const DEV_MODE_ON: &str = "function(D,done){chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true},function(){done(true);});}";
// Only the fields we use, to keep the reply small.
const GET_INFO: &str = "function(D,done){chrome.developerPrivate.getExtensionInfo(D.id,function(e){done(e&&{version:e.version,path:e.path,state:e.state,location:e.location,userScriptsAccess:e.userScriptsAccess});});}";
const RELOAD: &str = "function(D,done){chrome.developerPrivate.reload(D.id,{failQuietly:true,populateErrorForUnpacked:true},function(r){done(r===undefined?null:r);});}";
const ALLOW_USER_SCRIPTS: &str = "function(D,done){chrome.developerPrivate.updateExtensionConfiguration({extensionId:D.id,userScriptsAccess:true},function(){done(true);});}";
const ENABLE: &str =
    "function(D,done){chrome.management.setEnabled(D.id,true,function(){done(true);});}";
const LOAD_UNPACKED: &str = "function(D,done){chrome.developerPrivate.loadUnpacked({failQuietly:true,populateError:true},function(r){done(r===undefined?null:r);});}";
// chrome.management.uninstall needs a user gesture, which AppleScript can't
// give; this one asks for confirmation in a dialog instead.
const REMOVE: &str = "function(D,done){chrome.developerPrivate.removeMultipleExtensions([D.id],function(){done(true);});}";

// The loadUnpacked result lands in its own variable, so polling other calls
// meanwhile doesn't overwrite it.
const LOAD_VAR: &str = "__cfLoad";

pub struct Config {
    /// The browser's application (and process) name.
    pub app: String,
    /// Where the extension files live; Chrome loads them from here.
    pub stable_dir: PathBuf,
    /// Where chromefile kept the extension before it was renamed; deleted
    /// once Chrome loads the extension from `stable_dir`.
    pub legacy_dir: PathBuf,
    pub home: Option<PathBuf>,
}

impl Config {
    fn item(&self) -> String {
        "extension".to_string()
    }

    fn pretty(&self, path: &Path) -> String {
        pretty_path(path, self.home.as_deref())
    }
}

pub fn pretty_path(path: &Path, home: Option<&Path>) -> String {
    match home.and_then(|h| path.strip_prefix(h).ok()) {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}

fn say(item: &str, outcome: &str, detail: &str) {
    println!("{item}: {outcome} ({detail})");
}

/// The extension as getExtensionInfo reports it.
#[derive(Debug, Clone)]
pub struct Installed {
    pub version: String,
    pub path: String,
    pub state: String,
    pub user_scripts_active: bool,
}

impl Installed {
    fn from_value(v: &Value) -> Self {
        let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        Installed {
            version: s("version"),
            path: s("path"),
            state: s("state"),
            user_scripts_active: v["userScriptsAccess"]["isActive"]
                .as_bool()
                .unwrap_or(false),
        }
    }
}

/// What install has to do about the extension itself.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    Unchanged,
    Reload,
    Load {
        replacing: Option<String>,
    },
    /// Loaded from another folder, and replacing it was not asked for.
    Conflict {
        other: String,
    },
}

pub fn decide(
    installed: Option<&Installed>,
    stable_dir: &Path,
    embedded_version: &str,
    files_changed: bool,
    replace: bool,
) -> Plan {
    match installed {
        None => Plan::Load { replacing: None },
        Some(i) if !same_path(&i.path, stable_dir) && !replace => Plan::Conflict {
            other: i.path.clone(),
        },
        Some(i) if !same_path(&i.path, stable_dir) => Plan::Load {
            replacing: Some(i.path.clone()),
        },
        Some(i) if files_changed || i.version != embedded_version => Plan::Reload,
        Some(_) => Plan::Unchanged,
    }
}

/// Compares Chrome's path with ours, resolving symlinks such as /tmp to
/// /private/tmp where both exist.
fn same_path(chrome_path: &str, ours: &Path) -> bool {
    let norm = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let theirs = Path::new(chrome_path.trim_end_matches('/'));
    !chrome_path.is_empty() && norm(theirs) == norm(ours)
}

/// Checks that exactly one instance of `app` runs, with a window, and starts
/// a session with it.
pub fn preflight(app: &str) -> Result<Chrome> {
    if !is_running(app)? {
        bail!("{app} is not running; start it first");
    }
    // With two instances (say the user's Chrome and an automation one with
    // its own --user-data-dir), AppleScript silently picks one of them.
    let running = instances(app)?;
    if running.len() > 1 {
        let list: Vec<String> = running
            .iter()
            .map(|i| match &i.user_data_dir {
                Some(d) => format!("{} (--user-data-dir={d})", i.pid),
                None => i.pid.to_string(),
            })
            .collect();
        bail!(
            "{} instances of {} are running (pids {}); quit the extra ones (for example a \
             Playwright or automation instance with --user-data-dir) and retry",
            running.len(),
            app,
            list.join(", ")
        );
    }
    let chrome = Chrome::new(app)?;
    if chrome.window_count()? == 0 {
        bail!("{app} has no open window; open one first");
    }
    Ok(chrome)
}

fn expect_ok(r: CallResult, what: &str) -> Result<Value> {
    r.map_err(|e| anyhow!("Chrome refused to {what}: {e}"))
}

fn get_info(chrome: &Chrome, tab: &Tab, id: &str) -> Result<Option<Installed>> {
    match chrome.call(tab, &json!({ "id": id }), GET_INFO)? {
        Ok(v) if v.is_object() => Ok(Some(Installed::from_value(&v))),
        Ok(_) => Ok(None),
        Err(e) if e.contains("No such extension") => Ok(None),
        Err(e) => bail!("Chrome refused to look up the extension: {e}"),
    }
}

/// A loadUnpacked or reload reply carries a LoadError object when the
/// manifest or files are bad.
fn load_error(v: &Value) -> Option<String> {
    v.get("error")
        .and_then(Value::as_str)
        .map(|e| match v["path"].as_str() {
            Some(p) => format!("{e} ({p})"),
            None => e.to_string(),
        })
}

pub fn install(config: &Config, replace: bool) -> Result<()> {
    let manifest = embedded::manifest()?;
    let item = config.item();
    let mut chrome = preflight(&config.app)?;

    let embedded_files = embedded::files();
    let files_changed = files::sync_dir(&config.stable_dir, &embedded_files)
        .with_context(|| format!("could not write {}", config.stable_dir.display()))?;
    let stable = config.pretty(&config.stable_dir);

    let tab = &chrome.open_extensions_tab()?;

    let profile = expect_ok(
        chrome.call(tab, &json!({}), GET_PROFILE)?,
        "report developer mode",
    )?;
    if profile["inDeveloperMode"].as_bool() == Some(true) {
        say("developer mode", "unchanged", "on");
    } else if profile["isDeveloperModeControlledByPolicy"].as_bool() == Some(true) {
        bail!(
            "developer mode is off and controlled by policy, so unpacked extensions can't be loaded"
        );
    } else {
        expect_ok(
            chrome.call(tab, &json!({}), DEV_MODE_ON)?,
            "turn on developer mode",
        )?;
        say("developer mode", "changed", "turned on");
    }

    let id = manifest.id.as_str();
    let before = get_info(&chrome, tab, id)?;
    match decide(
        before.as_ref(),
        &config.stable_dir,
        &manifest.version,
        files_changed,
        replace,
    ) {
        Plan::Conflict { other } => bail!(
            "the extension is already loaded from {}. Chrome can't load it from a second folder, \
             so that copy would have to be removed first, and its registered user scripts (mods) \
             and storage with it. Back up your mods, then run chromefile install --replace",
            config.pretty(Path::new(&other))
        ),
        Plan::Unchanged => say(
            &item,
            "unchanged",
            &format!("{} from {stable}", manifest.version),
        ),
        Plan::Reload => {
            let r = expect_ok(
                chrome.call(tab, &json!({ "id": id }), RELOAD)?,
                "reload the extension",
            )?;
            if let Some(e) = load_error(&r) {
                bail!("Chrome could not reload the extension: {e}");
            }
            wait_for(&chrome, tab, id, |i| {
                same_path(&i.path, &config.stable_dir) && i.version == manifest.version
            })?;
            say(
                &item,
                "changed",
                &format!("reloaded {} from {stable}", manifest.version),
            );
        }
        Plan::Load { replacing } => {
            if profile["canLoadUnpacked"].as_bool() == Some(false) {
                bail!("Chrome does not allow loading unpacked extensions in this profile");
            }
            // Chrome quietly ignores loading an ID it already has from another
            // folder, so the other copy has to go first.
            if let Some(old) = &replacing {
                remove(&chrome, tab, id, &config.app)?;
                say(
                    &item,
                    "changed",
                    &format!(
                        "removed the copy loaded from {}, with its user scripts (mods) and storage",
                        config.pretty(Path::new(old))
                    ),
                );
            }
            load_via_picker(&mut chrome, tab, id, config)?;
            say(
                &item,
                "changed",
                &format!("installed {} from {stable}", manifest.version),
            );
        }
    }

    let info = wait_for(&chrome, tab, id, |_| true)?;
    if info.user_scripts_active {
        say("user scripts", "unchanged", "allowed");
    } else {
        expect_ok(
            chrome.call(tab, &json!({ "id": id }), ALLOW_USER_SCRIPTS)?,
            "allow user scripts",
        )?;
        wait_for(&chrome, tab, id, |i| i.user_scripts_active)
            .context("Chrome did not turn on Allow User Scripts")?;
        say("user scripts", "changed", "allowed");
    }

    let mut info = wait_for(&chrome, tab, id, |_| true)?;
    if info.state == "DISABLED" {
        expect_ok(
            chrome.call(tab, &json!({ "id": id }), ENABLE)?,
            "enable the extension",
        )?;
        info = wait_for(&chrome, tab, id, |i| i.state == "ENABLED")?;
    }
    if info.state != "ENABLED"
        || !same_path(&info.path, &config.stable_dir)
        || info.version != manifest.version
    {
        bail!(
            "after install Chrome reports version {} in state {} from {}",
            info.version,
            info.state,
            info.path
        );
    }
    remove_legacy_dir(config)
}

/// Deletes the folder an older chromefile loaded the extension from. Only
/// called once Chrome no longer loads it from there.
fn remove_legacy_dir(config: &Config) -> Result<()> {
    if files::remove_dir(&config.legacy_dir)
        .with_context(|| format!("could not delete {}", config.legacy_dir.display()))?
    {
        say(
            "extension files",
            "changed",
            &format!(
                "removed the old folder {}",
                config.pretty(&config.legacy_dir)
            ),
        );
    }
    Ok(())
}

/// Polls getExtensionInfo (up to ~5 s) until `ok` holds. Chrome settles a
/// moment after a reload or load.
fn wait_for(
    chrome: &Chrome,
    tab: &Tab,
    id: &str,
    ok: impl Fn(&Installed) -> bool,
) -> Result<Installed> {
    let mut last = None;
    for _ in 0..25 {
        if let Some(i) = get_info(chrome, tab, id)? {
            if ok(&i) {
                return Ok(i);
            }
            last = Some(i);
        }
        pause(200)?;
    }
    match last {
        Some(i) => bail!(
            "Chrome reports version {} in state {} from {}",
            i.version,
            i.state,
            i.path
        ),
        None => bail!("Chrome does not report the extension as installed"),
    }
}

/// Loads the stable dir with Chrome's "Load unpacked" folder picker, typing
/// the path into it. If that can't be automated, leaves the picker and the
/// chrome://extensions tab open and tells the user how to finish.
fn load_via_picker(chrome: &mut Chrome, tab: &Tab, id: &str, config: &Config) -> Result<()> {
    let folder = config.stable_dir.to_string_lossy().into_owned();
    // A picker left over from an earlier attempt outlives its tab, and the
    // keystrokes below would go to it, so insist on a clean slate. If System
    // Events is not allowed, the picker step reports that below.
    if chrome.open_dialogs().unwrap_or(0) > 0 {
        bail!(
            "{} already has a dialog or folder picker open; close it and run this again",
            config.app
        );
    }
    chrome.start(tab, LOAD_VAR, &json!({}), LOAD_UNPACKED)?;

    let problem = match chrome.drive_picker(&folder) {
        Ok(s) if s == "ok" => None,
        Ok(s) if s == "no-panel" => Some("the folder picker did not appear".to_string()),
        Ok(s) if s == "lost-focus" => {
            Some(format!("{} lost focus while typing the path", config.app))
        }
        Ok(s) if s == "no-go-to-folder" => {
            Some("the picker did not open Go to Folder (Cmd+Shift+G)".to_string())
        }
        Ok(s) if s == "typed-wrong" => Some(
            "the typed path came out different (keyboard layout?), so it was not confirmed"
                .to_string(),
        ),
        Ok(s) => Some(format!("unexpected picker result {s}")),
        Err(e) => Some(format!("{e:#}")),
    };
    let problem = problem.or_else(
        || match chrome.wait(tab, LOAD_VAR, Duration::from_secs(15)) {
            Ok(Some(Ok(v))) => {
                load_error(&v).map(|e| format!("Chrome could not load the folder: {e}"))
            }
            Ok(Some(Err(e))) => Some(format!("Chrome reported: {e}")),
            Ok(None) => Some("timed out waiting for Chrome to load the folder".to_string()),
            Err(e) => Some(format!("{e:#}")),
        },
    );
    let problem = problem.or_else(|| {
        wait_for(chrome, tab, id, |i| same_path(&i.path, &config.stable_dir))
            .err()
            .map(|e| format!("{e:#}"))
    });

    let Some(problem) = problem else {
        return Ok(());
    };
    chrome.keep_tab(tab);
    let copied = copy_to_clipboard(&folder).is_ok();
    bail!(
        "could not load the extension automatically: {problem}\n\
         Finish it by hand:\n  \
         1. In the open folder picker, or in the chrome://extensions tab with Load unpacked, press Cmd+Shift+G.\n  \
         2. {} {folder}\n  \
         3. Press Return, then click Select.\n\
         Then run chromefile install again to finish the setup.",
        if copied {
            "Paste the path (it is on the clipboard):"
        } else {
            "Type the path:"
        }
    )
}

fn copy_to_clipboard(text: &str) -> Result<()> {
    let mut child = Command::new("pbcopy").stdin(Stdio::piped()).spawn()?;
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(text.as_bytes())?;
    if !child.wait()?.success() {
        bail!("pbcopy failed");
    }
    Ok(())
}

/// Prints the state and returns whether the extension is installed and
/// matches the embedded copy.
pub fn status(config: &Config) -> Result<bool> {
    let manifest = embedded::manifest()?;
    let item = config.item();
    let mut chrome = preflight(&config.app)?;
    let tab = &chrome.open_extensions_tab()?;
    let profile = expect_ok(
        chrome.call(tab, &json!({}), GET_PROFILE)?,
        "report developer mode",
    )?;
    let info = get_info(&chrome, tab, &manifest.id)?;
    drop(chrome);

    let stable = config.pretty(&config.stable_dir);
    let files_match = files::matches(&config.stable_dir, &embedded::files());
    let ok = match &info {
        None => {
            println!("{item}: not installed");
            false
        }
        Some(i) => {
            println!(
                "{item}: installed (version {}, {}, from {})",
                i.version,
                i.state.to_lowercase(),
                config.pretty(Path::new(&i.path))
            );
            let mut diffs = Vec::new();
            if !same_path(&i.path, &config.stable_dir) {
                diffs.push(format!("loaded from another folder, not {stable}"));
            }
            if i.version != manifest.version {
                diffs.push(format!(
                    "version {} is not the embedded {}",
                    i.version, manifest.version
                ));
            }
            if !files_match {
                diffs.push(format!("files in {stable} differ from the embedded copy"));
            }
            if i.state != "ENABLED" {
                diffs.push("not enabled".to_string());
            }
            if diffs.is_empty() {
                println!(
                    "embedded copy: matches (version {}, {stable})",
                    manifest.version
                );
            } else {
                println!(
                    "embedded copy: differs ({}); run chromefile install",
                    diffs.join("; ")
                );
            }
            println!(
                "user scripts: {}",
                if i.user_scripts_active {
                    "allowed"
                } else {
                    "not allowed"
                }
            );
            diffs.is_empty() && i.user_scripts_active
        }
    };
    let dev = match profile["inDeveloperMode"].as_bool() {
        Some(true) => "on",
        _ => "off",
    };
    let policy = if profile["isDeveloperModeControlledByPolicy"].as_bool() == Some(true) {
        ", controlled by policy"
    } else {
        ""
    };
    println!("developer mode: {dev}{policy}");
    Ok(ok)
}

pub fn uninstall(config: &Config) -> Result<()> {
    let manifest = embedded::manifest()?;
    let item = config.item();
    let id = manifest.id.as_str();
    let mut chrome = preflight(&config.app)?;
    let tab = &chrome.open_extensions_tab()?;

    match get_info(&chrome, tab, id)? {
        None => say(&item, "unchanged", "not installed"),
        Some(before) => {
            remove(&chrome, tab, id, &config.app)?;
            say(
                &item,
                "changed",
                &format!(
                    "removed {} that was loaded from {}",
                    before.version,
                    config.pretty(Path::new(&before.path))
                ),
            );
            println!(
                "note: Chrome removed the extension's registered user scripts (mods) and its storage with it"
            );
        }
    }
    drop(chrome);

    let stable = config.pretty(&config.stable_dir);
    if files::remove_dir(&config.stable_dir)
        .with_context(|| format!("could not delete {}", config.stable_dir.display()))?
    {
        say("extension files", "changed", &format!("deleted {stable}"));
    } else {
        say(
            "extension files",
            "unchanged",
            &format!("{stable} does not exist"),
        );
    }
    remove_legacy_dir(config)
}

/// Removes the extension. Chrome asks for confirmation, and cancels the
/// dialog as soon as it loses focus, so the helper tab is brought to the
/// front and the dialog accepted with System Events.
fn remove(chrome: &Chrome, tab: &Tab, id: &str, app: &str) -> Result<()> {
    const VAR: &str = "__cf";
    // The Return below goes to the first dialog-like window, which must not
    // be a picker left over from an earlier attempt.
    if chrome.open_dialogs().unwrap_or(0) > 0 {
        bail!("{app} already has a dialog or folder picker open; close it and run this again");
    }
    let previous = chrome.activate_tab(tab)?;
    chrome.start(tab, VAR, &json!({ "id": id }), REMOVE)?;
    let confirmed = chrome.confirm_dialog();
    let waiting = match &confirmed {
        Ok(s) if s == "ok" => Duration::from_secs(10),
        other => {
            let why = match other {
                Ok(s) => s.clone(),
                Err(e) => format!("{e:#}"),
            };
            eprintln!(
                "could not confirm the removal automatically ({why}); click Remove in {app}'s dialog"
            );
            Duration::from_secs(60)
        }
    };
    let result = chrome.wait(tab, VAR, waiting)?;
    let _ = chrome.restore_active(tab, &previous);
    match result {
        Some(Ok(_)) => {}
        Some(Err(e)) => bail!(
            "Chrome did not remove the extension: {e}. Chrome cancels the confirmation when it \
             loses focus; run this again and keep {app} in front"
        ),
        None => bail!("timed out waiting for the removal to be confirmed"),
    }
    for _ in 0..25 {
        if get_info(chrome, tab, id)?.is_none() {
            return Ok(());
        }
        pause(200)?;
    }
    bail!("Chrome still reports the extension as installed")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed(version: &str, path: &str) -> Installed {
        Installed::from_value(&json!({
            "version": version,
            "path": path,
            "state": "ENABLED",
            "userScriptsAccess": { "isActive": true, "isEnabled": true }
        }))
    }

    #[test]
    fn parses_extension_info() {
        let i = installed("0.1.0", "/x");
        assert_eq!(
            (i.version.as_str(), i.path.as_str(), i.state.as_str()),
            ("0.1.0", "/x", "ENABLED")
        );
        assert!(i.user_scripts_active);
        assert!(!Installed::from_value(&json!({})).user_scripts_active);
    }

    #[test]
    fn decides_what_install_does() {
        let stable = Path::new("/nonexistent/chromefile/extension");
        let s = stable.to_str().unwrap();

        assert_eq!(
            decide(None, stable, "0.1.0", false, false),
            Plan::Load { replacing: None }
        );
        let dev = installed("0.1.0", "/src/bridge/extension/dist");
        assert_eq!(
            decide(Some(&dev), stable, "0.1.0", false, false),
            Plan::Conflict {
                other: "/src/bridge/extension/dist".to_string()
            }
        );
        assert_eq!(
            decide(Some(&dev), stable, "0.1.0", false, true),
            Plan::Load {
                replacing: Some("/src/bridge/extension/dist".to_string())
            }
        );
        assert_eq!(
            decide(Some(&installed("0.1.0", s)), stable, "0.1.0", false, false),
            Plan::Unchanged
        );
        assert_eq!(
            decide(
                Some(&installed("0.1.0", &format!("{s}/"))),
                stable,
                "0.1.0",
                false,
                false
            ),
            Plan::Unchanged
        );
        assert_eq!(
            decide(Some(&installed("0.1.0", s)), stable, "0.1.0", true, false),
            Plan::Reload
        );
        assert_eq!(
            decide(Some(&installed("0.0.9", s)), stable, "0.1.0", false, false),
            Plan::Reload
        );
    }

    #[test]
    fn reads_load_errors() {
        assert_eq!(load_error(&Value::Null), None);
        assert_eq!(
            load_error(&json!({ "error": "Manifest file is missing", "path": "/x" })),
            Some("Manifest file is missing (/x)".to_string())
        );
    }

    #[test]
    fn shortens_home_paths() {
        let home = Path::new("/Users/me");
        assert_eq!(
            pretty_path(Path::new("/Users/me/Library/x"), Some(home)),
            "~/Library/x"
        );
        assert_eq!(pretty_path(Path::new("/opt/x"), Some(home)), "/opt/x");
    }
}
