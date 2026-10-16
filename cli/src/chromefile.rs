//! The Chromefile format, specification version 1 (SPEC.md sections 3 to 6
//! and 8): parses a file and validates all of it, collecting every error.
//! Nothing here touches a browser or depends on the OS, so it is tested on
//! every platform CI runs on.

use std::fmt;
use yaml_rust2::parser::{MarkedEventReceiver, Parser};
use yaml_rust2::scanner::Marker;
use yaml_rust2::{Event, Yaml, YamlLoader};

/// The specification versions this tool implements (SPEC.md section 8).
pub const SUPPORTED_VERSIONS: &[i64] = &[1];

/// `tabs.layout` (section 5.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Layout {
    Vertical,
    Horizontal,
}

impl Layout {
    pub fn name(self) -> &'static str {
        match self {
            Layout::Vertical => "vertical",
            Layout::Horizontal => "horizontal",
        }
    }
}

/// `tabs.duplicate.action` (section 5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplicateAction {
    /// `none`; a variant called None would read as Option's.
    Nothing,
    Ask,
    AutoClose,
}

impl DuplicateAction {
    pub const ALL: [DuplicateAction; 3] = [
        DuplicateAction::Nothing,
        DuplicateAction::Ask,
        DuplicateAction::AutoClose,
    ];

    pub fn name(self) -> &'static str {
        match self {
            DuplicateAction::Nothing => "none",
            DuplicateAction::Ask => "ask",
            DuplicateAction::AutoClose => "auto-close-duplicates",
        }
    }

    pub fn from_name(name: &str) -> Option<DuplicateAction> {
        DuplicateAction::ALL.into_iter().find(|a| a.name() == name)
    }
}

/// The action registry (section 6.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    TabNext,
    TabPrevious,
}

impl Action {
    pub const ALL: [Action; 2] = [Action::TabNext, Action::TabPrevious];

    pub fn name(self) -> &'static str {
        match self {
            Action::TabNext => "tab.next",
            Action::TabPrevious => "tab.previous",
        }
    }

    fn from_name(name: &str) -> Option<Action> {
        Action::ALL.into_iter().find(|a| a.name() == name)
    }
}

/// Declared in the order the specification displays them (section 6.2, rule
/// 4), so sorting puts them in that order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Modifier {
    Command,
    Ctrl,
    MacCtrl,
    Alt,
    Shift,
}

impl Modifier {
    const ALL: [Modifier; 5] = [
        Modifier::Command,
        Modifier::Ctrl,
        Modifier::MacCtrl,
        Modifier::Alt,
        Modifier::Shift,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Modifier::Command => "Command",
            Modifier::Ctrl => "Ctrl",
            Modifier::MacCtrl => "MacCtrl",
            Modifier::Alt => "Alt",
            Modifier::Shift => "Shift",
        }
    }
}

/// Key names besides A to Z and 0 to 9 (section 6.2).
const NAMED_KEYS: [&str; 25] = [
    "Comma", "Period", "Home", "End", "PageUp", "PageDown", "Space", "Insert", "Delete", "Up",
    "Down", "Left", "Right", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11",
    "F12",
];

fn is_key(key: &str) -> bool {
    matches!(key.as_bytes(), [b'A'..=b'Z' | b'0'..=b'9']) || NAMED_KEYS.contains(&key)
}

/// A key combination (section 6.2): a set of modifiers, kept in display
/// order, and one key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    modifiers: Vec<Modifier>,
    key: String,
}

impl Combo {
    /// Builds a combination from parts that are already known to be valid
    /// names, in any order.
    pub fn new(mut modifiers: Vec<Modifier>, key: impl Into<String>) -> Combo {
        modifiers.sort();
        modifiers.dedup();
        Combo {
            modifiers,
            key: key.into(),
        }
    }

    /// Parses a combination written as the grammar of section 6.2 says, with
    /// its additional rules. The empty string is not a combination; see
    /// `Binding`. The error says what is wrong.
    pub fn parse(s: &str) -> Result<Combo, String> {
        if s.chars().any(char::is_whitespace) {
            return Err(
                "it contains a space; write it without spaces, like Command+Shift+J".into(),
            );
        }
        let mut parts: Vec<&str> = s.split('+').collect();
        let key = parts.pop().unwrap_or_default();
        if parts.is_empty() {
            return Err(format!(
                "it has no modifier; put Command, Ctrl, Alt or MacCtrl before the key, like Command+{key}"
            ));
        }
        if key.is_empty() || parts.iter().any(|p| p.is_empty()) {
            return Err("it has an empty name (two + in a row, or a + at the start or end)".into());
        }
        if parts.len() > 4 {
            return Err(format!(
                "it has {} modifiers; at most 4 are allowed",
                parts.len()
            ));
        }
        let mut modifiers = Vec::new();
        for part in parts {
            let m = Modifier::ALL
                .into_iter()
                .find(|m| m.name() == part)
                .ok_or_else(|| unknown_modifier(part))?;
            if modifiers.contains(&m) {
                return Err(format!("{} appears more than once", m.name()));
            }
            modifiers.push(m);
        }
        if modifiers.contains(&Modifier::Command) && modifiers.contains(&Modifier::Ctrl) {
            return Err("it combines Command and Ctrl, which are the same key on macOS".into());
        }
        if modifiers.iter().all(|m| *m == Modifier::Shift) {
            return Err("Shift alone is not enough; add Command, Ctrl, Alt or MacCtrl".into());
        }
        if !is_key(key) {
            return Err(unknown_key(key));
        }
        Ok(Combo::new(modifiers, key))
    }

