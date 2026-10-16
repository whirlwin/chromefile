//! `chromefile apply`: applies a Chromefile (specification version 1) to the
//! running Google Chrome on macOS.
//!
//! Deciding what to do is pure: `resolve` works from the file and the
//! platform, `plan` adds what Chrome reports. `execute` then makes the
//! changes through the `Browser` trait and reads each one back. Only
//! `ChromeBrowser` talks to Chrome, so everything else is tested on any OS
//! against a fake browser.
//!
//! - `tabs.layout` is Chrome's pref vertical_tabs.enabled, read and set with
//!   chrome.settingsPrivate on a chrome://settings helper tab.
//! - `tabs.duplicate.action` is the Chromefile extension's own setting, kept
//!   in its chrome.storage.local, read and set on a helper tab of the
//!   extension's page apply.html. JavaScript from AppleScript runs there in a
//!   world of its own, which shares the page's DOM but has no chrome.* APIs,
//!   so it sends the page a DOM event and the page, which has them, answers
//!   with another.
//! - `hotkeys` are the commands of the Chromefile extension, set with
//!   chrome.developerPrivate on a chrome://extensions helper tab. Every
//!   extension's commands are read, to see who holds a shortcut first.
//!
//! How Chrome on macOS treats a shortcut set with
//! developerPrivate.updateExtensionCommand, from Chromium's source
//! (CommandService::UpdateKeybindingPrefs, Command::StringToAccelerator,
//! Accelerator::GetShortcutText):
//!
//! - A. It always removes the command's current shortcut first, then adds the
//!   new one, and never reports an error.
//! - B. It reads the shortcut without the translation a manifest's
//!   suggested_key gets: `Command` is ⌘, `Ctrl` is the Control key ⌃, and
//!   there is no `MacCtrl` (a name it does not know sets nothing).
//! - C. It refuses Alt together with Command or Control, and more than 2
//!   modifiers. By then the old shortcut is gone (A), so nothing is left.
//! - D. A shortcut another command holds, in any extension, is moved: Chrome
//!   takes it from that command without a word. It is never refused.
//! - E. It reports a shortcut as symbols, ⌃⌥⇧⌘ and then the key, and gives
//!   F2, F3, F5, F7, F8, F9, F10 and F12 no text at all.
//!
//! So apply refuses up front what Chrome would refuse or can't show (sending
//! it would only remove the old shortcut), fails a shortcut that a command
//! the file does not change holds (D would take it silently), and reads
//! every shortcut back.

use crate::chrome::{self, CallResult, Chrome, Tab};
use crate::chromefile::{
    self, Action, Binding, Chromefile, Combo, DuplicateAction, Layout, Modifier, Platform,
};
use crate::commands::{preflight, pretty_path};
use crate::setup::EXTENSION_ID;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::ffi::OsStr;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const VERTICAL_TABS_PREF: &str = "vertical_tabs.enabled";
const MAC_ONLY: &str = "chromefile apply changes Chrome on macOS only";
/// The Chromefile extension's chrome.storage.local key for
/// tabs.duplicate.action, which its apply page relays. It keeps the name of
/// the setting's first form, tabs.duplicates, whose allow the extension
/// reads as none, so a profile that stored that needs no migration.
const DUPLICATES_KEY: &str = "duplicates";
/// What a tab of apply.html without the page's ready marker means: Chrome
/// has no Chromefile extension (or has it turned off), or one built before
/// apply.html, so it shows some other page there.
const NO_APPLY_PAGE: &str = "the Chromefile extension did not answer on its apply page (not \
                             installed or out of date); run chromefile install";

/// The Chromefile extension's command for each action; the commands are
/// declared in extension/static/manifest.json.
pub fn command(action: Action) -> &'static str {
    match action {
        Action::TabNext => "select-next-tab",
        Action::TabPrevious => "select-previous-tab",
    }
}

/// The outcome words of SPEC.md section 7, plus what a dry run reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Changed,
    Unchanged,
    Failed,
    Unsupported,
    WouldChange,
}

impl Outcome {
    fn word(self) -> &'static str {
        match self {
            Outcome::Changed => "changed",
            Outcome::Unchanged => "unchanged",
            Outcome::Failed => "failed",
            Outcome::Unsupported => "unsupported",
            Outcome::WouldChange => "would change",
        }
    }
}

/// One reported setting, printed as `item: outcome (detail)` like install's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub item: String,
    pub outcome: Outcome,
    pub detail: String,
}

impl Line {
    fn new(item: &str, outcome: Outcome, detail: impl Into<String>) -> Line {
        Line {
            item: item.to_string(),
            outcome,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for Line {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}: {} ({})",
            self.item,
            self.outcome.word(),
            self.detail
        )
    }
}

// Deciding --------------------------------------------------------------------

/// What one setting of the file asks for on this platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Want {
    Layout(Layout),
    /// The Chromefile extension's setting, on macOS.
    DuplicateAction(DuplicateAction),
    /// Bind the extension command to this, on macOS.
    Hotkey {
        command: &'static str,
        binding: Binding,
    },
    /// Decided without asking Chrome.
    Done(Outcome, String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Setting {
    pub item: String,
    pub want: Want,
}

/// Each setting in the file, in file order, and what it asks for on
/// `platform`. Settings absent from the file are not listed (section 7.6).
/// The parser does not keep the order of the keys within `tabs`, so those
/// come in the order of SPEC.md section 5.
pub fn resolve(file: &Chromefile, platform: Platform) -> Vec<Setting> {
    let mut out = Vec::new();
    let on_mac = |want: Want| {
        if platform == Platform::Mac {
            want
        } else {
            Want::Done(Outcome::Unsupported, MAC_ONLY.into())
        }
    };
    if let Some(layout) = file.layout {
        out.push(Setting {
            item: "tabs.layout".into(),
            want: on_mac(Want::Layout(layout)),
        });
    }
    if let Some(action) = file.duplicate_action {
        out.push(Setting {
            item: "tabs.duplicate.action".into(),
            want: on_mac(Want::DuplicateAction(action)),
        });
    }
    for (action, hotkey) in &file.hotkeys {
        let want = match hotkey.resolve(platform) {
            // Section 6.3: an unlisted platform without a default is left
            // as it is, and that is reported as unchanged.
            None => Want::Done(
                Outcome::Unchanged,
                format!(
                    "the platform mapping has no value for {platform} and no default; left as it is"
                ),
            ),
            Some(_) if platform != Platform::Mac => {
                Want::Done(Outcome::Unsupported, MAC_ONLY.into())
            }
            Some(binding) => {
                let limit = match binding {
                    Binding::Combo(c) => mac_limit(c),
                    Binding::Clear => None,
                };
                match limit {
                    Some(why) => Want::Done(Outcome::Unsupported, why),
                    None => Want::Hotkey {
                        command: command(*action),
                        binding: binding.clone(),
                    },
                }
            }
        };
        out.push(Setting {
            item: format!("hotkeys.{}", action.name()),
            want,
        });
    }
    out
}

/// Function keys Chrome on macOS reports with no text (fact E): a shortcut
/// on one reads back as its modifiers alone, Alt+F12 as ⌥.
const NAMELESS_KEYS: [&str; 8] = ["F2", "F3", "F5", "F7", "F8", "F9", "F10", "F12"];

/// Why a combination can't be an extension shortcut in Chrome on macOS
/// (fact C), or can't be checked once set (fact E). Each is reported
/// unsupported without calling Chrome, which would remove the command's
/// current shortcut and set nothing in its place (fact A).
fn mac_limit(combo: &Combo) -> Option<String> {
    let c = combo.on_mac();
    let has = |m| c.modifiers().contains(&m);
    if has(Modifier::Alt) && (has(Modifier::Command) || has(Modifier::MacCtrl)) {
        return Some(format!(
            "{c}: Chrome on macOS does not take Alt together with Command or MacCtrl in an \
             extension shortcut"
        ));
    }
    if c.modifiers().len() > 2 {
        return Some(format!(
            "{c}: Chrome on macOS takes at most 2 modifiers in an extension shortcut"
        ));
    }
    if NAMELESS_KEYS.contains(&c.key()) {
        return Some(format!(
            "{c}: Chrome on macOS reports a shortcut on {} without naming the key, so it can't \
             be checked",
            c.key()
        ));
    }
    None
}

/// A combination as updateExtensionCommand reads it on macOS (fact B). The
/// specification's Command and Ctrl are both ⌘ there, which Chrome calls
/// `Command`; MacCtrl is ⌃, which Chrome calls `Ctrl`.
pub fn chrome_keybinding(combo: &Combo) -> String {
    let mut parts: Vec<&str> = combo
        .modifiers()
        .iter()
        .map(|m| match m {
            Modifier::Command | Modifier::Ctrl => "Command",
            Modifier::MacCtrl => "Ctrl",
            Modifier::Alt => "Alt",
            Modifier::Shift => "Shift",
        })
        .collect();
    parts.push(combo.key());
    parts.join("+")
}

/// A command as developerPrivate reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChromeCommand {
    pub name: String,
    pub keybinding: String,
    pub active: bool,
}

impl ChromeCommand {
    fn from_value(v: &Value) -> ChromeCommand {
        ChromeCommand {
            name: v["name"].as_str().unwrap_or_default().to_string(),
            keybinding: v["keybinding"].as_str().unwrap_or_default().to_string(),
            active: v["isActive"].as_bool().unwrap_or(true),
        }
    }
}

/// An extension, enabled or not, and its commands, as developerPrivate
/// reports them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChromeExtension {
    pub id: String,
    pub name: String,
    pub commands: Vec<ChromeCommand>,
}

impl ChromeExtension {
    fn from_value(v: &Value) -> ChromeExtension {
        ChromeExtension {
            id: v["id"].as_str().unwrap_or_default().to_string(),
            name: v["name"].as_str().unwrap_or_default().to_string(),
            commands: v["commands"]
                .as_array()
                .map(|cs| cs.iter().map(ChromeCommand::from_value).collect())
                .unwrap_or_default(),
        }
    }
}

/// The Chromefile extension, if Chrome has it.
fn ours(extensions: &[ChromeExtension]) -> Option<&ChromeExtension> {
    extensions.iter().find(|e| e.id == EXTENSION_ID)
}

/// A read from Chrome, or why it failed.
pub type Read<T> = std::result::Result<T, String>;

/// What Chrome reports, as far as the settings in the file need it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    /// The value of vertical_tabs.enabled; None when this Chrome has no such
    /// pref.
    pub vertical_tabs: Read<Option<Value>>,
    /// The Chromefile extension's tabs.duplicate.action setting, as its apply
    /// page reports it, under the names SPEC.md section 5.2 uses; None when
    /// the extension did not answer there.
    pub duplicate_action: Read<Option<String>>,
    /// Every extension Chrome has, with its commands.
    pub extensions: Read<Vec<ChromeExtension>>,
}

/// A binding as Chrome reports it on macOS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reported {
    None,
    Combo(Combo),
    /// Something `parse_chrome_binding` can't read, shown as it is.
    Unreadable(String),
}

impl Reported {
    fn of(c: &ChromeCommand) -> Reported {
        if !c.active || c.keybinding.is_empty() {
            return Reported::None;
        }
        match parse_chrome_binding(&c.keybinding) {
            Some(combo) => Reported::Combo(combo),
            None => Reported::Unreadable(c.keybinding.clone()),
        }
    }

    /// Whether Chrome has what the file wants, on macOS, where Ctrl and
    /// Command are the same key.
    fn is(&self, want: &Binding) -> bool {
        match (want, self) {
            (Binding::Clear, Reported::None) => true,
            (Binding::Combo(w), Reported::Combo(h)) => w.on_mac() == h.on_mac(),
            _ => false,
        }
    }
}

