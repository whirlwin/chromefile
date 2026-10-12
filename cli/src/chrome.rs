//! Drives a running Chrome through AppleScript.
//!
//! Chrome's private extension APIs (`chrome.developerPrivate`) only exist on
//! the chrome://extensions page, so we open that page as a background tab and
//! run JavaScript in it with AppleScript's `execute javascript`. That returns
//! only a synchronous result, so async calls store their JSON result in a
//! window variable that we poll.
//!
//! Safety rules, kept from the bridge's chrome-apply.sh:
//! - Values reach AppleScript as osascript arguments (`on run argv`), never by
//!   splicing them into script text. The one exception is the application
//!   name: Chrome's own terms (tabs, `execute`) only compile inside a literal
//!   `tell application "..."`, so the name is checked against a strict
//!   character set before it is placed there.
//! - Data reaches JavaScript base64 encoded and is decoded inside the page.
//! - Only tabs this run opened are closed, also on error and Ctrl-C.

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static INTERRUPTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_sigint(_: i32) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}

unsafe extern "C" {
    fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
}

/// Turns Ctrl-C into an error at the next poll, so the tab guard still runs.
/// The osascript child gets the same SIGINT and fails, which ends the wait.
pub fn catch_sigint() {
    const SIGINT: i32 = 2;
    // SAFETY: the handler only stores to an atomic, which is signal safe.
    unsafe {
        signal(SIGINT, on_sigint);
    }
}

pub fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::SeqCst)
}

fn check_interrupt() -> Result<()> {
    if interrupted() {
        bail!("interrupted");
    }
    Ok(())
}

pub fn pause(ms: u64) -> Result<()> {
    check_interrupt()?;
    std::thread::sleep(Duration::from_millis(ms));
    check_interrupt()
}

/// What went wrong in an osascript call, where we can tell the user how to fix it.
#[derive(Debug, PartialEq, Eq)]
pub enum OsaFailure {
    JavaScriptOff,
    AccessibilityDenied,
    AutomationDenied,
    Other,
}

pub fn classify(stderr: &str) -> OsaFailure {
    let has = |s: &str| stderr.contains(s);
    if has("Executing JavaScript through AppleScript is turned off") {
        OsaFailure::JavaScriptOff
    } else if has("(-1719)")
        || has("(-25211)")
        || has("(1002)")
        || has("assistive access")
        || has("not allowed to send keystrokes")
    {
        OsaFailure::AccessibilityDenied
    } else if has("(-1743)") || has("Not authorized to send Apple events") {
        OsaFailure::AutomationDenied
    } else {
        OsaFailure::Other
    }
}

fn describe(stderr: &str) -> String {
    let hint = match classify(stderr) {
        OsaFailure::JavaScriptOff => {
            "Chrome refused to run JavaScript from AppleScript. In Chrome, turn on \
             View > Developer > Allow JavaScript from Apple Events, then run this again."
        }
        OsaFailure::AccessibilityDenied => {
            "macOS did not allow keystroke automation. Allow your terminal app in \
             System Settings > Privacy & Security > Accessibility."
        }
        OsaFailure::AutomationDenied => {
            "macOS did not allow your terminal app to control Chrome. Allow it in \
             System Settings > Privacy & Security > Automation."
        }
        OsaFailure::Other => return format!("osascript failed: {stderr}"),
    };
    format!("{hint}\n  (osascript: {stderr})")
}

/// Runs an AppleScript given on stdin; `args` arrive as its `argv`.
fn osascript(script: &str, args: &[&str]) -> Result<String> {
    check_interrupt()?;
    let mut child = Command::new("osascript")
        .arg("-")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("could not run osascript")?;
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(script.as_bytes())?;
    let out = child.wait_with_output()?;
    check_interrupt()?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        bail!(describe(stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .trim_end_matches('\n')
        .to_string())
}

/// Letters, digits, space, dot, dash, underscore: enough for "Google Chrome"
/// and "Google Chrome for Testing", and nothing that can end an AppleScript
/// string literal.
pub fn valid_app_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || " .-_".contains(c))
}