    /// The form combinations are compared in (section 6): Command counts as
    /// Ctrl and modifier order does not matter.
    pub fn normalized(&self) -> Combo {
        self.replacing(Modifier::Command, Modifier::Ctrl)
    }

    /// What the combination is on macOS, where Ctrl means Command (section
    /// 6.2), so only Command, MacCtrl, Alt and Shift remain.
    pub fn on_mac(&self) -> Combo {
        self.replacing(Modifier::Ctrl, Modifier::Command)
    }

    /// In display order.
    pub fn modifiers(&self) -> &[Modifier] {
        &self.modifiers
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    fn replacing(&self, from: Modifier, to: Modifier) -> Combo {
        let modifiers = self
            .modifiers
            .iter()
            .map(|&m| if m == from { to } else { m })
            .collect();
        Combo::new(modifiers, self.key.clone())
    }
}

impl fmt::Display for Combo {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for m in &self.modifiers {
            write!(f, "{}+", m.name())?;
        }
        f.write_str(&self.key)
    }
}

fn unknown_modifier(name: &str) -> String {
    match Modifier::ALL
        .into_iter()
        .find(|m| m.name().eq_ignore_ascii_case(name))
    {
        Some(m) => format!(
            "unknown modifier {name:?} (names are case-sensitive: {})",
            m.name()
        ),
        None => format!("unknown modifier {name:?} (use Command, Ctrl, Alt, Shift or MacCtrl)"),
    }
}

fn unknown_key(key: &str) -> String {
    let upper = key.to_ascii_uppercase();
    let fixed = if is_key(&upper) {
        Some(upper)
    } else {
        NAMED_KEYS
            .iter()
            .find(|k| k.eq_ignore_ascii_case(key))
            .map(|k| k.to_string())
    };
    match fixed {
        Some(k) => format!("unknown key {key:?} (key names are case-sensitive: {k})"),
        None => format!(
            "unknown key {key:?} (use A to Z, 0 to 9, Comma, Period, Home, End, PageUp, PageDown, \
             Space, Insert, Delete, Up, Down, Left, Right or F1 to F12)"
        ),
    }
}

/// What a hotkey says for one platform.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Binding {
    /// `""`: the action has no hotkey.
    Clear,
    Combo(Combo),
}

impl Binding {
    fn parse(s: &str) -> Result<Binding, String> {
        if s.is_empty() {
            Ok(Binding::Clear)
        } else {
            Combo::parse(s).map(Binding::Combo)
        }
    }
}

/// The platforms of section 6.3. `Other` stands for every platform without
/// a key of its own; only `default` (or a plain combination) applies there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Mac,
    Windows,
    Linux,
    Other,
}

impl Platform {
    pub const ALL: [Platform; 4] = [
        Platform::Mac,
        Platform::Windows,
        Platform::Linux,
        Platform::Other,
    ];

    pub fn current() -> Platform {
        match std::env::consts::OS {
            "macos" => Platform::Mac,
            "windows" => Platform::Windows,
            "linux" => Platform::Linux,
            _ => Platform::Other,
        }
    }
}

impl fmt::Display for Platform {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Platform::Mac => "mac",
            Platform::Windows => "windows",
            Platform::Linux => "linux",
            Platform::Other => "other platforms",
        })
    }
}

/// A hotkey: one binding for every platform, or a platform mapping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Hotkey {
    Everywhere(Binding),
    PerPlatform {
        mac: Option<Binding>,
        windows: Option<Binding>,
        linux: Option<Binding>,
        default: Option<Binding>,
    },
}

impl Hotkey {
    /// The binding that applies on `platform`; None when a platform mapping
    /// lists neither it nor `default`, which means "leave it as it is".
    pub fn resolve(&self, platform: Platform) -> Option<&Binding> {
        match self {
            Hotkey::Everywhere(b) => Some(b),
            Hotkey::PerPlatform {
                mac,
                windows,
                linux,
                default,
            } => {
                let own = match platform {
                    Platform::Mac => mac,
                    Platform::Windows => windows,
                    Platform::Linux => linux,
                    Platform::Other => &None,
                };
                own.as_ref().or(default.as_ref())
            }
        }
    }
}

/// A valid Chromefile. Settings absent from the file are None or missing.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Chromefile {
    pub layout: Option<Layout>,
    pub duplicate_action: Option<DuplicateAction>,
    /// In file order.
    pub hotkeys: Vec<(Action, Hotkey)>,
}

/// Parses and validates a whole Chromefile. On failure returns every error
/// found, each naming the path of the value (such as `hotkeys.tab.next`), or
/// a line and column for YAML syntax errors.
pub fn parse(src: &str) -> Result<Chromefile, Vec<String>> {
    let doc = load(src).map_err(|e| vec![e])?;
    validate(&doc)
}