impl fmt::Display for Reported {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Reported::None => f.write_str("no hotkey"),
            Reported::Combo(c) => write!(f, "{}", c.on_mac()),
            Reported::Unreadable(s) => write!(f, "{s:?}"),
        }
    }
}

/// A binding the way Chrome on macOS will show it.
fn show(b: &Binding) -> String {
    match b {
        Binding::Clear => "no hotkey".into(),
        Binding::Combo(c) => c.on_mac().to_string(),
    }
}

/// The specification's name for a key as Chrome on macOS shows it (fact E).
/// Home and End have a second symbol each because right-to-left UI
/// languages mirror them. The keys of NAMELESS_KEYS have no text, so they
/// are not here.
fn chrome_key(text: &str) -> Option<&str> {
    Some(match text {
        "," => "Comma",
        "." => "Period",
        "↑" => "Up",
        "↓" => "Down",
        "←" => "Left",
        "→" => "Right",
        "⇞" => "PageUp",
        "⇟" => "PageDown",
        "↖" | "↗" => "Home",
        "↘" | "↙" => "End",
        "Ins" => "Insert",
        "Del" => "Delete",
        "Space" | "F1" | "F4" | "F6" | "F11" => text,
        _ if matches!(text.as_bytes(), [b'A'..=b'Z' | b'0'..=b'9']) => text,
        _ => return None,
    })
}

/// Reads a shortcut the way developerPrivate reports it on macOS: modifier
/// symbols joined with nothing, then the key (`⇧⌘J`). None when it can't be
/// read.
pub fn parse_chrome_binding(s: &str) -> Option<Combo> {
    let mut modifiers = Vec::new();
    let mut rest = s;
    loop {
        let mut chars = rest.chars();
        modifiers.push(match chars.next() {
            Some('⌘') => Modifier::Command,
            Some('⌃') => Modifier::MacCtrl,
            Some('⌥') => Modifier::Alt,
            Some('⇧') => Modifier::Shift,
            _ => break,
        });
        rest = chars.as_str();
    }
    Some(Combo::new(modifiers, chrome_key(rest)?))
}

/// What to do about one setting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Nothing to change; report this.
    Report(Line),
    SetLayout {
        item: String,
        layout: Layout,
        detail: String,
    },
    SetDuplicateAction {
        item: String,
        action: DuplicateAction,
        detail: String,
    },
    SetHotkey {
        item: String,
        command: &'static str,
        binding: Binding,
        detail: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// One per setting, in file order, which is the order lines are
    /// reported in.
    pub steps: Vec<Step>,
    /// The order `execute` carries the steps out in, as indexes into
    /// `steps`; see `run_order`.
    pub order: Vec<usize>,
}

/// Decides each setting from what Chrome reports. Pure; `execute` does the
/// changes.
pub fn plan(settings: &[Setting], state: &State) -> Plan {
    let mut steps: Vec<Step> = settings.iter().map(|s| step(s, state)).collect();
    fail_taken(&mut steps, state);
    let order = run_order(&steps, state);
    Plan { steps, order }
}

fn step(s: &Setting, state: &State) -> Step {
    let report = |outcome, detail: String| Step::Report(Line::new(&s.item, outcome, detail));
    match &s.want {
        Want::Done(outcome, detail) => report(*outcome, detail.clone()),
        Want::Layout(layout) => match &state.vertical_tabs {
            Err(e) => report(Outcome::Failed, e.clone()),
            Ok(None) => report(
                Outcome::Unsupported,
                format!("this Chrome has no {VERTICAL_TABS_PREF} setting"),
            ),
            Ok(Some(Value::Bool(on))) => {
                let have = if *on {
                    Layout::Vertical
                } else {
                    Layout::Horizontal
                };
                if have == *layout {
                    report(Outcome::Unchanged, layout.name().into())
                } else {
                    Step::SetLayout {
                        item: s.item.clone(),
                        layout: *layout,
                        detail: format!("{} -> {}", have.name(), layout.name()),
                    }
                }
            }
            Ok(Some(other)) => report(
                Outcome::Unsupported,
                format!("Chrome's {VERTICAL_TABS_PREF} is {other}, not true or false"),
            ),
        },
        Want::DuplicateAction(want) => match &state.duplicate_action {
            Err(e) => report(Outcome::Failed, e.clone()),
            Ok(None) => report(Outcome::Failed, NO_APPLY_PAGE.into()),
            Ok(Some(have)) => match DuplicateAction::from_name(have) {
                Some(a) if a == *want => report(Outcome::Unchanged, have.clone()),
                Some(_) => Step::SetDuplicateAction {
                    item: s.item.clone(),
                    action: *want,
                    detail: format!("{have} -> {}", want.name()),
                },
                None => report(
                    Outcome::Failed,
                    format!(
                        "the Chromefile extension reports {DUPLICATES_KEY} as {have:?}, not none, \
                         ask or auto-close-duplicates (out of date?); run chromefile install"
                    ),
                ),
            },
        },
        Want::Hotkey { command, binding } => match &state.extensions {
            Err(e) => report(Outcome::Failed, e.clone()),
            Ok(extensions) => match ours(extensions) {
                None => report(
                    Outcome::Failed,
                    "the Chromefile extension is not installed; run chromefile install".into(),
                ),
                Some(ext) => match ext.commands.iter().find(|c| c.name == *command) {
                    None => report(
                        Outcome::Failed,
                        format!(
                            "the Chromefile extension reports no {command} command (out of \
                             date or disabled?); run chromefile install"
                        ),
                    ),
                    Some(c) => {
                        let have = Reported::of(c);
                        if have.is(binding) {
                            report(Outcome::Unchanged, have.to_string())
                        } else {
                            Step::SetHotkey {
                                item: s.item.clone(),
                                command,
                                binding: binding.clone(),
                                detail: format!("{have} -> {}", show(binding)),
                            }
                        }
                    }
                },
            },
        },
    }
}

/// Fails each hotkey whose combination a command holds that this run does
/// not set: another extension's, or one of ours whose action the file
/// leaves alone (absent, unchanged, unsupported or failed). Chrome would
/// take the combination from that command without a word (fact D), changing
/// a shortcut the file does not mention (section 7.6). A command this run
/// does set lets go of its combination when it is set (fact A). A hotkey
/// that fails here keeps its current combination, which may block another,
/// so this repeats until nothing more fails.
///
/// Text that can't be read is never a holder: `mac_limit` refuses every key
/// Chrome shows no text for, and `chrome_key` reads all the others.
fn fail_taken(steps: &mut [Step], state: &State) {
    let Ok(extensions) = &state.extensions else {
        return;
    };
    loop {
        let setting: Vec<&str> = steps
            .iter()
            .filter_map(|s| match s {
                Step::SetHotkey { command, .. } => Some(*command),
                _ => None,
            })
            .collect();
        let taken = steps.iter().enumerate().find_map(|(i, s)| {
            let Step::SetHotkey {
                item,
                binding: binding @ Binding::Combo(c),
                ..
            } = s
            else {
                return None;
            };
            let (ext, holder) = extensions
                .iter()
                .flat_map(|e| e.commands.iter().map(move |cmd| (e, cmd)))
                .filter(|(e, cmd)| !(e.id == EXTENSION_ID && setting.contains(&cmd.name.as_str())))
                .find(|(_, cmd)| Reported::of(cmd).is(binding))?;
            let why = format!(
                "{} is taken by {:?} ({}); free it first",
                c.on_mac(),
                ext.name,
                holder.name
            );
            Some((i, Line::new(item, Outcome::Failed, why)))
        });
        match taken {
            Some((i, line)) => steps[i] = Step::Report(line),
            None => return,
        }
    }
}

/// The order to carry out the steps in. The other settings hold no
/// shortcut, so they go first, in file order. Hotkeys come last, ordered so
/// that each combination is free when it is set: a hotkey waits while
/// another command this run sets still has its combination, because setting
/// that command first drops it (fact A). Clearing a hotkey needs nothing, so
/// it never waits. Only a cycle, such as two hotkeys swapping, can't be
/// ordered that way. Then the first in file order goes first, and Chrome
/// moves its combination from the other command (fact D), which this run
/// sets next anyway. `fail_taken` has ruled out every other holder.
fn run_order(steps: &[Step], state: &State) -> Vec<usize> {
    let has_now = |command: &str, binding: &Binding| {
        state
            .extensions
            .as_deref()
            .ok()
            .and_then(ours)
            .and_then(|e| e.commands.iter().find(|c| c.name == command))
            .is_some_and(|c| Reported::of(c).is(binding))
    };
    let is_set = |i: &usize| matches!(steps[*i], Step::SetHotkey { .. });
    let mut order: Vec<usize> = (0..steps.len()).filter(|i| !is_set(i)).collect();
    let mut pending: Vec<usize> = (0..steps.len()).filter(is_set).collect();
    while !pending.is_empty() {
        let waits = |i: usize| {
            let Step::SetHotkey {
                binding: binding @ Binding::Combo(_),
                ..
            } = &steps[i]
            else {
                return false;
            };
            pending.iter().any(|&j| {
                j != i
                    && matches!(&steps[j], Step::SetHotkey { command, .. } if has_now(command, binding))
            })
        };
        let next = pending.iter().position(|&i| !waits(i)).unwrap_or(0);
        order.push(pending.remove(next));
    }
    order
}

/// Built-in Chrome shortcuts on macOS that a hotkey takes over (section 6:
/// tools SHOULD warn). All are from the Mac list on Google's "Chrome keyboard
/// shortcuts" help page (support.google.com/chrome/answer/157179).
const MAC_BUILTINS: [(&str, &str); 12] = [
    ("Command+Shift+J", "Downloads"),
    ("Command+N", "a new window"),
    ("Command+Shift+N", "a new incognito window"),
    ("Command+T", "a new tab"),
    ("Command+Shift+T", "reopening closed tabs"),
    ("Command+W", "closing the tab"),
    ("Command+Q", "quitting Chrome"),
    ("Command+Comma", "Settings"),
    ("Command+Y", "History"),
    ("Command+F", "Find"),
    ("Command+L", "the address bar"),
    ("Command+D", "bookmarking the page"),
];

/// A warning for each hotkey that replaces one of MAC_BUILTINS on macOS.
pub fn shadow_warnings(file: &Chromefile) -> Vec<String> {
    file.hotkeys
        .iter()
        .filter_map(|(action, hotkey)| {
            let Some(Binding::Combo(c)) = hotkey.resolve(Platform::Mac) else {
                return None;
            };
            let mac = c.on_mac();
            MAC_BUILTINS
                .iter()
                .find(|(s, _)| Combo::parse(s).is_ok_and(|b| b == mac))
                .map(|(s, what)| {
                    format!(
                        "hotkeys.{}: {s} replaces Chrome's built-in shortcut for {what}",
                        action.name()
                    )
                })
        })
        .collect()
}

// Doing -----------------------------------------------------------------------