/// Whether the app is running, without launching it. AppleScript's
/// `application "X" is running` pops up a "Where is X?" dialog for unknown
/// names, lsappinfo does not.
pub fn is_running(app: &str) -> Result<bool> {
    let out = Command::new("lsappinfo")
        .arg("find")
        .arg(format!("name={app}"))
        .output()
        .context("could not run lsappinfo")?;
    Ok(!String::from_utf8_lossy(&out.stdout).trim().is_empty())
}

/// A running main browser process (not a helper).
#[derive(Debug, PartialEq, Eq)]
pub struct Instance {
    pub pid: u32,
    pub user_data_dir: Option<String>,
}

/// Pids of the main processes of `app` in `ps -axo pid=,comm=` output (comm is
/// the full executable path there): those whose executable is
/// `.../<app>.app/Contents/MacOS/<app>`. Helpers live under
/// Contents/Frameworks and never match.
pub fn parse_main_pids(ps: &str, app: &str) -> Vec<u32> {
    let exe = format!("/{app}.app/Contents/MacOS/{app}");
    ps.lines()
        .filter_map(|line| {
            let (pid, comm) = line.trim().split_once(' ')?;
            if comm.trim_start().ends_with(&exe) {
                pid.parse().ok()
            } else {
                None
            }
        })
        .collect()
}

/// The value of --user-data-dir in a command line. Paths may hold spaces,
/// so the value runs up to the next " --".
pub fn parse_user_data_dir(args: &str) -> Option<String> {
    const FLAG: &str = "--user-data-dir=";
    let v = &args[args.find(FLAG)? + FLAG.len()..];
    Some(v[..v.find(" --").unwrap_or(v.len())].trim_end().to_string())
}

pub fn instances(app: &str) -> Result<Vec<Instance>> {
    let ps = |args: &[&str]| -> Result<String> {
        let out = Command::new("ps")
            .args(args)
            .output()
            .context("could not run ps")?;
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    };
    parse_main_pids(&ps(&["-axo", "pid=,comm="])?, app)
        .into_iter()
        .map(|pid| {
            let args = ps(&["-p", &pid.to_string(), "-o", "args="])?;
            Ok(Instance {
                pid,
                user_data_dir: parse_user_data_dir(&args),
            })
        })
        .collect()
}

/// Builds JS that calls `func(D, done)` with D decoded from base64 JSON, and
/// stores `{"ok": result}` or `{"error": message}` as a JSON string in
/// `window[var]`. `var` and `func` are constants from this program; every
/// runtime value goes through `data`.
pub fn build_call_js(var: &'static str, data: &Value, func: &'static str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_vec(data).expect("JSON values serialize"));
    format!(
        "(function(){{window.{var}=undefined;try{{\
var D=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('{b64}'),function(c){{return c.charCodeAt(0);}})));\
({func})(D,function(r){{var e=window.chrome&&chrome.runtime&&chrome.runtime.lastError;\
window.{var}=JSON.stringify(e?{{error:e.message}}:{{ok:r===undefined?null:r}});}});\
}}catch(x){{window.{var}=JSON.stringify({{error:String(x)}});}}return 'started';}})()"
    )
}

fn poll_js(var: &'static str) -> String {
    format!("typeof window.{var}==='string'?window.{var}:''")
}

/// A Chrome API call's outcome: the result, or Chrome's error message.
pub type CallResult = std::result::Result<Value, String>;

fn parse_call_result(raw: &str) -> Result<CallResult> {
    let v: Value = serde_json::from_str(raw)
        .with_context(|| format!("unexpected reply from Chrome: {raw}"))?;
    if let Some(e) = v.get("error") {
        return Ok(Err(e
            .as_str()
            .map_or_else(|| e.to_string(), str::to_string)));
    }
    Ok(Ok(v.get("ok").cloned().unwrap_or(Value::Null)))
}