// YAML -------------------------------------------------------------------------

fn at(m: &Marker) -> String {
    format!("line {}, column {}", m.line(), m.col() + 1)
}

/// Loads the one YAML document of a file. yaml-rust2 resolves plain scalars
/// with the YAML 1.2 core schema (so `yes` and `on` are strings, and an
/// empty value is null, not "") and rejects duplicate keys itself, giving a
/// line and column (section 7.3).
fn load(src: &str) -> Result<Yaml, String> {
    // A YAML stream may start with a byte order mark; the scanner would read
    // it as part of the first key.
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let mut docs = YamlLoader::load_from_str(src)
        .map_err(|e| format!("not valid YAML at {}: {}", at(e.marker()), plain(e.info())))?;
    check_tags(src)?;
    match docs.len() {
        1 => Ok(docs.remove(0)),
        0 => Err("the file holds no YAML document; it needs at least version: 1".into()),
        n => Err(format!(
            "the file holds {n} YAML documents (separated by ---); a Chromefile holds exactly one"
        )),
    }
}

/// yaml-rust2 names a duplicated key in Rust notation, as in
/// `String("tab.next"): duplicated key in mapping`; this says it the way the
/// file does. Other messages pass through as they are.
fn plain(info: &str) -> String {
    match info.strip_suffix(": duplicated key in mapping") {
        Some(key) => {
            let key = key
                .strip_prefix("String(")
                .and_then(|k| k.strip_suffix(')'))
                .unwrap_or(key);
            format!("the key {key} appears twice in the same mapping")
        }
        None => info.to_string(),
    }
}

/// The YAML 1.2 core schema's tags, written `!!str` and so on.
const CORE_TAGS: [&str; 7] = ["str", "int", "float", "bool", "null", "map", "seq"];

/// yaml-rust2 drops tags it does not know, so `!foo Alt+J` would load as the
/// string "Alt+J". YAML 1.2 can't complete a node with an unknown tag, so
/// such a file is refused rather than read as something it does not say.
fn check_tags(src: &str) -> Result<(), String> {
    struct Tags(Option<String>);
    impl MarkedEventReceiver for Tags {
        fn on_event(&mut self, ev: Event, mark: Marker) {
            let (Event::Scalar(.., Some(tag))
            | Event::SequenceStart(_, Some(tag))
            | Event::MappingStart(_, Some(tag))) = ev
            else {
                return;
            };
            let core = tag.handle == "tag:yaml.org,2002:" && CORE_TAGS.contains(&&*tag.suffix);
            if !core && self.0.is_none() {
                self.0 = Some(format!(
                    "the YAML tag {}{} at {} is not supported; a Chromefile uses plain values",
                    tag.handle,
                    tag.suffix,
                    at(&mark)
                ));
            }
        }
    }
    let mut tags = Tags(None);
    // The source has loaded already, so it parses.
    let _ = Parser::new_from_str(src).load(&mut tags, true);
    tags.0.map_or(Ok(()), Err)
}

// Validation -------------------------------------------------------------------

fn key_str(k: &Yaml) -> Option<&str> {
    match k {
        Yaml::String(s) => Some(s),
        _ => None,
    }
}

/// A key as it appears in a path, also when it is not a string.
fn key_name(k: &Yaml) -> String {
    match k {
        Yaml::String(s) | Yaml::Real(s) => s.clone(),
        Yaml::Integer(i) => i.to_string(),
        Yaml::Boolean(b) => b.to_string(),
        Yaml::Null => "null".into(),
        _ => "(complex key)".into(),
    }
}

/// A value as an error message shows it.
fn describe(v: &Yaml) -> String {
    match v {
        Yaml::String(s) => format!("{s:?}"),
        Yaml::Null => "empty (null)".into(),
        Yaml::Boolean(b) => format!("the boolean {b}"),
        Yaml::Integer(i) => format!("the integer {i}"),
        Yaml::Real(f) => format!("the number {f}"),
        Yaml::Hash(_) => "a mapping".into(),
        Yaml::Array(_) => "a list".into(),
        Yaml::Alias(_) | Yaml::BadValue => "a value that can't be read".into(),
    }
}

fn validate(doc: &Yaml) -> Result<Chromefile, Vec<String>> {
    let Yaml::Hash(top) = doc else {
        return Err(vec![format!(
            "the top level must be a mapping (key: value lines), not {}",
            describe(doc)
        )]);
    };
    let mut errors = Vec::new();

    // The version decides which rules apply, so an unsupported one is the
    // only thing worth reporting (section 4). A missing or non-integer
    // version is reported along with everything else.
    let supported = SUPPORTED_VERSIONS
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    match top.iter().find(|(k, _)| key_str(k) == Some("version")) {
        None => errors.push(format!(
            "version: missing; add version: 1 (this tool supports version {supported})"
        )),
        Some((_, Yaml::Integer(n))) if SUPPORTED_VERSIONS.contains(n) => {}
        Some((_, Yaml::Integer(n))) => {
            return Err(vec![format!(
                "version: {n} is not supported (this tool supports version {supported})"
            )]);
        }
        Some((_, v)) => errors.push(format!("version: must be an integer, not {}", describe(v))),
    }

    let mut file = Chromefile::default();
    for (k, v) in top {
        match key_str(k) {
            Some("version") => {}
            Some("tabs") => tabs(v, &mut file, &mut errors),
            Some("hotkeys") => file.hotkeys = hotkeys(v, &mut errors),
            _ => errors.push(format!(
                "{}: unknown key (allowed: version, tabs, hotkeys)",
                key_name(k)
            )),
        }
    }
    errors.extend(collisions(&file.hotkeys));
    if errors.is_empty() {
        Ok(file)
    } else {
        Err(errors)
    }
}