/// The browser calls `apply` needs.
pub trait Browser {
    /// vertical_tabs.enabled as getAllPrefs lists it; None when Chrome has
    /// no such pref.
    fn vertical_tabs(&mut self) -> Result<Option<Value>>;
    /// Sets it with setPref; false when Chrome says it did not.
    fn set_vertical_tabs(&mut self, on: bool) -> Result<bool>;
    /// Reads it back with getPref.
    fn vertical_tabs_now(&mut self) -> Result<Value>;
    /// The Chromefile extension's tabs.duplicate.action setting as its apply
    /// page reports it, "none" when the extension stores nothing; None when
    /// the page has no ready marker.
    fn duplicate_action(&mut self) -> Result<Option<String>>;
    /// Stores it through the apply page; an error, with the page's reason,
    /// when the page refuses.
    fn set_duplicate_action(&mut self, value: &str) -> Result<()>;
    /// Every extension, enabled or not, with its commands.
    fn extensions(&mut self) -> Result<Vec<ChromeExtension>>;
    /// Binds one of the Chromefile extension's commands, written as
    /// `chrome_keybinding` writes it; "" unbinds.
    fn set_command(&mut self, command: &str, keybinding: &str) -> Result<()>;
}

/// Reads what `plan` needs for these settings, and nothing else, so that a
/// file Chrome is not needed for leaves Chrome alone.
pub fn read_state(settings: &[Setting], browser: &mut impl Browser) -> State {
    let wants = |f: fn(&Want) -> bool| settings.iter().any(|s| f(&s.want));
    let read_err = |e: anyhow::Error| format!("{e:#}");
    State {
        vertical_tabs: if wants(|w| matches!(w, Want::Layout(_))) {
            browser.vertical_tabs().map_err(read_err)
        } else {
            Ok(None)
        },
        duplicate_action: if wants(|w| matches!(w, Want::DuplicateAction(_))) {
            browser.duplicate_action().map_err(read_err)
        } else {
            Ok(None)
        },
        extensions: if wants(|w| matches!(w, Want::Hotkey { .. })) {
            browser.extensions().map_err(read_err)
        } else {
            Ok(Vec::new())
        },
    }
}

fn set_layout(browser: &mut impl Browser, layout: Layout) -> Read<()> {
    let on = layout == Layout::Vertical;
    if !browser
        .set_vertical_tabs(on)
        .map_err(|e| format!("{e:#}"))?
    {
        return Err(format!(
            "Chrome did not change {VERTICAL_TABS_PREF}; a policy may manage it"
        ));
    }
    match browser.vertical_tabs_now().map_err(|e| format!("{e:#}"))? {
        Value::Bool(now) if now == on => Ok(()),
        Value::Bool(now) => Err(format!(
            "set {} but Chrome reports {}",
            layout.name(),
            if now { "vertical" } else { "horizontal" }
        )),
        other => Err(format!(
            "set {} but Chrome reports {VERTICAL_TABS_PREF} = {other}",
            layout.name()
        )),
    }
}

/// Sets the extension's tabs.duplicate.action and reads it back.
fn set_duplicate_action(browser: &mut impl Browser, action: DuplicateAction) -> Read<()> {
    let want = action.name();
    browser
        .set_duplicate_action(want)
        .map_err(|e| format!("{e:#}"))?;
    match browser.duplicate_action().map_err(|e| format!("{e:#}"))? {
        Some(now) if now == want => Ok(()),
        Some(now) => Err(format!(
            "set {want} but the Chromefile extension reports {}",
            DuplicateAction::from_name(&now)
                .map_or_else(|| format!("{now:?}"), |a| a.name().into())
        )),
        None => Err(NO_APPLY_PAGE.into()),
    }
}

/// Sets a command's binding and reads it back. Chrome reports no error for
/// a shortcut it does not take (facts A and C), so only the read back counts.
fn set_hotkey(browser: &mut impl Browser, command: &str, binding: &Binding) -> Read<()> {
    let keybinding = match binding {
        Binding::Clear => String::new(),
        Binding::Combo(c) => chrome_keybinding(c),
    };
    browser
        .set_command(command, &keybinding)
        .map_err(|e| format!("{e:#}"))?;
    let extensions = browser.extensions().map_err(|e| format!("{e:#}"))?;
    let now = ours(&extensions).and_then(|e| e.commands.iter().find(|c| c.name == command));
    match now.map(Reported::of) {
        Some(have) if have.is(binding) => Ok(()),
        Some(have) => Err(format!("set {} but Chrome reports {have}", show(binding))),
        None => Err(format!("Chrome no longer reports the {command} command")),
    }
}

/// Carries out a plan in its order and returns one line per setting, in
/// file order. A dry run reports what would change and calls no setter.
pub fn execute(plan: &Plan, browser: &mut impl Browser, dry_run: bool) -> Vec<Line> {
    let mut lines: Vec<Option<Line>> = vec![None; plan.steps.len()];
    for &i in &plan.order {
        lines[i] = Some(match &plan.steps[i] {
            Step::Report(line) => line.clone(),
            Step::SetLayout { item, detail, .. }
            | Step::SetDuplicateAction { item, detail, .. }
            | Step::SetHotkey { item, detail, .. }
                if dry_run =>
            {
                Line::new(item, Outcome::WouldChange, detail.clone())
            }
            Step::SetLayout {
                item,
                layout,
                detail,
            } => match set_layout(browser, *layout) {
                Ok(()) => Line::new(item, Outcome::Changed, detail.clone()),
                Err(why) => Line::new(item, Outcome::Failed, why),
            },
            Step::SetDuplicateAction {
                item,
                action,
                detail,
            } => match set_duplicate_action(browser, *action) {
                Ok(()) => Line::new(item, Outcome::Changed, detail.clone()),
                Err(why) => Line::new(item, Outcome::Failed, why),
            },
            Step::SetHotkey {
                item,
                command,
                binding,
                detail,
            } => match set_hotkey(browser, command, binding) {
                Ok(()) => Line::new(item, Outcome::Changed, detail.clone()),
                Err(why) => Line::new(item, Outcome::Failed, why),
            },
        });
    }
    lines
        .into_iter()
        .map(|l| l.expect("a plan's order lists every step"))
        .collect()
}

// Chrome ------------------------------------------------------------------------

// Functions run on chrome://settings, chrome://extensions and the
// extension's apply.html as func(D, done); see chrome::build_call_js.
// getAllPrefs lists every pref the settings page may show, so only the one
// asked for is sent back. getExtensionsInfo is asked for disabled and
// terminated extensions too, as the extensions page asks: their shortcuts
// still hold a key (fact D).
//
// RELAY runs on apply.html without chrome.* APIs (see the module comment).
// It sends {id, method, key, value} to the page as a chromefile:request
// event and waits for the chromefile:reply with the same id: {id, ok: true,
// value} with what is stored after the request, or {id, ok: false, error}.
// The details are JSON strings because only strings cross between the two
// worlds. A page without the ready marker answers {missing: true} at once;
// one that never replies runs into Chrome::call's timeout.
const GET_LISTED_PREF: &str = "function(D,done){chrome.settingsPrivate.getAllPrefs(function(ps){var p=ps.filter(function(p){return p.key===D.key;})[0];done(p?{value:p.value===undefined?null:p.value}:null);});}";
const GET_PREF: &str = "function(D,done){chrome.settingsPrivate.getPref(D.key,function(p){done(p?{value:p.value===undefined?null:p.value}:null);});}";
const SET_PREF: &str = "function(D,done){chrome.settingsPrivate.setPref(D.key,D.value,'',function(ok){done(ok===true);});}";
const GET_EXTENSIONS: &str = "function(D,done){chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},function(es){done((es||[]).map(function(e){return {id:e.id,name:e.name,commands:(e.commands||[]).map(function(c){return {name:c.name,keybinding:c.keybinding||'',isActive:c.isActive!==false};})};}));});}";
const SET_COMMAND: &str = "function(D,done){chrome.developerPrivate.updateExtensionCommand({extensionId:D.id,commandName:D.command,keybinding:D.keybinding},function(){done(true);});}";
const RELAY: &str = "function(D,done){var el=document.documentElement;if(!el||el.dataset.chromefileApply!=='1'){done({missing:true});return;}var id='cf'+Date.now()+'-'+Math.random().toString(36).slice(2);function h(e){var r;try{r=JSON.parse(e.detail);}catch(x){return;}if(!r||r.id!==id)return;document.removeEventListener('chromefile:reply',h);done(r);}document.addEventListener('chromefile:reply',h);var q={id:id,method:D.method,key:D.key};if(D.value!==undefined)q.value=D.value;document.dispatchEvent(new CustomEvent('chromefile:request',{detail:JSON.stringify(q)}));}";

/// What RELAY reports: the value the extension stores, or None when the page
/// has no ready marker.
fn relay_reply(reply: &Value) -> Result<Option<String>> {
    if reply["missing"] == Value::Bool(true) {
        return Ok(None);
    }
    match (&reply["ok"], &reply["value"], &reply["error"]) {
        (Value::Bool(true), Value::String(v), _) => Ok(Some(v.clone())),
        (Value::Bool(false), _, Value::String(e)) => bail!("the Chromefile extension refused: {e}"),
        _ => bail!("the Chromefile extension's apply page answered {reply}"),
    }
}

#[derive(Clone, Copy)]
enum Page {
    Settings,
    Extensions,
    /// The Chromefile extension's apply.html.
    Apply,
}

impl Page {
    fn url(self) -> String {
        match self {
            Page::Settings => "chrome://settings".into(),
            Page::Extensions => "chrome://extensions".into(),
            Page::Apply => format!("chrome-extension://{EXTENSION_ID}/apply.html"),
        }
    }
}

/// The running Chrome. The session and each helper tab are set up when
/// first needed, so a failure there fails only the settings that need it;
/// Chrome's Drop closes the tabs.
struct ChromeBrowser {
    app: String,
    session: Option<Read<Chrome>>,
    settings: Option<Read<Tab>>,
    extensions: Option<Read<Tab>>,
    apply: Option<Read<Tab>>,
}

impl ChromeBrowser {
    fn new(app: &str) -> ChromeBrowser {
        ChromeBrowser {
            app: app.to_string(),
            session: None,
            settings: None,
            extensions: None,
            apply: None,
        }
    }

    fn call(&mut self, page: Page, data: &Value, func: &'static str) -> Result<CallResult> {
        let app = &self.app;
        let chrome = match self
            .session
            .get_or_insert_with(|| preflight(app).map_err(|e| format!("{e:#}")))
        {
            Ok(chrome) => chrome,
            Err(e) => bail!("{e}"),
        };
        let slot = match page {
            Page::Settings => &mut self.settings,
            Page::Extensions => &mut self.extensions,
            Page::Apply => &mut self.apply,
        };
        let open = |chrome: &mut Chrome| {
            chrome.open_tab(&page.url()).map_err(|e| match page {
                // A Chrome without the extension, or with one built before
                // apply.html, may show a page there that never loads.
                Page::Apply if !crate::chrome::interrupted() => format!(
                    "{e:#}; if the Chromefile extension is missing or out of date, run \
                     chromefile install"
                ),
                _ => format!("{e:#}"),
            })
        };
        let tab = match slot.get_or_insert_with(|| open(chrome)) {
            Ok(tab) => tab,
            Err(e) => bail!("{e}"),
        };
        chrome.call(tab, data, func)
    }
}

impl Browser for ChromeBrowser {
    fn vertical_tabs(&mut self) -> Result<Option<Value>> {
        let data = json!({ "key": VERTICAL_TABS_PREF });
        match self.call(Page::Settings, &data, GET_LISTED_PREF)? {
            Ok(Value::Null) => Ok(None),
            Ok(v) => Ok(Some(v["value"].clone())),
            Err(e) => bail!("Chrome refused to list its settings: {e}"),
        }
    }

    fn set_vertical_tabs(&mut self, on: bool) -> Result<bool> {
        let data = json!({ "key": VERTICAL_TABS_PREF, "value": on });
        match self.call(Page::Settings, &data, SET_PREF)? {
            Ok(v) => Ok(v == Value::Bool(true)),
            Err(e) => bail!("Chrome refused to change {VERTICAL_TABS_PREF}: {e}"),
        }
    }