/// A helper tab, found again by its unique URL. Chrome's window and tab ids
/// can exceed AppleScript's integer range (2^29 - 1); AppleScript then turns
/// them into reals, which print in locale-dependent scientific notation and
/// no longer resolve as `tab id ...`. A marker in the URL avoids ids entirely.
#[derive(Clone, Debug)]
pub struct Tab {
    url: String,
}

// Chrome scripts. "__APP__" is replaced by a name that passed valid_app_name.
// argv item 1 is always the helper tab's URL.
const COUNT_WINDOWS: &str = r#"tell application "__APP__" to return count of windows"#;

const OPEN_TAB: &str = r#"on run argv
  tell application "__APP__"
    set w to front window
    set prev to active tab index of w
    make new tab at end of tabs of w with properties {URL:(item 1 of argv)}
    set active tab index of w to prev
  end tell
end run"#;

const TAB_LOADING: &str = r#"on run argv
  tell application "__APP__"
    repeat with w in windows
      if (count of (tabs of w whose URL is (item 1 of argv))) > 0 then
        return loading of (first tab of w whose URL is (item 1 of argv))
      end if
    end repeat
  end tell
  error "the chromefile helper tab is gone" number 9100
end run"#;

const EXEC_JS: &str = r#"on run argv
  tell application "__APP__"
    repeat with w in windows
      if (count of (tabs of w whose URL is (item 1 of argv))) > 0 then
        return execute (first tab of w whose URL is (item 1 of argv)) javascript (item 2 of argv)
      end if
    end repeat
  end tell
  error "the chromefile helper tab is gone" number 9100
end run"#;

const CLOSE_TAB: &str = r#"on run argv
  tell application "__APP__"
    repeat with w in windows
      close (tabs of w whose URL is (item 1 of argv))
    end repeat
  end tell
end run"#;

// Brings Chrome to the front with the tab active and returns the index of
// the tab that was active before, so it can be restored.
const ACTIVATE_TAB: &str = r#"on run argv
  tell application "__APP__"
    activate
    repeat with w in windows
      repeat with i from 1 to (count of tabs of w)
        if URL of tab i of w is (item 1 of argv) then
          set prev to active tab index of w
          set active tab index of w to i
          set index of w to 1
          return prev as text
        end if
      end repeat
    end repeat
  end tell
  error "the chromefile helper tab is gone" number 9100
end run"#;

const SET_ACTIVE_INDEX: &str = r#"on run argv
  set i to (item 2 of argv) as integer
  tell application "__APP__"
    repeat with w in windows
      if (count of (tabs of w whose URL is (item 1 of argv))) > 0 then
        if i <= (count of tabs of w) then set active tab index of w to i
        return
      end if
    end repeat
  end tell
end run"#;

// AppleScript handlers that find open panels such as the folder picker.
// Chrome 151 reports the picker with subrole AXDialog, Chrome 154 (macOS 26)
// as an AXStandardWindow, so a window also counts as a panel when it has a
// top-level split group, which browser windows lack.
macro_rules! panel_handlers {
    () => {
        r#"on isPanel(w)
  tell application "System Events"
    try
      if subrole of w is "AXDialog" then return true
      return (count of splitter groups of w) > 0
    end try
  end tell
  return false
end isPanel

on findPanel(procName)
  tell application "System Events" to tell process procName
    repeat with w in windows
      if my isPanel(w) then return contents of w
    end repeat
  end tell
  return missing value
end findPanel

"#
    };
}