fn tabs(v: &Yaml, file: &mut Chromefile, errors: &mut Vec<String>) {
    let Yaml::Hash(m) = v else {
        errors.push(format!("tabs: must be a mapping, not {}", describe(v)));
        return;
    };
    for (k, v) in m {
        match (key_str(k), key_str(v)) {
            (Some("layout"), Some("vertical")) => file.layout = Some(Layout::Vertical),
            (Some("layout"), Some("horizontal")) => file.layout = Some(Layout::Horizontal),
            (Some("layout"), _) => errors.push(format!(
                "tabs.layout: must be vertical or horizontal, not {}",
                describe(v)
            )),
            (Some("duplicate"), _) => duplicate(v, file, errors),
            _ => errors.push(format!(
                "tabs.{}: unknown key (allowed: layout, duplicate)",
                key_name(k)
            )),
        }
    }
}

fn duplicate(v: &Yaml, file: &mut Chromefile, errors: &mut Vec<String>) {
    let Yaml::Hash(m) = v else {
        errors.push(format!(
            "tabs.duplicate: must be a mapping, not {}",
            describe(v)
        ));
        return;
    };
    for (k, v) in m {
        match key_str(k) {
            Some("action") => match key_str(v).and_then(DuplicateAction::from_name) {
                Some(action) => file.duplicate_action = Some(action),
                None => errors.push(format!(
                    "tabs.duplicate.action: must be none, ask or auto-close-duplicates, not {}",
                    describe(v)
                )),
            },
            _ => errors.push(format!(
                "tabs.duplicate.{}: unknown key (allowed: action)",
                key_name(k)
            )),
        }
    }
}

fn hotkeys(v: &Yaml, errors: &mut Vec<String>) -> Vec<(Action, Hotkey)> {
    let Yaml::Hash(m) = v else {
        errors.push(format!("hotkeys: must be a mapping, not {}", describe(v)));
        return Vec::new();
    };
    let allowed = Action::ALL.map(Action::name).join(", ");
    let mut out = Vec::new();
    for (k, v) in m {
        let path = format!("hotkeys.{}", key_name(k));
        let Some(action) = key_str(k).and_then(Action::from_name) else {
            errors.push(format!("{path}: unknown action (allowed: {allowed})"));
            continue;
        };
        if let Some(h) = hotkey(&path, v, errors) {
            out.push((action, h));
        }
    }
    out
}

fn hotkey(path: &str, v: &Yaml, errors: &mut Vec<String>) -> Option<Hotkey> {
    match v {
        Yaml::String(s) => binding(path, s, errors).map(Hotkey::Everywhere),
        Yaml::Hash(m) if m.is_empty() => {
            errors.push(format!(
                "{path}: a platform mapping needs at least one of mac, windows, linux, default"
            ));
            None
        }
        Yaml::Hash(m) => {
            let (mut mac, mut windows, mut linux, mut default) = (None, None, None, None);
            let mut ok = true;
            for (k, v) in m {
                let path = format!("{path}.{}", key_name(k));
                let slot = match key_str(k) {
                    Some("mac") => &mut mac,
                    Some("windows") => &mut windows,
                    Some("linux") => &mut linux,
                    Some("default") => &mut default,
                    _ => {
                        errors.push(format!(
                            "{path}: unknown platform (allowed: mac, windows, linux, default)"
                        ));
                        ok = false;
                        continue;
                    }
                };
                let parsed = match v {
                    Yaml::String(s) => binding(&path, s, errors),
                    _ => {
                        errors.push(format!(
                            "{path}: must be a key combination, not {}",
                            describe(v)
                        ));
                        None
                    }
                };
                ok &= parsed.is_some();
                *slot = parsed;
            }
            ok.then_some(Hotkey::PerPlatform {
                mac,
                windows,
                linux,
                default,
            })
        }
        _ => {
            errors.push(format!(
                "{path}: must be a key combination or a platform mapping, not {}",
                describe(v)
            ));
            None
        }
    }
}

fn binding(path: &str, s: &str, errors: &mut Vec<String>) -> Option<Binding> {
    Binding::parse(s)
        .map_err(|why| {
            errors.push(format!(
                "{path}: {s:?} is not a valid key combination: {why}"
            ))
        })
        .ok()
}

fn join_platforms(ps: &[Platform]) -> String {
    let names: Vec<String> = ps.iter().map(Platform::to_string).collect();
    match names.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        _ => names.join(""),
    }
}