    fn vertical_tabs_now(&mut self) -> Result<Value> {
        let data = json!({ "key": VERTICAL_TABS_PREF });
        match self.call(Page::Settings, &data, GET_PREF)? {
            Ok(v) => Ok(v["value"].clone()),
            Err(e) => bail!("Chrome refused to read {VERTICAL_TABS_PREF}: {e}"),
        }
    }

    fn duplicate_action(&mut self) -> Result<Option<String>> {
        let data = json!({ "method": "get", "key": DUPLICATES_KEY });
        match self.call(Page::Apply, &data, RELAY)? {
            Ok(reply) => relay_reply(&reply),
            Err(e) => bail!("the Chromefile extension's apply page failed: {e}"),
        }
    }

    fn set_duplicate_action(&mut self, value: &str) -> Result<()> {
        let data = json!({ "method": "set", "key": DUPLICATES_KEY, "value": value });
        match self.call(Page::Apply, &data, RELAY)? {
            Ok(reply) => match relay_reply(&reply)? {
                Some(_) => Ok(()),
                None => bail!(NO_APPLY_PAGE),
            },
            Err(e) => bail!("the Chromefile extension's apply page failed: {e}"),
        }
    }

    fn extensions(&mut self) -> Result<Vec<ChromeExtension>> {
        match self.call(Page::Extensions, &json!({}), GET_EXTENSIONS)? {
            Ok(Value::Array(es)) => Ok(es.iter().map(ChromeExtension::from_value).collect()),
            Ok(other) => bail!("Chrome listed the extensions as {other}"),
            Err(e) => bail!("Chrome refused to list the extensions: {e}"),
        }
    }

    fn set_command(&mut self, command: &str, keybinding: &str) -> Result<()> {
        let data = json!({ "id": EXTENSION_ID, "command": command, "keybinding": keybinding });
        match self.call(Page::Extensions, &data, SET_COMMAND)? {
            Ok(_) => Ok(()),
            Err(e) => bail!("Chrome refused the shortcut: {e}"),
        }
    }
}

// The command -------------------------------------------------------------------

/// Where to look for a Chromefile when no path is given, in order:
/// ./Chromefile, then chromefile/Chromefile in the XDG config folder
/// ($XDG_CONFIG_HOME if it is absolute, as the XDG spec says, else
/// ~/.config).
pub fn default_locations(
    cwd: &Path,
    xdg_config_home: Option<&OsStr>,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let config = match xdg_config_home.map(Path::new) {
        Some(dir) if dir.is_absolute() => Some(dir.to_path_buf()),
        _ => home.map(|h| h.join(".config")),
    };
    let mut out = vec![cwd.join("Chromefile")];
    out.extend(config.map(|c| c.join("chromefile").join("Chromefile")));
    out
}

/// Whether the folder of `path` has an entry spelled exactly like the last
/// part of `path`. macOS folders are usually case-insensitive, so asking for
/// `Chromefile` directly also finds a `chromefile` folder or the chromefile
/// binary, while SPEC.md section 3 makes the name case-sensitive. A broken
/// link counts, so that it is reported rather than skipped for the next
/// place.
fn exists_exactly(path: &Path) -> bool {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return false;
    };
    std::fs::read_dir(dir)
        .is_ok_and(|mut entries| entries.any(|e| e.is_ok_and(|e| e.file_name() == name)))
}

/// The exit status for a run that reported these lines: 1 if any setting
/// failed; else, with `check`, 2 if any setting would change, which means
/// Chrome does not match the file; else 0. An unsupported setting is not
/// drift: no run can change it.
pub fn exit_status(lines: &[Line], check: bool) -> u8 {
    let has = |outcome| lines.iter().any(|l| l.outcome == outcome);
    if has(Outcome::Failed) {
        1
    } else if check && has(Outcome::WouldChange) {
        2
    } else {
        0
    }
}