// Drives the macOS folder picker that loadUnpacked opens. argv: process name,
// folder path. Keystrokes go to whatever is frontmost, so before each one we
// check that the browser is in front with the picker as its front window.
const DRIVE_PICKER: &str = concat!(
    panel_handlers!(),
    r#"on ready(procName)
  -- Other apps can grab focus for a moment (a notification, say), so try
  -- to win it back a few times before giving up.
  tell application "System Events" to tell process procName
    repeat 5 times
      try
        if frontmost and my isPanel(window 1) then return true
        set frontmost to true
        perform action "AXRaise" of my findPanel(procName)
      end try
      delay 0.3
    end repeat
  end tell
  return false
end ready

on hasSheet(procName)
  tell application "System Events" to tell process procName
    try
      return (count of sheets of window 1) > 0
    end try
  end tell
  return false
end hasSheet

on run argv
  set procName to item 1 of argv
  set folderPath to item 2 of argv
  tell application "System Events" to tell process procName
    set found to false
    repeat 100 times
      if my findPanel(procName) is not missing value then
        set found to true
        exit repeat
      end if
      delay 0.1
    end repeat
    if not found then return "no-panel"
  end tell
  -- Open "Go to Folder". A keystroke sent while the panel is still
  -- becoming key can be lost, so retry until its sheet shows.
  repeat 3 times
    if not my ready(procName) then return "lost-focus"
    tell application "System Events" to keystroke "g" using {command down, shift down}
    repeat 20 times
      if my hasSheet(procName) then exit repeat
      delay 0.1
    end repeat
    if my hasSheet(procName) then exit repeat
  end repeat
  if not my hasSheet(procName) then return "no-go-to-folder"
  if not my ready(procName) then return "lost-focus"
  tell application "System Events" to keystroke folderPath
  delay 0.5
  -- A non-US keyboard layout can garble typed text; don't confirm a wrong
  -- path. The sheet's contents are not always exposed to accessibility, so
  -- only a path we can read and that differs counts as wrong.
  set typed to folderPath
  try
    tell application "System Events" to tell process procName to set typed to value of text field 1 of sheet 1 of window 1
  end try
  if typed is not folderPath then return "typed-wrong"
  if not my ready(procName) then return "lost-focus"
  tell application "System Events" to keystroke return
  repeat 20 times
    if not my hasSheet(procName) then exit repeat
    delay 0.1
  end repeat
  delay 0.5
  -- Press Select through accessibility rather than a second Return, which
  -- can land on a file in the column view. Select is the last button.
  try
    tell application "System Events" to tell process procName
      click last button of splitter group 1 of my findPanel(procName)
    end tell
  on error
    if not my ready(procName) then return "lost-focus"
    tell application "System Events" to keystroke return
  end try
  return "ok"
end run"#
);

// Counts open panels such as folder pickers. argv: process name.
const COUNT_DIALOGS: &str = concat!(
    panel_handlers!(),
    r#"on run argv
  set n to 0
  tell application "System Events" to tell process (item 1 of argv)
    repeat with w in windows
      if my isPanel(w) then set n to n + 1
    end repeat
  end tell
  return n
end run"#
);

// Accepts the "Remove extension?" confirmation (Remove is its default
// button). argv: process name. Chrome cancels the dialog when it loses focus.
const CONFIRM_DIALOG: &str = r#"on run argv
  set procName to item 1 of argv
  tell application "System Events" to tell process procName
    set frontmost to true
    repeat 50 times
      if (count of (windows whose subrole is not "AXStandardWindow")) > 0 then
        repeat 5 times
          delay 0.3
          if frontmost then
            keystroke return
            return "ok"
          end if
          set frontmost to true
        end repeat
        return "lost-focus"
      end if
      delay 0.1
    end repeat
  end tell
  return "no-dialog"
end run"#;

/// A session with a running Chrome. Tabs it opens are closed when it drops.
pub struct Chrome {
    app: String,
    opened: Vec<Tab>,
}

impl Chrome {
    pub fn new(app: &str) -> Result<Self> {
        if !valid_app_name(app) {
            bail!("invalid application name {app:?}: use letters, digits, spaces, dots, dashes");
        }
        Ok(Self {
            app: app.to_string(),
            opened: Vec::new(),
        })
    }

    fn script(&self, template: &str) -> String {
        template.replace("__APP__", &self.app)
    }

    pub fn window_count(&self) -> Result<u32> {
        let out = osascript(&self.script(COUNT_WINDOWS), &[])?;
        out.trim()
            .parse()
            .with_context(|| format!("unexpected window count: {out}"))
    }