/// The rule of section 6 that no two actions resolve to the same
/// combination on the same platform, checked on every platform, including
/// those that only `default` covers.
fn collisions(hotkeys: &[(Action, Hotkey)]) -> Vec<String> {
    // (earlier action, later action, earlier combo, later combo) and the
    // platforms where they collide, so each pair is reported once.
    type Pair = (usize, usize, String, String);
    let mut found: Vec<(Pair, Vec<Platform>)> = Vec::new();
    for platform in Platform::ALL {
        let resolved: Vec<(usize, &Combo)> = hotkeys
            .iter()
            .enumerate()
            .filter_map(|(i, (_, h))| match h.resolve(platform)? {
                Binding::Combo(c) => Some((i, c)),
                Binding::Clear => None,
            })
            .collect();
        for (n, (i, a)) in resolved.iter().enumerate() {
            for (j, b) in &resolved[n + 1..] {
                if a.normalized() != b.normalized() {
                    continue;
                }
                let pair = (*i, *j, a.to_string(), b.to_string());
                match found.iter_mut().find(|(p, _)| *p == pair) {
                    Some((_, platforms)) => platforms.push(platform),
                    None => found.push((pair, vec![platform])),
                }
            }
        }
    }
    found
        .into_iter()
        .map(|((i, j, a, b), platforms)| {
            let same = if a == b {
                ""
            } else {
                " (Command and Ctrl count as the same key)"
            };
            format!(
                "hotkeys.{}: {b} collides with hotkeys.{} ({a}) on {}{same}; two actions can't share a key combination",
                hotkeys[j].0.name(),
                hotkeys[i].0.name(),
                join_platforms(&platforms)
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn errors(src: &str) -> Vec<String> {
        parse(src).expect_err("should be invalid")
    }

    fn one_error(src: &str) -> String {
        let e = errors(src);
        assert_eq!(e.len(), 1, "expected one error, got {e:?}");
        e[0].clone()
    }

    fn combo(s: &str) -> Combo {
        Combo::parse(s).unwrap()
    }

    fn yaml_files(dir: &str) -> Vec<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests")
            .join(dir);
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "yaml"))
            .collect();
        files.sort();
        assert!(!files.is_empty(), "no fixtures in {}", dir.display());
        files
    }

    #[test]
    fn accepts_every_valid_fixture_and_the_example() {
        let mut files = yaml_files("valid");
        // validate.yml checks the repository's example Chromefile too.
        files.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("../Chromefile"));
        for f in files {
            let src = std::fs::read_to_string(&f).unwrap();
            if let Err(e) = parse(&src) {
                panic!("{} should be valid: {e:?}", f.display());
            }
        }
    }

    #[test]
    fn rejects_every_invalid_fixture_naming_the_path() {
        for f in yaml_files("invalid") {
            let src = std::fs::read_to_string(&f).unwrap();
            let name = f.file_stem().unwrap().to_str().unwrap();
            let e = match parse(&src) {
                Ok(_) => panic!("{name} should be invalid"),
                Err(e) => e.join("\n"),
            };
            // Fixtures added later only have to be rejected.
            let want = match name {
                "bad-duplicate-action" => "tabs.duplicate.action:",
                "bad-layout" => "tabs.layout:",
                "command-and-ctrl"
                | "empty-platform-mapping"
                | "lowercase-key"
                | "no-modifier"
                | "repeated-modifier"
                | "shift-only-combo" => "hotkeys.tab.next: ",
                "duplicate-key" => "the key \"tab.next\" appears twice",
                "missing-version" => "version: missing",
                "old-duplicates-key" => "tabs.duplicates: unknown key",
                "unknown-action" => "hotkeys.tab.close: unknown action",
                "unknown-duplicate-key" => "tabs.duplicate.when: unknown key",
                "unknown-platform" => "hotkeys.tab.next.chromeos: unknown platform",
                "unknown-tabs-key" => "tabs.side: unknown key",
                "unknown-top-level-key" => "bookmarks: unknown key",
                "version-2" => "version: 2 is not supported",
                _ => "",
            };
            assert!(e.contains(want), "{name}: {e:?} should contain {want:?}");
        }
    }

    #[test]
    fn parses_the_example() {
        let f = parse(
            "version: 1\ntabs:\n  layout: vertical\n  duplicate:\n    action: ask\nhotkeys:\n  tab.next: Command+J\n  tab.previous: Command+K\n",
        )
        .unwrap();
        assert_eq!(f.layout, Some(Layout::Vertical));
        assert_eq!(f.duplicate_action, Some(DuplicateAction::Ask));
        assert_eq!(
            f.hotkeys,
            vec![
                (
                    Action::TabNext,
                    Hotkey::Everywhere(Binding::Combo(combo("Command+J")))
                ),
                (
                    Action::TabPrevious,
                    Hotkey::Everywhere(Binding::Combo(combo("Command+K")))
                ),
            ]
        );
        assert_eq!(parse("version: 1\n").unwrap(), Chromefile::default());
    }

    // (a) Duplicate keys are an error (section 7.3), placed by line and
    // column.
    #[test]
    fn rejects_duplicate_keys() {
        assert_eq!(
            one_error(
                "version: 1\nhotkeys:\n  tab.next: Command+J\n  tab.previous: Command+K\n  tab.next: Alt+J\n"
            ),
            "not valid YAML at line 5, column 13: the key \"tab.next\" appears twice in the same mapping"
        );
        assert_eq!(
            one_error("version: 1\nversion: 1\n"),
            "not valid YAML at line 2, column 10: the key \"version\" appears twice in the same mapping"
        );
        // Quoting does not make it another key.
        assert!(
            one_error("version: 1\n\"version\": 1\n").contains("the key \"version\" appears twice")
        );
        assert!(
            one_error("version: 1\nhotkeys: {tab.next: Alt+J, tab.next: Alt+K}\n")
                .contains("the key \"tab.next\" appears twice")
        );
        // Also where nothing else would look.
        assert!(
            one_error("version: 1\nbookmarks:\n  - {a: 1, a: 2}\n")
                .contains("the key \"a\" appears twice")
        );
    }

    // (b) YAML 1.2: yes, no, on, off and y are strings, not booleans.
    #[test]
    fn reads_yes_no_on_off_as_strings() {
        let doc = load("a: yes\nb: no\nc: on\nd: off\ne: y\nf: true\n").unwrap();
        let Yaml::Hash(m) = doc else {
            panic!("not a mapping")
        };
        let values: Vec<&Yaml> = m.values().collect();
        for (v, want) in values.iter().zip(["yes", "no", "on", "off", "y"]) {
            assert_eq!(key_str(v), Some(want));
        }
        assert_eq!(values[5], &Yaml::Boolean(true));
        // So they fail as combinations, not as booleans.
        assert!(
            one_error("version: 1\nhotkeys:\n  tab.next: yes\n")
                .contains("\"yes\" is not a valid key combination")
        );
        assert_eq!(
            one_error("version: 1\ntabs:\n  layout: on\n"),
            "tabs.layout: must be vertical or horizontal, not \"on\""
        );
    }

    // (c) Exactly one document.
    #[test]
    fn rejects_more_than_one_document() {
        let two =
            "the file holds 2 YAML documents (separated by ---); a Chromefile holds exactly one";
        assert_eq!(one_error("version: 1\n---\nversion: 1\n"), two);
        assert_eq!(one_error("version: 1\n---\n"), two);
        assert!(one_error("").contains("no YAML document"));
        assert!(one_error("# just a comment\n").contains("no YAML document"));
        assert!(parse("---\nversion: 1\n...\n").is_ok());
    }

    // (d) An empty value is null, not the empty string.
    #[test]
    fn empty_value_is_not_the_empty_string() {
        assert_eq!(
            one_error("version: 1\nhotkeys:\n  tab.next:\n"),
            "hotkeys.tab.next: must be a key combination or a platform mapping, not empty (null)"
        );
        assert_eq!(
            one_error("version: 1\nhotkeys:\n  tab.next:\n    mac:\n"),
            "hotkeys.tab.next.mac: must be a key combination, not empty (null)"
        );
        let f = parse("version: 1\nhotkeys:\n  tab.next: \"\"\n  tab.previous: ''\n").unwrap();
        assert_eq!(
            f.hotkeys,
            vec![
                (Action::TabNext, Hotkey::Everywhere(Binding::Clear)),
                (Action::TabPrevious, Hotkey::Everywhere(Binding::Clear)),
            ]
        );
    }

    #[test]
    fn reports_yaml_syntax_errors_by_position() {
        assert!(one_error("version: 1\nhotkeys: [a\n").starts_with("not valid YAML at line 3"));
    }

    #[test]
    fn accepts_a_byte_order_mark() {
        assert!(parse("\u{feff}version: 1\n").is_ok());
    }

    #[test]
    fn checks_the_version() {
        assert_eq!(
            one_error("- version: 1\n"),
            "the top level must be a mapping (key: value lines), not a list"
        );
        assert_eq!(
            one_error("version: \"1\"\n"),
            "version: must be an integer, not \"1\""
        );
        assert_eq!(
            one_error("version: 1.0\n"),
            "version: must be an integer, not the number 1.0"
        );
        // An unknown version makes the rest meaningless, so it is all that
        // is reported.
        assert_eq!(
            errors("version: 2\ntabs:\n  side: left\nbookmarks: []\n"),
            vec!["version: 2 is not supported (this tool supports version 1)"]
        );
        // A missing one is reported with the rest.
        assert_eq!(
            errors("tabs:\n  side: left\n"),
            vec![
                "version: missing; add version: 1 (this tool supports version 1)",
                "tabs.side: unknown key (allowed: layout, duplicate)",
            ]
        );
    }

    #[test]
    fn rejects_unknown_keys_at_every_level() {
        assert_eq!(
            errors(
                "version: 1\n1: x\ntabs:\n  layout: diagonal\n  side: left\nhotkeys:\n  tab.close: Command+W\n  tab.next:\n    windowz: Alt+J\n"
            ),
            vec![
                "1: unknown key (allowed: version, tabs, hotkeys)",
                "tabs.layout: must be vertical or horizontal, not \"diagonal\"",
                "tabs.side: unknown key (allowed: layout, duplicate)",
                "hotkeys.tab.close: unknown action (allowed: tab.next, tab.previous)",
                "hotkeys.tab.next.windowz: unknown platform (allowed: mac, windows, linux, default)",
            ]
        );
    }

    #[test]
    fn parses_tabs_duplicate_action() {
        for (value, want) in [
            ("none", DuplicateAction::Nothing),
            ("ask", DuplicateAction::Ask),
            ("auto-close-duplicates", DuplicateAction::AutoClose),
        ] {
            assert_eq!(want.name(), value);
            let f = parse(&format!(
                "version: 1\ntabs:\n  duplicate:\n    action: {value}\n"
            ))
            .unwrap();
            assert_eq!(f.duplicate_action, Some(want));
            assert_eq!(f.layout, None);
        }
        // YAML 1.2 reads none as a string; only null, Null, NULL and ~ are
        // null.
        assert!(parse("version: 1\ntabs: {duplicate: {action: none}}\n").is_ok());
        for (value, shown) in [
            ("allow", "\"allow\""),
            ("true", "the boolean true"),
            ("yes", "\"yes\""),
            ("Ask", "\"Ask\""),
            ("auto_close_duplicates", "\"auto_close_duplicates\""),
            ("~", "empty (null)"),
            ("[ask]", "a list"),
        ] {
            assert_eq!(
                one_error(&format!(
                    "version: 1\ntabs:\n  duplicate:\n    action: {value}\n"
                )),
                format!(
                    "tabs.duplicate.action: must be none, ask or auto-close-duplicates, not {shown}"
                )
            );
        }
    }

    #[test]
    fn checks_the_tabs_duplicate_mapping() {
        // An empty mapping sets nothing.
        assert_eq!(
            parse("version: 1\ntabs:\n  duplicate: {}\n").unwrap(),
            Chromefile::default()
        );
        assert_eq!(
            one_error("version: 1\ntabs:\n  duplicate:\n    when: always\n"),
            "tabs.duplicate.when: unknown key (allowed: action)"
        );
        // The value of the old tabs.duplicates in the new key's place.
        assert_eq!(
            one_error("version: 1\ntabs:\n  duplicate: ask\n"),
            "tabs.duplicate: must be a mapping, not \"ask\""
        );
        assert_eq!(
            one_error("version: 1\ntabs:\n  duplicate:\n"),
            "tabs.duplicate: must be a mapping, not empty (null)"
        );
        assert_eq!(
            one_error("version: 1\ntabs:\n  duplicate: [ask]\n"),
            "tabs.duplicate: must be a mapping, not a list"
        );
        // tabs.duplicates is gone, like any other unknown key.
        for value in ["ask", "allow"] {
            assert_eq!(
                one_error(&format!("version: 1\ntabs:\n  duplicates: {value}\n")),
                "tabs.duplicates: unknown key (allowed: layout, duplicate)"
            );
        }
        // Each error is reported, beside the others.
        assert_eq!(
            errors(
                "version: 1\ntabs:\n  duplicate:\n    action: allow\n    when: always\n  duplicates: ask\n"
            ),
            vec![
                "tabs.duplicate.action: must be none, ask or auto-close-duplicates, not \"allow\"",
                "tabs.duplicate.when: unknown key (allowed: action)",
                "tabs.duplicates: unknown key (allowed: layout, duplicate)",
            ]
        );
    }

    #[test]
    fn checks_section_types() {
        assert_eq!(
            one_error("version: 1\ntabs:\n"),
            "tabs: must be a mapping, not empty (null)"
        );
        assert_eq!(
            one_error("version: 1\nhotkeys: []\n"),
            "hotkeys: must be a mapping, not a list"
        );
        assert_eq!(
            one_error("version: 1\nhotkeys:\n  tab.next: {}\n"),
            "hotkeys.tab.next: a platform mapping needs at least one of mac, windows, linux, default"
        );
        assert_eq!(
            one_error("version: 1\nhotkeys:\n  tab.next: !foo Alt+J\n"),
            "the YAML tag !foo at line 3, column 18 is not supported; a Chromefile uses plain values"
        );
        // The core schema's own tags mean what they say.
        assert!(parse("version: !!int 1\nhotkeys:\n  tab.next: !!str Alt+J\n").is_ok());
        assert_eq!(
            one_error("version: !!str 1\n"),
            "version: must be an integer, not \"1\""
        );
        assert!(parse("version: 1\ntabs: {}\nhotkeys: {}\n").is_ok());
    }

    #[test]
    fn parses_key_combinations() {
        for ok in [
            "Command+J",
            "Ctrl+Shift+Y",
            "MacCtrl+Shift+Down",
            "Ctrl+Alt+Shift+Comma",
            "Alt+F12",
            "Command+0",
            "Shift+Alt+PageDown",
        ] {
            assert!(Combo::parse(ok).is_ok(), "{ok}");
        }
        let bad = [
            (
                "J",
                "it has no modifier; put Command, Ctrl, Alt or MacCtrl before the key, like Command+J",
            ),
            (
                "Shift+J",
                "Shift alone is not enough; add Command, Ctrl, Alt or MacCtrl",
            ),
            (
                "Command+j",
                "unknown key \"j\" (key names are case-sensitive: J)",
            ),
            (
                "Command+pageup",
                "unknown key \"pageup\" (key names are case-sensitive: PageUp)",
            ),
            ("Command+Esc", "unknown key \"Esc\" (use A to Z"),
            ("Command+F13", "unknown key \"F13\""),
            ("Ctrl+Ctrl+J", "Ctrl appears more than once"),
            ("Command+Ctrl+J", "it combines Command and Ctrl"),
            ("Ctrl+Command+J", "it combines Command and Ctrl"),
            (
                "command+J",
                "unknown modifier \"command\" (names are case-sensitive: Command)",
            ),
            ("Cmd+J", "unknown modifier \"Cmd\" (use Command"),
            ("Command + J", "it contains a space"),
            ("Command++J", "it has an empty name"),
            ("Command+", "it has an empty name"),
            ("Command+Alt+Shift+MacCtrl+Ctrl+J", "it has 5 modifiers"),
        ];
        for (s, why) in bad {
            let e = Combo::parse(s).expect_err(s);
            assert!(e.starts_with(why), "{s}: {e}");
        }
        assert_eq!(
            one_error("version: 1\nhotkeys:\n  tab.next: Command+j\n"),
            "hotkeys.tab.next: \"Command+j\" is not a valid key combination: unknown key \"j\" (key names are case-sensitive: J)"
        );
    }

    #[test]
    fn orders_and_normalizes_modifiers() {
        assert_eq!(
            combo("Shift+Alt+Command+K").to_string(),
            "Command+Alt+Shift+K"
        );
        assert_eq!(combo("Shift+Command+K"), combo("Command+Shift+K"));
        assert_eq!(
            combo("Ctrl+J").normalized(),
            combo("Command+J").normalized()
        );
        assert_eq!(
            combo("Ctrl+Shift+J").on_mac().to_string(),
            "Command+Shift+J"
        );
        assert_eq!(combo("MacCtrl+Alt+J").on_mac().to_string(), "MacCtrl+Alt+J");
    }

    #[test]
    fn resolves_platform_mappings() {
        let f = parse(
            "version: 1\nhotkeys:\n  tab.next:\n    mac: MacCtrl+Shift+Down\n    default: Ctrl+Shift+PageDown\n  tab.previous:\n    linux: Alt+K\n",
        )
        .unwrap();
        let next = &f.hotkeys[0].1;
        let prev = &f.hotkeys[1].1;
        let b = |s: &str| Binding::Combo(combo(s));
        assert_eq!(next.resolve(Platform::Mac), Some(&b("MacCtrl+Shift+Down")));
        assert_eq!(
            next.resolve(Platform::Windows),
            Some(&b("Ctrl+Shift+PageDown"))
        );
        assert_eq!(
            next.resolve(Platform::Other),
            Some(&b("Ctrl+Shift+PageDown"))
        );
        assert_eq!(prev.resolve(Platform::Linux), Some(&b("Alt+K")));
        assert_eq!(prev.resolve(Platform::Mac), None);
        assert_eq!(prev.resolve(Platform::Other), None);
    }

    // Collisions pass the JSON schema, so they live here and not in
    // tests/invalid (validate.yml expects every file there to fail the schema).
    #[test]
    fn rejects_collisions_after_normalizing() {
        assert_eq!(
            one_error("version: 1\nhotkeys:\n  tab.next: Command+J\n  tab.previous: Ctrl+J\n"),
            "hotkeys.tab.previous: Ctrl+J collides with hotkeys.tab.next (Command+J) on mac, \
             windows, linux and other platforms (Command and Ctrl count as the same key); two \
             actions can't share a key combination"
        );
        assert!(
            one_error(
                "version: 1\nhotkeys:\n  tab.next: Shift+Command+K\n  tab.previous: Command+Shift+K\n"
            )
            .contains("on mac, windows, linux and other platforms; two actions")
        );
    }

    #[test]
    fn checks_collisions_per_platform() {
        // Only where both resolve to the same combination.
        assert!(
            one_error(
                "version: 1\nhotkeys:\n  tab.next:\n    mac: Command+J\n    default: Alt+J\n  tab.previous: Alt+J\n"
            )
            .contains("on windows, linux and other platforms;")
        );
        // Platforms without a key of their own get only default.
        assert!(
            one_error(
                "version: 1\nhotkeys:\n  tab.next:\n    mac: Alt+A\n    windows: Alt+B\n    linux: Alt+C\n    default: Alt+X\n  tab.previous: Alt+X\n"
            )
            .contains("(Alt+X) on other platforms;")
        );
        // Different platforms never collide.
        assert!(
            parse(
                "version: 1\nhotkeys:\n  tab.next:\n    mac: Command+J\n  tab.previous:\n    windows: Command+J\n"
            )
            .is_ok()
        );
        // Neither does "".
        assert!(parse("version: 1\nhotkeys:\n  tab.next: \"\"\n  tab.previous: \"\"\n").is_ok());
        assert!(
            parse("version: 1\nhotkeys:\n  tab.next: Command+J\n  tab.previous: Alt+J\n").is_ok()
        );
    }
}