/// Applies the Chromefile at `path` (or the first in `default_locations`).
/// `check` is a dry run whose exit status reports drift (see `exit_status`).
pub fn run(path: Option<PathBuf>, dry_run: bool, check: bool, app: &str) -> ExitCode {
    let dry_run = dry_run || check;
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let pretty = |p: &Path| pretty_path(p, home.as_deref());

    let path = match path {
        Some(path) => path,
        None => {
            let cwd = match std::env::current_dir() {
                Ok(cwd) => cwd,
                Err(e) => {
                    eprintln!("error: can't tell the current folder: {e}");
                    return ExitCode::FAILURE;
                }
            };
            let xdg = std::env::var_os("XDG_CONFIG_HOME");
            let places = default_locations(&cwd, xdg.as_deref(), home.as_deref());
            match places.iter().find(|p| exists_exactly(p)) {
                Some(found) => found.clone(),
                None => {
                    let looked: Vec<String> = places.iter().map(|p| pretty(p)).collect();
                    eprintln!(
                        "error: no Chromefile found (looked for {}); give its path: chromefile apply PATH",
                        looked.join(" and ")
                    );
                    return ExitCode::FAILURE;
                }
            }
        }
    };
    let shown = pretty(&std::path::absolute(&path).unwrap_or_else(|_| path.clone()));
    if dry_run {
        println!("applying {shown} (dry run: nothing is changed)");
    } else {
        println!("applying {shown}");
    }

    // The whole file is validated before anything is changed (section 7.1).
    let src = match std::fs::read_to_string(&path) {
        Ok(src) => src,
        Err(e) => {
            eprintln!("error: can't read {shown}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let file = match chromefile::parse(&src) {
        Ok(file) => file,
        Err(errors) => {
            for e in errors {
                eprintln!("error: {e}");
            }
            eprintln!("{shown} is not a valid Chromefile, so nothing was changed");
            return ExitCode::FAILURE;
        }
    };

    let platform = Platform::current();
    let settings = resolve(&file, platform);
    if settings.is_empty() {
        println!("nothing to apply (the file sets no settings)");
        return ExitCode::SUCCESS;
    }
    if platform == Platform::Mac {
        for w in shadow_warnings(&file) {
            eprintln!("warning: {w}");
        }
    }

    let mut browser = ChromeBrowser::new(app);
    let needs_chrome = settings.iter().any(|s| !matches!(s.want, Want::Done(..)));
    if needs_chrome {
        chrome::catch_sigint();
    }
    let state = read_state(&settings, &mut browser);
    let lines = execute(&plan(&settings, &state), &mut browser, dry_run);
    drop(browser);

    for line in &lines {
        if line.outcome == Outcome::Failed {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
    }
    if chrome::interrupted() {
        eprintln!("interrupted");
        return ExitCode::from(130);
    }
    ExitCode::from(exit_status(&lines, check))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(src: &str) -> Chromefile {
        chromefile::parse(src).unwrap()
    }

    fn combo(s: &str) -> Combo {
        Combo::parse(s).unwrap()
    }

    fn cmd(name: &str, keybinding: &str) -> ChromeCommand {
        ChromeCommand {
            name: name.into(),
            keybinding: keybinding.into(),
            active: !keybinding.is_empty(),
        }
    }

    fn ext(id: &str, name: &str, commands: &[(&str, &str)]) -> ChromeExtension {
        ChromeExtension {
            id: id.into(),
            name: name.into(),
            commands: commands.iter().map(|(n, k)| cmd(n, k)).collect(),
        }
    }

    // The fake Chrome. It models facts A to E (see the module comment) from
    // Chrome's side and shares no code with what it tests: shortcuts are
    // read and shown with its own tables.

    /// A shortcut as Chrome's CommandService keeps it.
    #[derive(Debug, Clone, PartialEq)]
    struct Accelerator {
        command: bool,
        ctrl: bool,
        alt: bool,
        shift: bool,
        key: String,
    }

    /// Chrome's text for the keys besides A to Z and 0 to 9 on macOS (fact
    /// E), in a left-to-right UI language.
    const KEY_TEXT: [(&str, &str); 25] = [
        ("Comma", ","),
        ("Period", "."),
        ("Up", "↑"),
        ("Down", "↓"),
        ("Left", "←"),
        ("Right", "→"),
        ("PageUp", "⇞"),
        ("PageDown", "⇟"),
        ("Home", "↖"),
        ("End", "↘"),
        ("Space", "Space"),
        ("Insert", "Ins"),
        ("Delete", "Del"),
        ("F1", "F1"),
        ("F2", ""),
        ("F3", ""),
        ("F4", "F4"),
        ("F5", ""),
        ("F6", "F6"),
        ("F7", ""),
        ("F8", ""),
        ("F9", ""),
        ("F10", ""),
        ("F11", "F11"),
        ("F12", ""),
    ];

    /// What updateExtensionCommand makes of a keybinding on macOS; None
    /// when it sets nothing (facts B and C).
    fn accelerator(keybinding: &str) -> Option<Accelerator> {
        let tokens: Vec<&str> = keybinding.split('+').collect();
        // At most 2 modifiers and the key.
        if tokens.len() > 3 {
            return None;
        }
        let (key, modifiers) = tokens.split_last()?;
        let mut a = Accelerator {
            command: false,
            ctrl: false,
            alt: false,
            shift: false,
            key: key.to_string(),
        };
        for m in modifiers {
            match *m {
                "Command" => a.command = true,
                "Ctrl" => a.ctrl = true,
                "Alt" => a.alt = true,
                "Shift" => a.shift = true,
                // MacCtrl among them: only a manifest knows it.
                _ => return None,
            }
        }
        let known = matches!(key.as_bytes(), [b'A'..=b'Z' | b'0'..=b'9'])
            || KEY_TEXT.iter().any(|(k, _)| k == key);
        let refused = !(a.command || a.ctrl || a.alt) || (a.alt && (a.command || a.ctrl));
        (known && !refused).then_some(a)
    }

    /// How developerPrivate shows a shortcut on macOS (fact E).
    fn shortcut_text(a: &Accelerator) -> String {
        let mut text = String::new();
        for (on, symbol) in [
            (a.ctrl, '⌃'),
            (a.alt, '⌥'),
            (a.shift, '⇧'),
            (a.command, '⌘'),
        ] {
            if on {
                text.push(symbol);
            }
        }
        let key = KEY_TEXT.iter().find(|(k, _)| *k == a.key);
        text + key.map_or(a.key.as_str(), |(_, t)| t)
    }

    /// The same in a right-to-left UI language, which mirrors Home and End.
    fn right_to_left(a: &Accelerator) -> String {
        shortcut_text(a).replace('↖', "↗").replace('↘', "↙")
    }

    struct FakeExtension {
        id: String,
        name: String,
        commands: Vec<(String, Option<Accelerator>)>,
    }

    /// A Chrome that keeps its state in memory and logs the calls.
    struct Fake {
        pref: Option<Value>,
        /// What setPref answers; when false nothing changes.
        accept_pref: bool,
        /// What the extension stores under duplicates; None for nothing.
        stored_duplicates: Option<String>,
        /// Whether apply.html has its ready marker: false for a Chrome
        /// without the extension, or with one built before the page.
        apply_page: bool,
        /// Whether a set reaches the storage; when false the page answers
        /// as if it did, and only the read back can tell.
        accept_duplicates: bool,
        /// The reason the page refuses each set with, if it does.
        refuse_duplicates: Option<String>,
        extensions: Vec<FakeExtension>,
        /// How shortcuts are shown.
        text: fn(&Accelerator) -> String,
        calls: Vec<String>,
    }

    impl Fake {
        /// A Chrome with the Chromefile extension, its commands bound to
        /// keybindings as updateExtensionCommand reads them ("" for none).
        fn new(pref: Option<bool>, commands: &[(&str, &str)]) -> Fake {
            let mut fake = Fake {
                pref: pref.map(Value::Bool),
                accept_pref: true,
                stored_duplicates: None,
                apply_page: true,
                accept_duplicates: true,
                refuse_duplicates: None,
                extensions: Vec::new(),
                text: shortcut_text,
                calls: Vec::new(),
            };
            fake.add(EXTENSION_ID, "Chromefile", commands);
            fake
        }

        fn add(&mut self, id: &str, name: &str, commands: &[(&str, &str)]) {
            let commands = commands
                .iter()
                .map(|(c, k)| {
                    let a = accelerator(k);
                    assert!(k.is_empty() || a.is_some(), "Chrome can't hold {k}");
                    (c.to_string(), a)
                })
                .collect();
            self.extensions.push(FakeExtension {
                id: id.into(),
                name: name.into(),
                commands,
            });
        }

        fn setters(&self) -> Vec<&str> {
            self.calls
                .iter()
                .filter(|c| c.starts_with("set"))
                .map(String::as_str)
                .collect()
        }

        /// What Chrome shows for a command; "" for none.
        fn shown(&self, id: &str, command: &str) -> String {
            let e = self.extensions.iter().find(|e| e.id == id).unwrap();
            let (_, a) = e.commands.iter().find(|(c, _)| c == command).unwrap();
            a.as_ref().map(self.text).unwrap_or_default()
        }

        fn ours(&self, command: &str) -> String {
            self.shown(EXTENSION_ID, command)
        }
    }

    impl Browser for Fake {
        fn vertical_tabs(&mut self) -> Result<Option<Value>> {
            self.calls.push("getAllPrefs".into());
            Ok(self.pref.clone())
        }

        fn set_vertical_tabs(&mut self, on: bool) -> Result<bool> {
            self.calls.push(format!("setPref {on}"));
            if self.accept_pref {
                self.pref = Some(Value::Bool(on));
            }
            Ok(self.accept_pref)
        }

        fn vertical_tabs_now(&mut self) -> Result<Value> {
            self.calls.push("getPref".into());
            Ok(self.pref.clone().unwrap_or(Value::Null))
        }

        fn duplicate_action(&mut self) -> Result<Option<String>> {
            self.calls.push("getDuplicates".into());
            // Like the real page, nothing stored reads as none. Anything else
            // is reported as it is, to stand in for a page that reports a
            // value apply does not know.
            let stored = self.stored_duplicates.as_deref().unwrap_or("none");
            Ok(self.apply_page.then(|| stored.to_string()))
        }

        fn set_duplicate_action(&mut self, value: &str) -> Result<()> {
            self.calls.push(format!("setDuplicates {value}"));
            if !self.apply_page {
                bail!("no apply page");
            }
            if let Some(why) = &self.refuse_duplicates {
                bail!("{why}");
            }
            if self.accept_duplicates {
                self.stored_duplicates = Some(value.into());
            }
            Ok(())
        }

        fn extensions(&mut self) -> Result<Vec<ChromeExtension>> {
            self.calls.push("getExtensionsInfo".into());
            let text = self.text;
            Ok(self
                .extensions
                .iter()
                .map(|e| ChromeExtension {
                    id: e.id.clone(),
                    name: e.name.clone(),
                    commands: e
                        .commands
                        .iter()
                        .map(|(name, a)| ChromeCommand {
                            name: name.clone(),
                            keybinding: a.as_ref().map(text).unwrap_or_default(),
                            active: a.is_some(),
                        })
                        .collect(),
                })
                .collect())
        }

        fn set_command(&mut self, command: &str, keybinding: &str) -> Result<()> {
            self.calls
                .push(format!("setCommand {command} {keybinding}"));
            let Some((e, c)) = self.extensions.iter().enumerate().find_map(|(e, ext)| {
                let c = ext.commands.iter().position(|(c, _)| c == command)?;
                (ext.id == EXTENSION_ID).then_some((e, c))
            }) else {
                return Ok(());
            };
            // A: the command's own shortcut goes first, whatever follows.
            self.extensions[e].commands[c].1 = None;
            // B and C: what Chrome can't read or refuses sets nothing.
            let Some(a) = accelerator(keybinding) else {
                return Ok(());
            };
            // D: whichever command holds it, in any extension, loses it.
            for ext in &mut self.extensions {
                for (_, held) in &mut ext.commands {
                    if held.as_ref() == Some(&a) {
                        *held = None;
                    }
                }
            }
            self.extensions[e].commands[c].1 = Some(a);
            Ok(())
        }
    }

    const NEXT: &str = "select-next-tab";
    const PREV: &str = "select-previous-tab";
    const OTHER: &str = "abcdefghijklmnopabcdefghijklmnop";

    fn apply(src: &str, chrome: &mut Fake, dry_run: bool) -> Vec<String> {
        let settings = resolve(&file(src), Platform::Mac);
        let state = read_state(&settings, chrome);
        execute(&plan(&settings, &state), chrome, dry_run)
            .iter()
            .map(Line::to_string)
            .collect()
    }

    #[test]
    fn every_action_has_a_command_in_the_manifests() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        // The source manifest and the copy embedded in the binary.
        for manifest in [
            "../extension/static/manifest.json",
            "extension/manifest.json",
        ] {
            let raw = std::fs::read_to_string(root.join(manifest)).unwrap();
            let json: Value = serde_json::from_str(&raw).unwrap();
            for action in Action::ALL {
                assert!(
                    json["commands"][command(action)].is_object(),
                    "{manifest} has no command {} for {}",
                    command(action),
                    action.name()
                );
            }
        }
    }

    #[test]
    fn finds_the_chromefile_in_order() {
        let cwd = Path::new("/w");
        let home = Some(Path::new("/h"));
        let abs = OsStr::new("/x");
        assert_eq!(
            default_locations(cwd, None, home),
            vec![
                PathBuf::from("/w/Chromefile"),
                PathBuf::from("/h/.config/chromefile/Chromefile")
            ]
        );
        assert_eq!(
            default_locations(cwd, Some(abs), home)[1],
            PathBuf::from("/x/chromefile/Chromefile")
        );
        // A relative XDG_CONFIG_HOME is ignored.
        assert_eq!(
            default_locations(cwd, Some(OsStr::new("rel")), home)[1],
            PathBuf::from("/h/.config/chromefile/Chromefile")
        );
        assert_eq!(
            default_locations(cwd, Some(OsStr::new("rel")), None),
            vec![PathBuf::from("/w/Chromefile")]
        );
    }

    #[test]
    fn finds_only_an_entry_spelled_exactly_chromefile() {
        let base =
            std::env::temp_dir().join(format!("chromefile-apply-{}-lookup", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = |name: &str| {
            let d = base.join(name);
            std::fs::create_dir_all(&d).unwrap();
            d
        };
        // On a case-insensitive disk (the macOS default) both of these
        // answer to Chromefile, and one folder can't hold two spellings, so
        // each case has a folder of its own.
        let folder = dir("folder");
        std::fs::create_dir(folder.join("chromefile")).unwrap();
        assert!(!exists_exactly(&folder.join("Chromefile")));
        let binary = dir("binary");
        std::fs::write(binary.join("chromefile"), "").unwrap();
        assert!(!exists_exactly(&binary.join("Chromefile")));

        let found = dir("file");
        std::fs::write(found.join("Chromefile"), "version: 1\n").unwrap();
        assert!(exists_exactly(&found.join("Chromefile")));
        assert!(!exists_exactly(&found.join("CHROMEFILE")));
        assert!(!exists_exactly(&base.join("missing").join("Chromefile")));
        // A broken link is found, so that apply reports it.
        #[cfg(unix)]
        {
            let link = dir("link");
            std::os::unix::fs::symlink(base.join("nowhere"), link.join("Chromefile")).unwrap();
            assert!(exists_exactly(&link.join("Chromefile")));
        }
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn resolves_for_the_platform() {
        let f = file(
            "version: 1\ntabs:\n  layout: vertical\n  duplicate:\n    action: ask\nhotkeys:\n  tab.next: Command+J\n  tab.previous:\n    windows: Alt+K\n",
        );
        assert_eq!(
            resolve(&f, Platform::Mac),
            vec![
                Setting {
                    item: "tabs.layout".into(),
                    want: Want::Layout(Layout::Vertical)
                },
                Setting {
                    item: "tabs.duplicate.action".into(),
                    want: Want::DuplicateAction(DuplicateAction::Ask)
                },
                Setting {
                    item: "hotkeys.tab.next".into(),
                    want: Want::Hotkey {
                        command: NEXT,
                        binding: Binding::Combo(combo("Command+J"))
                    }
                },
                Setting {
                    item: "hotkeys.tab.previous".into(),
                    want: Want::Done(
                        Outcome::Unchanged,
                        "the platform mapping has no value for mac and no default; left as it is"
                            .into()
                    )
                },
            ]
        );
        let linux: Vec<Want> = resolve(&f, Platform::Linux)
            .into_iter()
            .map(|s| s.want)
            .collect();
        assert_eq!(
            linux,
            vec![
                Want::Done(Outcome::Unsupported, MAC_ONLY.into()),
                Want::Done(Outcome::Unsupported, MAC_ONLY.into()),
                Want::Done(Outcome::Unsupported, MAC_ONLY.into()),
                Want::Done(
                    Outcome::Unchanged,
                    "the platform mapping has no value for linux and no default; left as it is"
                        .into()
                ),
            ]
        );
        assert!(resolve(&file("version: 1\n"), Platform::Mac).is_empty());
    }

    #[test]
    fn knows_what_chrome_on_the_mac_refuses_or_hides() {
        let refused = [
            (
                "Command+Alt+J",
                "Command+Alt+J: Chrome on macOS does not take Alt",
            ),
            (
                "Ctrl+Alt+J",
                "Command+Alt+J: Chrome on macOS does not take Alt",
            ),
            (
                "MacCtrl+Alt+J",
                "MacCtrl+Alt+J: Chrome on macOS does not take Alt",
            ),
            (
                "Ctrl+MacCtrl+Shift+J",
                "Command+MacCtrl+Shift+J: Chrome on macOS takes at most 2 modifiers",
            ),
            (
                "Alt+F12",
                "Alt+F12: Chrome on macOS reports a shortcut on F12 without naming the key",
            ),
        ];
        for (s, why) in refused {
            let got = mac_limit(&combo(s)).unwrap_or_default();
            assert!(got.starts_with(why), "{s}: {got}");
        }
        for key in NAMELESS_KEYS {
            assert!(
                mac_limit(&combo(&format!("Command+{key}"))).is_some(),
                "{key}"
            );
        }
        for ok in [
            "Command+Shift+J",
            "Ctrl+Shift+J",
            "MacCtrl+Shift+Down",
            "Alt+Shift+K",
            "Command+MacCtrl+K",
            "Alt+F1",
            "Command+F4",
            "MacCtrl+F6",
            "Alt+F11",
        ] {
            assert_eq!(mac_limit(&combo(ok)), None, "{ok}");
        }
    }

    #[test]
    fn reports_those_unsupported_without_calling_chrome() {
        // Calling would cost the command its current shortcut (fact A).
        let mut chrome = Fake::new(None, &[(NEXT, "Alt+J"), (PREV, "Alt+K")]);
        assert_eq!(
            apply(
                "version: 1\nhotkeys:\n  tab.next: Ctrl+Alt+J\n  tab.previous: Alt+F12\n",
                &mut chrome,
                false
            ),
            vec![
                "hotkeys.tab.next: unsupported (Command+Alt+J: Chrome on macOS does not take Alt \
                 together with Command or MacCtrl in an extension shortcut)",
                "hotkeys.tab.previous: unsupported (Alt+F12: Chrome on macOS reports a shortcut \
                 on F12 without naming the key, so it can't be checked)",
            ]
        );
        assert!(chrome.calls.is_empty(), "{:?}", chrome.calls);
        assert_eq!(
            (chrome.ours(NEXT), chrome.ours(PREV)),
            ("⌥J".into(), "⌥K".into())
        );
        for refused in ["Command+MacCtrl+Shift+J", "MacCtrl+Alt+J", "Command+F5"] {
            let lines = apply(
                &format!("version: 1\nhotkeys:\n  tab.next: {refused}\n"),
                &mut chrome,
                false,
            );
            assert!(lines[0].contains(": unsupported ("), "{refused}: {lines:?}");
            assert!(chrome.calls.is_empty(), "{refused}: {:?}", chrome.calls);
        }
        // Only macOS has these limits; elsewhere apply changes nothing.
        let windows = resolve(
            &file("version: 1\nhotkeys:\n  tab.next: Ctrl+Alt+J\n"),
            Platform::Windows,
        );
        assert_eq!(
            windows[0].want,
            Want::Done(Outcome::Unsupported, MAC_ONLY.into())
        );
    }

    #[test]
    fn sends_chrome_its_own_notation() {
        for (spec, chrome) in [
            ("Command+J", "Command+J"),
            ("Ctrl+J", "Command+J"),
            ("Shift+Ctrl+J", "Command+Shift+J"),
            ("MacCtrl+Shift+Down", "Ctrl+Shift+Down"),
            ("Shift+Alt+K", "Alt+Shift+K"),
            ("MacCtrl+Command+Comma", "Command+Ctrl+Comma"),
        ] {
            assert_eq!(chrome_keybinding(&combo(spec)), chrome, "{spec}");
        }
    }

    #[test]
    fn sends_macctrl_as_ctrl_and_command_or_ctrl_as_command() {
        let src = "version: 1\nhotkeys:\n  tab.next: MacCtrl+Shift+Up\n  tab.previous: Ctrl+K\n";
        let mut chrome = Fake::new(None, &[(NEXT, "Alt+J"), (PREV, "Alt+K")]);
        assert_eq!(
            apply(src, &mut chrome, false),
            vec![
                "hotkeys.tab.next: changed (Alt+J -> MacCtrl+Shift+Up)",
                "hotkeys.tab.previous: changed (Alt+K -> Command+K)",
            ]
        );
        assert_eq!(
            chrome.setters(),
            vec![
                "setCommand select-next-tab Ctrl+Shift+Up",
                "setCommand select-previous-tab Command+K"
            ]
        );
        assert_eq!(
            (chrome.ours(NEXT), chrome.ours(PREV)),
            ("⌃⇧↑".into(), "⌘K".into())
        );
        chrome.calls.clear();
        assert_eq!(
            apply(src, &mut chrome, false),
            vec![
                "hotkeys.tab.next: unchanged (MacCtrl+Shift+Up)",
                "hotkeys.tab.previous: unchanged (Command+K)",
            ]
        );
        assert!(chrome.setters().is_empty());
    }

    #[test]
    fn reads_the_shortcut_text_chrome_shows_on_the_mac() {
        let cases = [
            ("⇧⌘J", "Command+Shift+J"),
            ("⌘⇧J", "Command+Shift+J"),
            ("⌃⇧↓", "MacCtrl+Shift+Down"),
            ("⌃⌘K", "Command+MacCtrl+K"),
            ("⌘,", "Command+Comma"),
            ("⌘.", "Command+Period"),
            ("⌥⇧→", "Alt+Shift+Right"),
            ("⌘←", "Command+Left"),
            ("⌘↑", "Command+Up"),
            ("⇧⌘⇞", "Command+Shift+PageUp"),
            ("⌘⇟", "Command+PageDown"),
            ("⌥↖", "Alt+Home"),
            ("⌥↗", "Alt+Home"),
            ("⌥↘", "Alt+End"),
            ("⌥↙", "Alt+End"),
            ("⌘Space", "Command+Space"),
            ("⌘Ins", "Command+Insert"),
            ("⌘Del", "Command+Delete"),
            ("⌥F1", "Alt+F1"),
            ("⌥F11", "Alt+F11"),
            ("⌘0", "Command+0"),
        ];
        for (s, want) in cases {
            assert_eq!(
                parse_chrome_binding(s).map(|c| c.to_string()),
                Some(want.to_string()),
                "{s}"
            );
        }
        // The nameless F-keys leave only modifiers; the rest is text Chrome
        // does not show on the Mac.
        for unreadable in [
            "⌥",
            "⌘F12",
            "⌘F13",
            "⌘Tab",
            "⌘j",
            "⌘Page Down",
            "⌘⌦",
            "Command+Shift+J",
            "",
        ] {
            assert_eq!(parse_chrome_binding(unreadable), None, "{unreadable}");
        }
    }

    #[test]
    fn reads_back_every_key_it_sets() {
        let keys = ('A'..='Z')
            .chain('0'..='9')
            .map(String::from)
            .chain(KEY_TEXT.iter().map(|(k, _)| k.to_string()));
        for key in keys {
            for modifiers in ["Command", "MacCtrl+Shift", "Alt"] {
                let c = combo(&format!("{modifiers}+{key}"));
                if mac_limit(&c).is_some() {
                    assert!(NAMELESS_KEYS.contains(&c.key()), "{c}");
                    continue;
                }
                for text in [shortcut_text, right_to_left] {
                    let mut chrome = Fake::new(None, &[(NEXT, "")]);
                    chrome.text = text;
                    let binding = Binding::Combo(c.clone());
                    assert_eq!(set_hotkey(&mut chrome, NEXT, &binding), Ok(()), "{c}");
                }
            }
        }
    }

    #[test]
    fn plans_from_what_chrome_reports() {
        let settings = resolve(
            &file(
                "version: 1\ntabs:\n  layout: vertical\nhotkeys:\n  tab.next: Shift+Ctrl+J\n  tab.previous: \"\"\n",
            ),
            Platform::Mac,
        );
        let state = |pref: Option<bool>, next: &str, prev: &str| State {
            vertical_tabs: Ok(pref.map(Value::Bool)),
            duplicate_action: Ok(None),
            extensions: Ok(vec![ext(
                EXTENSION_ID,
                "Chromefile",
                &[(NEXT, next), (PREV, prev)],
            )]),
        };
        let report =
            |item: &str, outcome, detail: &str| Step::Report(Line::new(item, outcome, detail));

        // Equal after normalizing: Ctrl is Command on the Mac, any order.
        assert_eq!(
            plan(&settings, &state(Some(true), "⇧⌘J", "")),
            Plan {
                steps: vec![
                    report("tabs.layout", Outcome::Unchanged, "vertical"),
                    report("hotkeys.tab.next", Outcome::Unchanged, "Command+Shift+J"),
                    report("hotkeys.tab.previous", Outcome::Unchanged, "no hotkey"),
                ],
                order: vec![0, 1, 2]
            }
        );
        assert_eq!(
            plan(&settings, &state(Some(false), "⌘J", "⌘K")).steps,
            vec![
                Step::SetLayout {
                    item: "tabs.layout".into(),
                    layout: Layout::Vertical,
                    detail: "horizontal -> vertical".into()
                },
                Step::SetHotkey {
                    item: "hotkeys.tab.next".into(),
                    command: NEXT,
                    binding: Binding::Combo(combo("Ctrl+Shift+J")),
                    detail: "Command+J -> Command+Shift+J".into()
                },
                Step::SetHotkey {
                    item: "hotkeys.tab.previous".into(),
                    command: PREV,
                    binding: Binding::Clear,
                    detail: "Command+K -> no hotkey".into()
                },
            ]
        );
        // An inactive command has no hotkey, whatever text Chrome shows.
        let mut inactive = state(Some(true), "⇧⌘J", "⌘K");
        if let Ok(es) = &mut inactive.extensions {
            es[0].commands[1].active = false;
        }
        assert_eq!(
            plan(&settings, &inactive).steps[2],
            report("hotkeys.tab.previous", Outcome::Unchanged, "no hotkey")
        );
        // Text that can't be read is never taken for what the file wants.
        assert_eq!(
            plan(&settings, &state(Some(true), "⌥", "")).steps[1],
            Step::SetHotkey {
                item: "hotkeys.tab.next".into(),
                command: NEXT,
                binding: Binding::Combo(combo("Ctrl+Shift+J")),
                detail: "\"⌥\" -> Command+Shift+J".into()
            }
        );
    }

    #[test]
    fn plans_failures_and_unsupported_settings() {
        let settings = resolve(
            &file(
                "version: 1\ntabs:\n  layout: horizontal\n  duplicate:\n    action: ask\nhotkeys:\n  tab.next: Command+J\n",
            ),
            Platform::Mac,
        );
        let outcomes = |state: State| -> Vec<(Outcome, String)> {
            plan(&settings, &state)
                .steps
                .into_iter()
                .map(|s| match s {
                    Step::Report(l) => (l.outcome, l.detail),
                    other => panic!("unexpected {other:?}"),
                })
                .collect()
        };
        assert_eq!(
            outcomes(State {
                vertical_tabs: Ok(None),
                duplicate_action: Ok(None),
                extensions: Ok(vec![ext(OTHER, "Some Extension", &[])])
            }),
            vec![
                (
                    Outcome::Unsupported,
                    "this Chrome has no vertical_tabs.enabled setting".into()
                ),
                (
                    Outcome::Failed,
                    "the Chromefile extension did not answer on its apply page (not installed or \
                     out of date); run chromefile install"
                        .into()
                ),
                (
                    Outcome::Failed,
                    "the Chromefile extension is not installed; run chromefile install".into()
                ),
            ]
        );
        assert_eq!(
            outcomes(State {
                vertical_tabs: Ok(Some(json!(2))),
                duplicate_action: Ok(Some("sometimes".into())),
                extensions: Ok(vec![ext(EXTENSION_ID, "Chromefile", &[(PREV, "⌘K")])])
            }),
            vec![
                (
                    Outcome::Unsupported,
                    "Chrome's vertical_tabs.enabled is 2, not true or false".into()
                ),
                (
                    Outcome::Failed,
                    "the Chromefile extension reports duplicates as \"sometimes\", not none, ask \
                     or auto-close-duplicates (out of date?); run chromefile install"
                        .into()
                ),
                (
                    Outcome::Failed,
                    "the Chromefile extension reports no select-next-tab command (out of date or \
                     disabled?); run chromefile install"
                        .into()
                ),
            ]
        );
        let down = "Google Chrome is not running; start it first".to_string();
        assert_eq!(
            outcomes(State {
                vertical_tabs: Err(down.clone()),
                duplicate_action: Err(down.clone()),
                extensions: Err(down.clone())
            }),
            vec![
                (Outcome::Failed, down.clone()),
                (Outcome::Failed, down.clone()),
                (Outcome::Failed, down)
            ]
        );
    }

    #[test]
    fn fails_a_combination_another_extension_holds() {
        let src = "version: 1\nhotkeys:\n  tab.next: Ctrl+K\n  tab.previous: Command+J\n";
        let mut chrome = Fake::new(None, &[(NEXT, "Alt+J"), (PREV, "Alt+K")]);
        chrome.add(OTHER, "Some Extension", &[("do-thing", "Command+K")]);
        let want = vec![
            "hotkeys.tab.next: failed (Command+K is taken by \"Some Extension\" (do-thing); free \
             it first)",
            "hotkeys.tab.previous: changed (Alt+K -> Command+J)",
        ];
        assert_eq!(apply(src, &mut chrome, false), want);
        assert_eq!(
            chrome.setters(),
            vec!["setCommand select-previous-tab Command+J"]
        );
        assert_eq!(chrome.shown(OTHER, "do-thing"), "⌘K");
        assert_eq!(chrome.ours(NEXT), "⌥J");

        // A command that is not active holds nothing, whatever text it shows.
        let settings = resolve(&file(src), Platform::Mac);
        let mut idle = ext(OTHER, "Some Extension", &[("do-thing", "⌘K")]);
        idle.commands[0].active = false;
        let state = State {
            vertical_tabs: Ok(None),
            duplicate_action: Ok(None),
            extensions: Ok(vec![
                ext(EXTENSION_ID, "Chromefile", &[(NEXT, "⌥J"), (PREV, "⌥K")]),
                idle,
            ]),
        };
        assert!(matches!(
            plan(&settings, &state).steps[0],
            Step::SetHotkey { .. }
        ));
    }

    #[test]
    fn fails_a_combination_a_command_the_file_leaves_alone_holds() {
        let taken = "hotkeys.tab.next: failed (Command+K is taken by \"Chromefile\" \
                     (select-previous-tab); free it first)";
        let cases = [
            // tab.previous is not in the file.
            ("version: 1\nhotkeys:\n  tab.next: Command+K\n", vec![taken]),
            // It is, but has no value on the Mac.
            (
                "version: 1\nhotkeys:\n  tab.next: Command+K\n  tab.previous:\n    windows: Alt+K\n",
                vec![
                    taken,
                    "hotkeys.tab.previous: unchanged (the platform mapping has no value for mac \
                     and no default; left as it is)",
                ],
            ),
            // It is, but can't be set.
            (
                "version: 1\nhotkeys:\n  tab.next: Command+K\n  tab.previous: Command+Alt+L\n",
                vec![
                    taken,
                    "hotkeys.tab.previous: unsupported (Command+Alt+L: Chrome on macOS does not \
                     take Alt together with Command or MacCtrl in an extension shortcut)",
                ],
            ),
            // It is, but its own combination is taken, so it keeps Command+K.
            (
                "version: 1\nhotkeys:\n  tab.next: Command+K\n  tab.previous: Command+L\n",
                vec![
                    taken,
                    "hotkeys.tab.previous: failed (Command+L is taken by \"Some Extension\" \
                     (do-thing); free it first)",
                ],
            ),
        ];
        for (src, want) in cases {
            let mut chrome = Fake::new(None, &[(NEXT, "Alt+J"), (PREV, "Command+K")]);
            chrome.add(OTHER, "Some Extension", &[("do-thing", "Command+L")]);
            assert_eq!(apply(src, &mut chrome, false), want, "{src}");
            assert!(chrome.setters().is_empty(), "{src}");
            assert_eq!(
                (chrome.ours(NEXT), chrome.ours(PREV)),
                ("⌥J".into(), "⌘K".into())
            );
        }
        // Commands that are not actions count too.
        let mut chrome = Fake::new(None, &[(NEXT, "Alt+J"), ("_execute_action", "Alt+Shift+C")]);
        assert_eq!(
            apply(
                "version: 1\nhotkeys:\n  tab.next: Alt+Shift+C\n",
                &mut chrome,
                false
            ),
            vec![
                "hotkeys.tab.next: failed (Alt+Shift+C is taken by \"Chromefile\" \
                 (_execute_action); free it first)"
            ]
        );
    }

    #[test]
    fn swaps_hotkeys_within_the_file() {
        let src = "version: 1\nhotkeys:\n  tab.next: Command+K\n  tab.previous: Command+J\n";
        let mut chrome = Fake::new(
            None,
            &[
                (NEXT, "Command+J"),
                (PREV, "Command+K"),
                ("_execute_action", "Alt+Shift+C"),
            ],
        );
        chrome.add(OTHER, "Some Extension", &[("do-thing", "Command+L")]);
        assert_eq!(
            apply(src, &mut chrome, false),
            vec![
                "hotkeys.tab.next: changed (Command+J -> Command+K)",
                "hotkeys.tab.previous: changed (Command+K -> Command+J)",
            ]
        );
        // A cycle: the first in file order takes its combination over.
        assert_eq!(
            chrome.setters(),
            vec![
                "setCommand select-next-tab Command+K",
                "setCommand select-previous-tab Command+J"
            ]
        );
        assert_eq!(
            (chrome.ours(NEXT), chrome.ours(PREV)),
            ("⌘K".into(), "⌘J".into())
        );
        // Nothing else was touched.
        assert_eq!(chrome.ours("_execute_action"), "⌥⇧C");
        assert_eq!(chrome.shown(OTHER, "do-thing"), "⌘L");
        chrome.calls.clear();
        assert_eq!(
            apply(src, &mut chrome, false),
            vec![
                "hotkeys.tab.next: unchanged (Command+K)",
                "hotkeys.tab.previous: unchanged (Command+J)",
            ]
        );
        assert!(chrome.setters().is_empty());
    }

    #[test]
    fn sets_a_combination_after_the_command_that_lets_it_go() {
        for (prev, set_prev) in [("Command+L", "Command+L"), ("\"\"", "")] {
            let src =
                format!("version: 1\nhotkeys:\n  tab.next: Command+K\n  tab.previous: {prev}\n");
            let mut chrome = Fake::new(None, &[(NEXT, "Alt+J"), (PREV, "Command+K")]);
            let lines = apply(&src, &mut chrome, false);
            // Reported in file order, carried out the other way round.
            assert_eq!(lines[0], "hotkeys.tab.next: changed (Alt+J -> Command+K)");
            assert!(lines[1].starts_with("hotkeys.tab.previous: changed (Command+K -> "));
            assert_eq!(
                chrome.setters(),
                vec![
                    format!("setCommand select-previous-tab {set_prev}"),
                    "setCommand select-next-tab Command+K".to_string()
                ]
            );
        }
    }

    #[test]
    fn applies_and_reads_back() {
        let src = "version: 1\ntabs:\n  layout: vertical\n  duplicate:\n    action: ask\nhotkeys:\n  tab.next: Command+J\n  tab.previous: \"\"\n";
        let mut chrome = Fake::new(Some(false), &[(NEXT, "Alt+J"), (PREV, "Command+K")]);
        assert_eq!(
            apply(src, &mut chrome, false),
            vec![
                "tabs.layout: changed (horizontal -> vertical)",
                "tabs.duplicate.action: changed (none -> ask)",
                "hotkeys.tab.next: changed (Alt+J -> Command+J)",
                "hotkeys.tab.previous: changed (Command+K -> no hotkey)",
            ]
        );
        assert_eq!(
            chrome.setters(),
            vec![
                "setPref true",
                "setDuplicates ask",
                "setCommand select-next-tab Command+J",
                "setCommand select-previous-tab "
            ]
        );
        assert_eq!(chrome.stored_duplicates.as_deref(), Some("ask"));
        // Idempotent: the second run changes nothing.
        chrome.calls.clear();
        assert_eq!(
            apply(src, &mut chrome, false),
            vec![
                "tabs.layout: unchanged (vertical)",
                "tabs.duplicate.action: unchanged (ask)",
                "hotkeys.tab.next: unchanged (Command+J)",
                "hotkeys.tab.previous: unchanged (no hotkey)",
            ]
        );
        assert!(chrome.setters().is_empty());
    }

    #[test]
    fn dry_run_changes_nothing() {
        let src = "version: 1\ntabs:\n  layout: vertical\n  duplicate:\n    action: ask\nhotkeys:\n  tab.next: Ctrl+J\n  tab.previous: Command+K\n";
        let mut chrome = Fake::new(Some(false), &[(NEXT, "Alt+J"), (PREV, "Command+K")]);
        assert_eq!(
            apply(src, &mut chrome, true),
            vec![
                "tabs.layout: would change (horizontal -> vertical)",
                "tabs.duplicate.action: would change (none -> ask)",
                "hotkeys.tab.next: would change (Alt+J -> Command+J)",
                "hotkeys.tab.previous: unchanged (Command+K)",
            ]
        );
        assert!(chrome.setters().is_empty());
        assert_eq!(chrome.pref, Some(Value::Bool(false)));
        assert_eq!(chrome.stored_duplicates, None);
        assert_eq!(chrome.ours(NEXT), "⌥J");
    }

    fn duplicate_action(action: &str) -> String {
        format!("version: 1\ntabs:\n  duplicate:\n    action: {action}\n")
    }

    #[test]
    fn sets_the_extensions_duplicate_action() {
        let none = duplicate_action("none");
        let ask = duplicate_action("ask");
        let auto = duplicate_action("auto-close-duplicates");
        // The extension stores nothing until it is set, which reads as none.
        let mut chrome = Fake::new(None, &[]);
        assert_eq!(
            apply(&none, &mut chrome, false),
            vec!["tabs.duplicate.action: unchanged (none)"]
        );
        assert_eq!(check(&none, &mut chrome), 0);
        assert_eq!(check(&ask, &mut chrome), 2);
        assert!(chrome.setters().is_empty());
        assert_eq!(chrome.stored_duplicates, None);
        assert_eq!(
            apply(&ask, &mut chrome, false),
            vec!["tabs.duplicate.action: changed (none -> ask)"]
        );
        assert_eq!(chrome.setters(), vec!["setDuplicates ask"]);
        assert_eq!(chrome.stored_duplicates.as_deref(), Some("ask"));
        // Idempotent: the second run reads ask and sets nothing.
        chrome.calls.clear();
        assert_eq!(
            apply(&ask, &mut chrome, false),
            vec!["tabs.duplicate.action: unchanged (ask)"]
        );
        assert_eq!(check(&ask, &mut chrome), 0);
        assert!(chrome.setters().is_empty());
        // From asking to closing without asking. A dry run and --check only
        // report it.
        assert_eq!(
            apply(&auto, &mut chrome, true),
            vec!["tabs.duplicate.action: would change (ask -> auto-close-duplicates)"]
        );
        assert_eq!(check(&auto, &mut chrome), 2);
        assert!(chrome.setters().is_empty());
        assert_eq!(
            apply(&auto, &mut chrome, false),
            vec!["tabs.duplicate.action: changed (ask -> auto-close-duplicates)"]
        );
        assert_eq!(
            chrome.setters(),
            vec!["setDuplicates auto-close-duplicates"]
        );
        assert_eq!(
            chrome.stored_duplicates.as_deref(),
            Some("auto-close-duplicates")
        );
        chrome.calls.clear();
        assert_eq!(
            apply(&auto, &mut chrome, false),
            vec!["tabs.duplicate.action: unchanged (auto-close-duplicates)"]
        );
        assert_eq!(check(&auto, &mut chrome), 0);
        assert!(chrome.setters().is_empty());
        // none turns it off again, and is stored like the other values.
        assert_eq!(
            apply(&none, &mut chrome, false),
            vec!["tabs.duplicate.action: changed (auto-close-duplicates -> none)"]
        );
        assert_eq!(chrome.stored_duplicates.as_deref(), Some("none"));
    }

    #[test]
    fn leaves_the_duplicate_action_alone_off_the_mac() {
        for platform in [Platform::Windows, Platform::Linux, Platform::Other] {
            for action in DuplicateAction::ALL {
                let settings = resolve(&file(&duplicate_action(action.name())), platform);
                let mut chrome = Fake::new(None, &[]);
                let state = read_state(&settings, &mut chrome);
                let lines: Vec<String> = execute(&plan(&settings, &state), &mut chrome, false)
                    .iter()
                    .map(Line::to_string)
                    .collect();
                assert_eq!(
                    lines,
                    vec![
                        "tabs.duplicate.action: unsupported (chromefile apply changes Chrome on \
                         macOS only)"
                    ],
                    "{platform}"
                );
                assert!(chrome.calls.is_empty(), "{platform}: {:?}", chrome.calls);
            }
        }
    }

    #[test]
    fn reports_the_tabs_settings_in_section_order() {
        // The parser does not keep the order of the keys within tabs, so
        // section 5's order holds whatever the file's is.
        let src = "version: 1\ntabs:\n  duplicate:\n    action: auto-close-duplicates\n  layout: vertical\nhotkeys:\n  tab.next: Command+J\n";
        let mut chrome = Fake::new(Some(false), &[(NEXT, "Alt+J")]);
        assert_eq!(
            apply(src, &mut chrome, false),
            vec![
                "tabs.layout: changed (horizontal -> vertical)",
                "tabs.duplicate.action: changed (none -> auto-close-duplicates)",
                "hotkeys.tab.next: changed (Alt+J -> Command+J)",
            ]
        );
        assert_eq!(
            chrome.setters(),
            vec![
                "setPref true",
                "setDuplicates auto-close-duplicates",
                "setCommand select-next-tab Command+J"
            ]
        );
    }

    #[test]
    fn fails_a_duplicate_action_the_extension_does_not_take() {
        let ask = "version: 1\ntabs:\n  duplicate:\n    action: ask\n";
        // No extension, or one built before apply.html.
        let mut chrome = Fake::new(None, &[]);
        chrome.apply_page = false;
        assert_eq!(
            apply(ask, &mut chrome, false),
            vec![
                "tabs.duplicate.action: failed (the Chromefile extension did not answer on its apply \
                 page (not installed or out of date); run chromefile install)"
            ]
        );
        assert!(chrome.setters().is_empty());
        assert_eq!(check(ask, &mut chrome), 1);
        // The page refuses the write.
        let mut chrome = Fake::new(None, &[]);
        chrome.refuse_duplicates = Some("QUOTA_BYTES quota exceeded".into());
        assert_eq!(
            apply(ask, &mut chrome, false),
            vec!["tabs.duplicate.action: failed (QUOTA_BYTES quota exceeded)"]
        );
        assert_eq!(chrome.stored_duplicates, None);
        // The write is lost on the way, which only the read back shows.
        let mut chrome = Fake::new(None, &[]);
        chrome.accept_duplicates = false;
        assert_eq!(
            apply(ask, &mut chrome, false),
            vec![
                "tabs.duplicate.action: failed (set ask but the Chromefile extension reports none)"
            ]
        );
        assert_eq!(
            chrome.calls,
            vec!["getDuplicates", "setDuplicates ask", "getDuplicates"]
        );
        // A value that is not none, ask or auto-close-duplicates is not
        // overwritten blindly. An extension built for tabs.duplicates reports
        // allow when it stores nothing.
        for odd in ["allow", "sometimes"] {
            chrome.stored_duplicates = Some(odd.into());
            chrome.calls.clear();
            assert_eq!(
                apply(ask, &mut chrome, false),
                vec![format!(
                    "tabs.duplicate.action: failed (the Chromefile extension reports duplicates \
                     as {odd:?}, not none, ask or auto-close-duplicates (out of date?); run \
                     chromefile install)"
                )]
            );
            assert!(chrome.setters().is_empty());
        }
        // Chrome out of reach.
        assert_eq!(check(ask, &mut NotRunning), 1);
    }

    #[test]
    fn reads_the_apply_pages_replies() {
        assert_eq!(relay_reply(&json!({ "missing": true })).unwrap(), None);
        assert_eq!(
            relay_reply(&json!({ "id": "cf1-a", "ok": true, "value": "ask" })).unwrap(),
            Some("ask".into())
        );
        assert_eq!(
            relay_reply(&json!({ "id": "cf1-a", "ok": false, "error": "unknown key" }))
                .unwrap_err()
                .to_string(),
            "the Chromefile extension refused: unknown key"
        );
        for odd in [
            json!(null),
            json!("ask"),
            json!({ "ok": true }),
            json!({ "ok": true, "value": 1 }),
            json!({ "ok": false }),
            json!({ "missing": false }),
        ] {
            assert_eq!(
                relay_reply(&odd).unwrap_err().to_string(),
                format!("the Chromefile extension's apply page answered {odd}")
            );
        }
    }

    #[test]
    fn exit_status_reports_drift_only_when_checking() {
        use Outcome::{Changed, Failed, Unchanged, Unsupported, WouldChange};
        let status = |outcomes: &[Outcome], check| {
            let lines: Vec<Line> = outcomes.iter().map(|&o| Line::new("x", o, "")).collect();
            exit_status(&lines, check)
        };
        // In sync. An unsupported setting is not drift.
        assert_eq!(status(&[], true), 0);
        assert_eq!(status(&[Unchanged, Unchanged], true), 0);
        assert_eq!(status(&[Unsupported], true), 0);
        assert_eq!(status(&[Unchanged, Unsupported], true), 0);
        // Drift.
        assert_eq!(status(&[Unchanged, WouldChange], true), 2);
        assert_eq!(status(&[Unsupported, WouldChange], true), 2);
        // An error beats drift.
        assert_eq!(status(&[Failed], true), 1);
        assert_eq!(
            status(&[WouldChange, Failed, Unsupported, Unchanged], true),
            1
        );
        // Without --check, as before: only a failure is 1.
        assert_eq!(status(&[WouldChange, Unchanged], false), 0);
        assert_eq!(status(&[Changed, Unsupported], false), 0);
        assert_eq!(status(&[WouldChange, Failed], false), 1);
    }

    /// A Chrome that can't be reached, as when it is not running.
    struct NotRunning;

    impl Browser for NotRunning {
        fn vertical_tabs(&mut self) -> Result<Option<Value>> {
            bail!("Google Chrome is not running; start it first")
        }

        fn set_vertical_tabs(&mut self, _: bool) -> Result<bool> {
            unreachable!("a dry run sets nothing")
        }

        fn vertical_tabs_now(&mut self) -> Result<Value> {
            unreachable!("a dry run reads nothing back")
        }

        fn duplicate_action(&mut self) -> Result<Option<String>> {
            bail!("Google Chrome is not running; start it first")
        }

        fn set_duplicate_action(&mut self, _: &str) -> Result<()> {
            unreachable!("a dry run sets nothing")
        }

        fn extensions(&mut self) -> Result<Vec<ChromeExtension>> {
            bail!("Google Chrome is not running; start it first")
        }

        fn set_command(&mut self, _: &str, _: &str) -> Result<()> {
            unreachable!("a dry run sets nothing")
        }
    }

    /// What `--check` exits with for `src`.
    fn check(src: &str, chrome: &mut impl Browser) -> u8 {
        let settings = resolve(&file(src), Platform::Mac);
        let state = read_state(&settings, chrome);
        exit_status(&execute(&plan(&settings, &state), chrome, true), true)
    }

    #[test]
    fn check_compares_the_file_with_chrome_and_changes_nothing() {
        let src = "version: 1\ntabs:\n  layout: vertical\nhotkeys:\n  tab.next: Command+J\n";
        let mut chrome = Fake::new(Some(true), &[(NEXT, "Command+J")]);
        assert_eq!(check(src, &mut chrome), 0);
        let mut chrome = Fake::new(Some(false), &[(NEXT, "Command+J")]);
        assert_eq!(check(src, &mut chrome), 2);
        assert!(chrome.setters().is_empty());
        assert_eq!(chrome.pref, Some(Value::Bool(false)));
        // Only unsupported: in sync, and Chrome is not asked.
        let mut chrome = Fake::new(Some(false), &[(NEXT, "Command+J")]);
        assert_eq!(
            check(
                "version: 1\nhotkeys:\n  tab.next: Command+Alt+J\n",
                &mut chrome
            ),
            0
        );
        assert!(chrome.calls.is_empty(), "{:?}", chrome.calls);
        // A setting that would fail is an error, whatever else would change.
        let mut chrome = Fake::new(Some(false), &[]);
        assert_eq!(check(src, &mut chrome), 1);
        // So is a Chrome that can't be reached.
        assert_eq!(check(src, &mut NotRunning), 1);
    }

    #[test]
    fn a_value_that_does_not_read_back_fails() {
        let mut chrome = Fake::new(Some(true), &[(NEXT, "Alt+J")]);
        chrome.accept_pref = false;
        assert_eq!(
            apply(
                "version: 1\ntabs:\n  layout: horizontal\n",
                &mut chrome,
                false
            ),
            vec![
                "tabs.layout: failed (Chrome did not change vertical_tabs.enabled; a policy may \
                 manage it)"
            ]
        );
        // A shortcut Chrome refuses leaves the command with none (facts A
        // and C), which is why resolve never sends one. If one got through,
        // the read back would catch it.
        assert_eq!(
            set_hotkey(&mut chrome, NEXT, &Binding::Combo(combo("Command+Alt+J"))),
            Err("set Command+Alt+J but Chrome reports no hotkey".into())
        );
        assert_eq!(chrome.ours(NEXT), "");
        // So would text apply can't read.
        chrome.text = |a| format!("{}?", shortcut_text(a));
        assert_eq!(
            set_hotkey(&mut chrome, NEXT, &Binding::Combo(combo("Command+J"))),
            Err("set Command+J but Chrome reports \"⌘J?\"".into())
        );
    }

    #[test]
    fn reads_only_what_the_file_needs() {
        let mut chrome = Fake::new(Some(true), &[(NEXT, "Command+J")]);
        assert!(apply("version: 1\n", &mut chrome, false).is_empty());
        apply(
            "version: 1\nhotkeys:\n  tab.next:\n    windows: Alt+J\n  tab.previous: Command+Alt+K\n",
            &mut chrome,
            false,
        );
        assert!(chrome.calls.is_empty(), "{:?}", chrome.calls);
        apply(
            "version: 1\ntabs:\n  layout: vertical\n",
            &mut chrome,
            false,
        );
        assert_eq!(chrome.calls, vec!["getAllPrefs"]);
        // Values that already match are still read.
        chrome.calls.clear();
        apply(
            "version: 1\nhotkeys:\n  tab.next: Command+J\n",
            &mut chrome,
            false,
        );
        assert_eq!(chrome.calls, vec!["getExtensionsInfo"]);
        chrome.calls.clear();
        apply(
            "version: 1\ntabs:\n  duplicate:\n    action: none\n",
            &mut chrome,
            false,
        );
        assert_eq!(chrome.calls, vec!["getDuplicates"]);
    }

    #[test]
    fn warns_about_built_in_shortcuts_on_the_mac() {
        for (s, _) in MAC_BUILTINS {
            assert!(
                Combo::parse(s).is_ok_and(|c| mac_limit(&c).is_none()),
                "{s}"
            );
        }
        let f = file(
            "version: 1\nhotkeys:\n  tab.next: Ctrl+Y\n  tab.previous:\n    mac: MacCtrl+T\n    default: Ctrl+T\n",
        );
        assert_eq!(
            shadow_warnings(&f),
            vec!["hotkeys.tab.next: Command+Y replaces Chrome's built-in shortcut for History"]
        );
        assert!(shadow_warnings(&file("version: 1\nhotkeys:\n  tab.next: Alt+J\n")).is_empty());
        // Plain Command+J is free on the Mac (Downloads is Command+Shift+J).
        assert!(shadow_warnings(&file("version: 1\nhotkeys:\n  tab.next: Command+J\n")).is_empty());
    }
}