    /// Opens chrome://extensions in a background tab of the front window and
    /// waits for it to load.
    pub fn open_extensions_tab(&mut self) -> Result<Tab> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let tab = Tab {
            url: format!(
                "chrome://extensions/?chromefile={:x}{:x}",
                std::process::id(),
                nanos
            ),
        };
        osascript(&self.script(OPEN_TAB), &[&tab.url])?;
        self.opened.push(tab.clone());
        for _ in 0..100 {
            if osascript(&self.script(TAB_LOADING), &[&tab.url])? == "false" {
                return Ok(tab);
            }
            pause(100)?;
        }
        bail!("timed out waiting for chrome://extensions to load")
    }

    /// Leaves a tab open when the session ends.
    pub fn keep_tab(&mut self, tab: &Tab) {
        self.opened.retain(|t| t.url != tab.url);
    }

    pub fn exec_js(&self, tab: &Tab, js: &str) -> Result<String> {
        osascript(&self.script(EXEC_JS), &[&tab.url, js])
    }

    /// Starts an async Chrome API call; collect it with `wait`.
    pub fn start(
        &self,
        tab: &Tab,
        var: &'static str,
        data: &Value,
        func: &'static str,
    ) -> Result<()> {
        let out = self.exec_js(tab, &build_call_js(var, data, func))?;
        if out != "started" {
            bail!("could not start a Chrome API call: {out}");
        }
        Ok(())
    }

    /// Polls for the result of a call started with `start`; None on timeout.
    pub fn wait(
        &self,
        tab: &Tab,
        var: &'static str,
        timeout: Duration,
    ) -> Result<Option<CallResult>> {
        let deadline = Instant::now() + timeout;
        let poll = poll_js(var);
        loop {
            let out = self.exec_js(tab, &poll)?;
            if !out.is_empty() {
                return parse_call_result(&out).map(Some);
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            pause(100)?;
        }
    }

    pub fn call(&self, tab: &Tab, data: &Value, func: &'static str) -> Result<CallResult> {
        const VAR: &str = "__cf";
        self.start(tab, VAR, data, func)?;
        self.wait(tab, VAR, Duration::from_secs(10))?
            .ok_or_else(|| anyhow!("timed out waiting for Chrome to answer"))
    }

    /// Brings Chrome to the front with `tab` active; returns the previously
    /// active tab index for `restore_active`.
    pub fn activate_tab(&self, tab: &Tab) -> Result<String> {
        osascript(&self.script(ACTIVATE_TAB), &[&tab.url])
    }

    pub fn restore_active(&self, tab: &Tab, index: &str) -> Result<()> {
        osascript(&self.script(SET_ACTIVE_INDEX), &[&tab.url, index]).map(drop)
    }

    /// How many panels (such as folder pickers) the browser has open.
    pub fn open_dialogs(&self) -> Result<u32> {
        let out = osascript(COUNT_DIALOGS, &[&self.app])?;
        out.trim()
            .parse()
            .with_context(|| format!("unexpected dialog count: {out}"))
    }

    /// Types `folder` into the open folder picker. Returns "ok", or what
    /// stopped it: "no-panel", "no-go-to-folder", "lost-focus", "typed-wrong".
    pub fn drive_picker(&self, folder: &str) -> Result<String> {
        osascript(DRIVE_PICKER, &[&self.app, folder])
    }

    /// Accepts a confirmation dialog. Returns "ok", "no-dialog" or "lost-focus".
    pub fn confirm_dialog(&self) -> Result<String> {
        osascript(CONFIRM_DIALOG, &[&self.app])
    }
}

