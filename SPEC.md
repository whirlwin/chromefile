# Chromefile Specification, version 1

Status: **draft**. This document may change incompatibly until version 1 is marked final.

## 1. Introduction

A Chromefile is a declarative YAML file that describes how Google Chrome and Chromium-based browsers (for example Brave, Edge, Vivaldi, Arc) should be configured, in the spirit of a Brewfile. It states the desired result, not how to reach it.

### 1.1 Goals

- **Declarative**: the file describes desired state (what), never mechanism (how). It contains no browser-internal preference names, extension ids or command ids.
- **Portable**: one file works across macOS, Windows and Linux, with per-platform values only where they are unavoidable.
- **Tool-neutral**: any tool (a CLI, an extension, a configuration management module) can implement the specification.
- **Idempotent**: applying a file any number of times yields the same browser state.

### 1.2 Non-goals

- Describing mechanism (preference files, policies, extension internals).
- Storing secrets (passwords, tokens, cookies, sync credentials).
- Browser profile data such as bookmarks, history or open tabs (out of scope for now).

## 2. Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 ([RFC 2119](https://www.rfc-editor.org/rfc/rfc2119), [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)) when, and only when, they appear in all capitals, as shown here.

"Tool" means any software that reads a Chromefile and applies it to a browser. "Setting" means a single leaf value in the file (for example `tabs.layout` or `hotkeys.tab.next`).

## 3. File