impl Drop for Chrome {
    fn drop(&mut self) {
        // Runs after Ctrl-C too, so it must not go through the interrupt check.
        let script = self.script(CLOSE_TAB);
        for tab in self.opened.drain(..) {
            let _ = Command::new("osascript")
                .arg("-")
                .arg(&tab.url)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .and_then(|mut child| {
                    if let Some(mut stdin) = child.stdin.take() {
                        stdin.write_all(script.as_bytes())?;
                    }
                    child.wait()
                });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn decode_payload(js: &str) -> Value {
        let start = js.find("atob('").unwrap() + 6;
        let end = start + js[start..].find('\'').unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&js[start..end])
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn call_js_carries_data_only_as_base64() {
        let evil = "x');alert(1);//\"</script>\u{2028}";
        let data = json!({ "id": evil, "path": "/tmp/a b" });
        let js = build_call_js("__cf", &data, "function(D,done){done(D.id);}");
        assert!(!js.contains(evil));
        assert!(!js.contains("alert"));
        assert!(!js.contains("/tmp/a b"));
        assert_eq!(decode_payload(&js), data);
        assert!(js.starts_with("(function(){window.__cf=undefined;"));
        assert!(js.contains("(function(D,done){done(D.id);})(D,"));
        assert!(js.ends_with("return 'started';})()"));
    }

    #[test]
    fn parses_call_results() {
        assert_eq!(
            parse_call_result(r#"{"ok":{"a":1}}"#).unwrap(),
            Ok(json!({"a":1}))
        );
        assert_eq!(
            parse_call_result(r#"{"ok":null}"#).unwrap(),
            Ok(Value::Null)
        );
        assert_eq!(
            parse_call_result(r#"{"error":"No such extension"}"#).unwrap(),
            Err("No such extension".to_string())
        );
        assert!(parse_call_result("missing value").is_err());
    }

    #[test]
    fn classifies_osascript_errors() {
        assert_eq!(
            classify(
                "execution error: Google Chrome got an error: Executing JavaScript through \
                 AppleScript is turned off. To turn it on, from the menu bar, go to View > \
                 Developer > Allow JavaScript from Apple Events. (12)"
            ),
            OsaFailure::JavaScriptOff
        );
        assert_eq!(
            classify(
                "execution error: System Events got an error: osascript is not allowed to send \
                 keystrokes. (1002)"
            ),
            OsaFailure::AccessibilityDenied
        );
        assert_eq!(
            classify(
                "execution error: System Events got an error: osascript is not allowed assistive access. (-1719)"
            ),
            OsaFailure::AccessibilityDenied
        );
        assert_eq!(
            classify(
                "execution error: Not authorized to send Apple events to Google Chrome. (-1743)"
            ),
            OsaFailure::AutomationDenied
        );
        assert_eq!(classify("syntax error"), OsaFailure::Other);
        assert!(describe("x (-25211)").contains("Accessibility"));
    }

    #[test]
    fn finds_main_browser_processes_only() {
        let ps = "  5172 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n\
 5189 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper\n\
20722 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n\
 1056 /Users/me/ms-playwright/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing\n\
 9999 /usr/bin/grep\n";
        assert_eq!(parse_main_pids(ps, "Google Chrome"), vec![5172, 20722]);
        assert_eq!(parse_main_pids(ps, "Google Chrome for Testing"), vec![1056]);
    }

    #[test]
    fn reads_user_data_dir() {
        assert_eq!(
            parse_user_data_dir(
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --disable-sync \
                 --user-data-dir=/var/folders/x/playwright profile --remote-debugging-pipe about:blank"
            ),
            Some("/var/folders/x/playwright profile".to_string())
        );
        assert_eq!(
            parse_user_data_dir("/x/Google Chrome --user-data-dir=/tmp/cft\n"),
            Some("/tmp/cft".to_string())
        );
        assert_eq!(
            parse_user_data_dir("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            None
        );
    }

    #[test]
    fn app_names_cannot_break_out_of_applescript_strings() {
        assert!(valid_app_name("Google Chrome"));
        assert!(valid_app_name("Google Chrome for Testing"));
        for bad in ["", "Chrome\"", "a\\b", "x\nend tell", "Chrome\u{201d}"] {
            assert!(!valid_app_name(bad), "{bad:?} should be rejected");
        }
        assert!(Chrome::new("Bad\" & do shell script \"x").is_err());
    }
}