- The file name is `Chromefile`, exact and case-sensitive, with no extension.
- The file is [YAML 1.2](https://yaml.org/spec/1.2.2/), encoded as UTF-8. It contains exactly one YAML document.
- The top-level node MUST be a mapping.
- Duplicate keys in any mapping are an error.
- Where the file lives is up to the tool (for example the root of a dotfiles repository, or `~/.config/chromefile/Chromefile`). Tools SHOULD accept an explicit path.

The top-level keys defined by version 1 are `version`, `tabs` and `hotkeys`.

## 4. `version`

REQUIRED. An integer naming the specification version the file conforms to. For this specification it is `1`.

Tools MUST refuse, before changing anything, a file whose `version` is missing, is not an integer, or is a version the tool does not support.

## 5. `tabs`

OPTIONAL mapping.

### 5.1 `tabs.layout`

OPTIONAL. One of:

| Value        | Meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `vertical`   | The tab strip runs along the side of the window, tabs stacked top to bottom. |
| `horizontal` | The classic tab strip runs across the top of the window, tabs left to right. |

Which side a vertical tab strip is placed on (left or right) is out of scope for version 1. A future version may add a key such as `tabs.side`.

### 5.2 `tabs.duplicate`

OPTIONAL mapping. What happens when a tab starts showing a page that another tab in the same browser profile already shows, in any window: a new tab loading its first page, or a tab navigating to another page (rule 3 below says which count). The other tabs showing the page had it first, and are called the older tabs. Its only key is `action`, which is the setting; an empty mapping sets nothing.

#### `tabs.duplicate.action`

OPTIONAL. One of:

| Value                   | Meaning |
|-------------------------|---------|
| `none`                  | Nothing special happens: the browser's default behaviour. |
| `ask`                   | The browser shows a small prompt in the tab that started showing the page, offering to close the older tab or tabs. |
| `auto-close-duplicates` | The browser closes the older tab or tabs without asking, so the tab that started showing the page is the only one showing it. |

Leaving the key out leaves the behaviour as it is (section 7); `none` turns `ask` and `auto-close-duplicates` off.

Rules for `ask` and `auto-close-duplicates`:

1. Two tabs show the same page when their URLs are equal after removing the fragment (the `#` and everything after it). The rest of the URL, including scheme, host, path and query, is compared exactly.
2. Pinned tabs are never offered for closing, and never closed. If every other tab showing the page is pinned, nothing happens.
3. The action is taken when a tab starts showing a different page (in the sense of rule 1): when a new tab loads its first page, whether or not it is active in its window, and when a tab that is active (the tab shown) in its window navigates to another page. It counts however the tab navigates, including a page script changing the URL without loading a new document. Reloading a page, or moving to another fragment of it, does not change the page and does not count. Nor does a navigation in a tab that is not active in its window (an automatic refresh or a sign-in redirect, say), so that nothing is closed or prompted from a tab its window is not showing. The browser's new tab page and `about:blank` do not count as a page.
4. Tabs restored when the browser starts (session restore) are not new tabs, and loading the page they were restored with is not a navigation. Their next navigation counts.
5. A tool that cannot carry out the action in a given browser MUST report the setting as `unsupported` (section 7).

With `ask`, a tab MUST NOT be closed without the user's confirmation.

With `auto-close-duplicates`, the older tabs are closed without asking: putting this value in the file is the user's consent. In addition:

1. A tab that is active (the tab shown) in its window is never closed this way, so that opening a link to the page being read in a new tab (with Command+click or Ctrl+click, say) cannot close that page. If every older tab showing the page is pinned or active, nothing is closed.
2. A tool SHOULD tell the user which tabs it closed, and SHOULD offer a way to undo it (for example a notice with an Undo button that reopens them).

## 6. `hotkeys`

OPTIONAL mapping. Each key is an action name from the action registry (section 6.1). Each value is a hotkey: either a key combination (section 6.2) or a platform mapping (section 6.3).

The empty string `""` means: ensure the action has no hotkey (remove any existing one).

Two actions MUST NOT resolve to the same key combination on the same platform. Combinations are compared after normalizing: `Command` is treated as `Ctrl` and modifier order is ignored, so `Command+J` and `Ctrl+J` collide. The empty string is exempt.

A hotkey may replace a browser built-in shortcut (for example, `Command+J` is `Ctrl+J` on Windows and Linux, where it opens Downloads in Chrome). Tools SHOULD warn when a hotkey shadows a known built-in shortcut.

### 6.1 Action registry

Version 1 defines these actions:

| Action         | Meaning |
|----------------|---------|
| `tab.next`     | Activate the tab after the active one in tab strip order: the tab below it in vertical layout, to the right of it in horizontal layout. From the last tab, wrap to the first. Pinned and grouped tabs count, in strip order. Scope: the current window. |
| `tab.previous` | Mirror of `tab.next`: activate the tab before the active one (above in vertical layout, to the left in horizontal layout). From the first tab, wrap to the last. Same rules for pinned and grouped tabs, same scope. |

Unknown action names are an error (section 7).

### 6.2 Key combinations

A key combination is one or more modifiers, each followed by `+`, then exactly one key. Names are case-sensitive and contain no spaces. The grammar below is ABNF ([RFC 5234](https://www.rfc-editor.org/rfc/rfc5234)), except that string literals are case-sensitive.

```abnf
combo     = "" / modifiers key
modifiers = 1*4( modifier "+" )
modifier  = "Command" / "Ctrl" / "Alt" / "Shift" / "MacCtrl"
key       = %x41-5A / DIGIT                ; A to Z, 0 to 9
          / "Comma" / "Period" / "Home" / "End" / "PageUp" / "PageDown"
          / "Space" / "Insert" / "Delete" / "Up" / "Down" / "Left" / "Right"
          / "F1" / "F2" / "F3" / "F4" / "F5" / "F6"
          / "F7" / "F8" / "F9" / "F10" / "F11" / "F12"
```

Additional rules:

1. At least one of `Command`, `Ctrl`, `Alt` or `MacCtrl` is REQUIRED. `Shift` alone is not enough. This matches what browsers accept for global shortcuts.
2. A modifier MUST NOT appear more than once.
3. `Command` and `Ctrl` MUST NOT be combined (they name the same key on some platform, see below).
4. Modifier order is not significant: `Shift+Command+K` and `Command+Shift+K` are the same combination. Tools SHOULD display modifiers in the order `Command`, `Ctrl`, `MacCtrl`, `Alt`, `Shift`.

Modifier meanings:

| Modifier  | macOS        | Windows, Linux, other |
|-----------|--------------|-----------------------|
| `Command` | Command (⌘)  | Ctrl                  |
| `Ctrl`    | Command (⌘)  | Ctrl                  |
| `Alt`     | Option (⌥)   | Alt                   |
| `Shift`   | Shift        | Shift                 |
| `MacCtrl` | Control (⌃)  | not available         |

`Ctrl` meaning Command on macOS follows the notation of `suggested_key` in a Chrome extension manifest, where Chrome itself turns `Ctrl` into Command and `MacCtrl` into Control on macOS. Chrome APIs that set shortcuts in other ways may not make that translation, so a tool using them may need to translate values itself. `Command` is provided because it reads naturally to macOS users; both are portable. A combination containing `MacCtrl` that applies to a platform other than macOS cannot be applied there and MUST be reported as unsupported (section 7).

The key names follow Chrome's extension command notation. Browsers may reject some combinations that this grammar allows (for example Chrome rejects `Ctrl+Alt` combinations for extension shortcuts); tools MUST report those as failed or unsupported, never skip them silently.

### 6.3 Platform mapping

Where one combination cannot fit every platform, a hotkey MAY be a mapping:

```yaml
hotkeys:
  tab.next:
    mac: MacCtrl+Shift+Down
    default: Ctrl+Shift+PageDown
```

- Allowed keys: `mac`, `windows`, `linux`, `default`. Any other key is an error.
- The mapping MUST contain at least one key.
- Each value is a key combination (section 6.2), including `""`.
- `default` applies to every platform not listed. If the current platform is not listed and there is no `default`, the tool leaves the action as is on that platform and reports it as `unchanged`.

## 7. Processing model

A conforming tool:

1. MUST parse and validate the whole file before changing anything. If the file is invalid, the tool MUST change nothing.
2. MUST reject unknown keys (at the top level, in `tabs`, in `tabs.duplicate`, in a platform mapping) and unknown action names, with an error naming the path (for example `tabs.side` or `hotkeys.tab.close`). It MUST NOT ignore them. New settings are introduced only through a new `version` (section 9).
3. MUST treat duplicate YAML keys as an error.
4. MUST apply settings idempotently: applying the same file twice changes nothing the second time.
5. MUST report the outcome of each setting it processes as one of `changed`, `unchanged`, `failed` or `unsupported`.
6. MUST leave settings absent from the file untouched. A Chromefile is not exhaustive.
7. MUST report a setting it cannot apply on the current platform or browser as `failed` or `unsupported`. It MUST NOT skip it silently.
8. MAY offer a dry-run mode that reports what would change without changing anything.

A tool MAY apply settings in any order. If applying a setting fails, the tool SHOULD continue with the remaining settings and MUST exit with a failure status.

## 8. Conformance

A **conforming file**:

- is valid YAML 1.2 without duplicate keys,
- validates against the JSON Schema published for its `version` ([`schema/chromefile.schema.json`](schema/chromefile.schema.json) for version 1), and
- satisfies the rules the schema cannot express: no two actions resolve to the same normalized key combination on the same platform (section 6).

A **conforming tool**:

- declares which specification versions it supports,
- refuses files with an unsupported `version` (section 4),
- implements the processing model (section 7) for every setting and action in each version it supports, reporting any it cannot apply on a given platform or browser as `unsupported`.

## 9. Extending the specification

Because tools reject unknown keys, any new key, value or action would break existing tools. The policy is therefore:

- **Every change to the set of valid files publishes a new integer `version`**, including purely additive ones (a new section, a new enum value, a new registry action). There are no minor revisions within a version.
- The exception is a draft: until version 1 is marked final (see the status line), it may still gain settings, as it gained `tabs.duplicate`, without a new `version`. A tool built before such an addition rejects files that use it, as an unknown key, so they fail safely.
- Each version is a superset of the previous one unless its changelog states otherwise. A file valid under version N SHOULD remain valid, with the same meaning, when its `version` is raised to N+1.
- Tools declare the versions they support. A tool supporting version N SHOULD also support all earlier versions.
- The published schema accepts every released version, selecting the rules by the value of `version`.
- Editorial clarifications that do not change which files are valid or what they mean do not change the version.

Naming conventions for future additions:

- Top-level sections and setting keys: `lower_snake_case` nouns describing a browser area (for example `tabs`, `new_tab_page`).
- Enum values: lower-case words joined with hyphens (for example `auto-close-duplicates`).
- Actions: dotted lower-case names, `noun.verb` or `noun.adjective` (for example `tab.next`, `tab.close`, `window.new`), using `lower_snake_case` within a segment if needed.
- Names describe user-visible behaviour, never a browser's internal identifiers.

Propose new settings or actions by opening an issue at <https://github.com/whirlwin/chromefile/issues>.

## 10. Security and privacy considerations

- A Chromefile changes browser behaviour, including which keys do what. Tools SHOULD show the changes they are about to make (a dry run or a diff) and SHOULD let the user confirm before applying a file they have not applied before.
- Tools MUST NOT fetch remote Chromefiles implicitly. Applying a file from a URL requires an explicit user action naming that URL.
- Tools SHOULD warn when a hotkey shadows a browser built-in shortcut, since this can hide expected functionality.
- A Chromefile MUST NOT contain secrets. Version 1 defines no field that holds one, and future versions will not add any. Because files are often committed to public repositories, treat their contents as public.

## Appendix A. Full example

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/whirlwin/chromefile/main/schema/chromefile.schema.json
version: 1

tabs:
  layout: vertical          # vertical | horizontal
  duplicate:
    action: ask             # none | ask | auto-close-duplicates

hotkeys:
  tab.next: Command+J       # the tab below (vertical) or to the right (horizontal), wrapping around
  tab.previous: Command+K
```
