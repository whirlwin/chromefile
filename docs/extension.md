# claude-browser-bridge

Lets a locally running [Claude Code](https://claude.com/claude-code) drive the
Chrome you are already logged in to: list and open tabs, read and screenshot
pages, evaluate JavaScript, inject CSS, install persistent user scripts
("mods"), rewrite network requests and call most `chrome.*` APIs.

## How it works

```
Claude Code -stdio (MCP)-> cbb mcp -Unix socket-> cbb host <-native messaging-> extension
```

Chrome starts `cbb host` when the extension connects to it through native
messaging. Claude Code starts `cbb mcp`, which exposes the MCP tools and reaches
the host through a Unix socket owned by your user. Nothing listens on a TCP
port. See [docs/architecture.md](docs/architecture.md) for the protocol,
methods and error codes.

## Install

Requires macOS (the installer has Linux paths too, but they are untested),
Node 24 or newer and a
Chromium browser (Chrome 135+, Brave, Edge, Vivaldi, Arc, Chromium).

```sh
git clone https://github.com/whirlwin/claude-browser-bridge.git
cd claude-browser-bridge
scripts/install.sh
```

The installer is safe to re-run. It:

- runs `npm ci` (first time) and `npm run build`;
- writes a wrapper at `~/Library/Application Support/claude-browser-bridge/cbb-host`
  that runs the host with an absolute Node path (Chrome does not use your shell
  `PATH`, so mise shims are resolved to the real binary);
- registers the native messaging host `io.whirlwin.claude_browser_bridge` with
  every installed Chromium browser, allowed for this extension's ID only;
- registers the `claude-browser-bridge` MCP server with Claude Code at user
  scope, if `claude` is on your `PATH`.

Then:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked** and pick `extension/dist`. The ID must match
   `extension/extension-id.txt`.
2. For mods, open the extension's Details page
   (`chrome://extensions/?id=cbapdndkoijjfggigdfalnjgjopdebid`) and turn on
   **Allow User Scripts**. The toggle only appears there, and only because the
   extension requests the `userScripts` permission. Without it the `mods_*`
   tools return `unavailable`.
3. Restart Claude Code and ask it to run `bridge_status`.

## Tools

| Tool | What it does |
|------|--------------|
| `bridge_status` | Whether the extension is connected, plus its version and user agent |
| `tabs_list` | List open tabs |
| `tabs_open` | Open a URL in a new tab |
| `tabs_close` | Close tabs |
| `tabs_navigate` | Load a URL in an existing tab |
| `tabs_focus` | Activate a tab and raise its window |
| `tabs_group` | Put tabs into a titled, coloured group |
| `page_eval` | Evaluate a JavaScript expression in a tab |
| `page_cdp` | Send a raw Chrome DevTools Protocol command to a tab |
| `page_css` | Insert or remove CSS in a tab |
| `page_screenshot` | Screenshot a tab's viewport |
| `page_text` | Get a tab's URL, title and visible text |
| `mods_list` | List registered mods (persistent user scripts) |
| `mods_register` | Register or update a mod for matching URLs |
| `mods_unregister` | Remove mods |
| `net_rules_list` | List `declarativeNetRequest` dynamic rules |
| `net_rules_add` | Add rules that block, redirect or rewrite requests |
| `net_rules_remove` | Remove rules |
| `chrome_call` | Call any `chrome.*` function by path, e.g. `bookmarks.getTree` |

## Kill switch and badge

The toolbar badge shows `ON` while the bridge is connected, `...` while it is
reconnecting and `OFF` when disabled. The popup has an on/off button and a log
of recent commands. Switching it off detaches every debugger session, closes
the native port and stops reconnecting until you switch it back on.

`page_eval`, `page_cdp`, `page_screenshot` and `page_text` attach
`chrome.debugger` to the tab and stay attached; while they are, Chrome shows its
"started debugging this browser" bar. The other tools leave no mark beyond the
badge and the popup log.

## Keyboard shortcuts

| Shortcut (macOS / other) | Action |
|--------------------------|--------|
| `⌘J` / `Alt+J` | Next tab, one down (wraps around) |
| `⌘K` / `Alt+K` | Previous tab, one up (wraps around) |

They work everywhere, including the new tab page, and keep working while the
kill switch is off. `⌘J` replaces Chrome's Downloads shortcut.

The bindings in the manifest are only defaults that Chrome applies on first
install. The source of truth is the `shortcuts` section of
[`chrome.yaml`](chrome.yaml): change them there and run
`scripts/chrome-apply.sh` (see [Declarative Chrome config](#declarative-chrome-config)).
Rebinding them by hand at `chrome://extensions/shortcuts` works too, but the
next apply puts the `chrome.yaml` values back.

## Outlook: Ask Claude button

[`mods/outlook-claude.js`](mods/outlook-claude.js) is a mod for Outlook on the
web (`https://outlook.cloud.microsoft/*`). It adds a Claude button to the
header toolbar of every expanded email, between the emoji (Reactions) button
and Reply.

Clicking it opens a small **Ask Claude** dialog next to the button: a prompt
box, an **Include this email** checkbox (on by default), **Cancel** and **Open
in iTerm**. `Cmd+Enter` submits, `Esc` or a click outside closes it. The bridge
then opens a new iTerm2 tab in the current window, running an interactive
Claude Code session in `claude.cwd` (see below) with your prompt. When the
email is included, its subject, sender, recipients, date and body text are
passed along, explicitly marked as untrusted content.

Setup: apply `chrome.yaml` with `scripts/chrome-apply.sh` (it registers the
mod through the bridge), and have the **Allow User Scripts** toggle on (see
[Install](#install)) and iTerm2 installed. Reload Outlook afterwards.

Be aware of what this combines: your private email, content written by
whoever sent it (which can carry prompt injection) and a Claude that can run
shell commands. Two things keep that in check: the button only acts on your
own trusted click or keypress (synthetic events from page scripts or email
content are ignored, and email HTML is never injected), and the result is an
interactive session you watch, with Claude Code's permission prompts in front
of every tool use. Read what it proposes before approving, especially for
mail from people you don't know.

The mod finds Outlook's elements by their English accessibility labels, so it
does nothing in a localized Outlook. To test it without an account, open
[`mods/test/outlook-fixture.html`](mods/test/outlook-fixture.html), a copy of
Outlook's DOM with a stubbed bridge (see the comment at its top).

## Declarative Chrome config

[`chrome.yaml`](chrome.yaml) declares Chrome preferences, extension keyboard
shortcuts, where browser-spawned Claude sessions run, and mods;
`scripts/chrome-apply.sh` makes Chrome match it:

```yaml
settings:
  vertical_tabs.enabled: true        # pref name as chrome://settings stores it
shortcuts:
  Claude Browser Bridge:             # extension name, exactly as installed
    select-next-tab: Command+J       # command name: manifest-style keybinding
claude:
  cwd: ~/git                         # working directory of spawned Claude sessions
mods:
  outlook-claude:                    # mod id
    matches: ["https://outlook.cloud.microsoft/*"]
    file: mods/outlook-claude.js     # relative to the chrome.yaml directory
    runAt: document_idle             # optional, the default
    world: USER_SCRIPT               # optional, the default
```

```sh
scripts/chrome-apply.sh                       # apply chrome.yaml
scripts/chrome-apply.sh --dry-run             # show what would change, change nothing
scripts/chrome-apply.sh --list-settings tabs  # pref names and current values matching a regex
scripts/chrome-apply.sh other.yaml            # apply another file
```

It is idempotent: each line reports `unchanged` or `changed` (old -> new), and
only differing values are written and then read back. Values keep their YAML
type (booleans, numbers, strings, lists, maps). An unknown pref, extension or
command is reported, the rest is still applied, and the exit status is non-zero.
Keybindings use the manifest format (`Command+J`, `Alt+Shift+K`, `MacCtrl+L`;
on macOS `Ctrl` means Command); an empty value clears a shortcut.

`claude.cwd` must be an existing directory (a leading `~` is expanded). It is
written as an absolute path to
`~/Library/Application Support/claude-browser-bridge/config.json` (directory
`0700`, file `0600`, other keys kept), where the host reads it when it spawns a
Claude session.

`mods` are registered through the bridge (`cbb call mods.list` and
`mods.register`), so the extension must be connected and **Allow User
Scripts** on. A mod whose matches, code, `runAt` or `world` differ from the
registered one is re-registered. Mods registered in Chrome but missing from
`chrome.yaml` are reported as `extra` and left alone; nothing is ever
unregistered (use the `mods_unregister` tool for that). If the bridge is not
connected the mods are reported as an error, the rest is still applied and the
exit status is non-zero.

Requirements: macOS, `yq` (`mise install` in this repo), Google Chrome already
running (the script never launches it) and **View > Developer > Allow
JavaScript from Apple Events** turned on in Chrome. It applies to the profile
of the front Chrome window.

Settings and shortcuts do not use the bridge. For them the script drives
Chrome through AppleScript: it opens `chrome://settings` and
`chrome://extensions/shortcuts` as background tabs, calls the private APIs
those pages expose (`chrome.settingsPrivate`, `chrome.developerPrivate`) with
`execute javascript`, and closes the tabs again (only the ones it opened).

## Security

Be clear about what this is: a remote control for every site you are logged in
to.

- **The trust boundary is your macOS user.** The socket is mode `0600` in a
  `0700` directory, so other users cannot reach it, but any process running as
  you can connect and drive your browser with your sessions. There is no extra
  secret on top of that.
- **Native messaging is restricted to this extension.** The host manifest only
  allows `chrome-extension://<id>/` from `extension/extension-id.txt`.
- **Activity is only partly visible.** The badge shows that the bridge is
  connected, not what it is doing. The debugger bar appears only for the CDP
  tools (`page_eval`, `page_cdp`, `page_screenshot`, `page_text`). Tab, CSS,
  mod, network rule and `chrome_call` operations (for example reading cookies
  or history) show nothing beyond the `ON` badge and the popup's command log.
  The kill switch cuts everything.
- **Page content is untrusted input.** Text, screenshots and eval results flow
  back to Claude and can carry prompt injection. Be deliberate about which
  pages you let Claude read, especially in a session where it also has other
  tools (shell, email, file access) it could be talked into using.

## Uninstall

```sh
scripts/uninstall.sh
```

This removes the host manifests, the wrapper and the MCP registration. Remove
the extension itself from `chrome://extensions`.

## Development

```sh
npm test            # unit tests for host and extension
npm run build       # builds extension/dist and host/dist/cbb.js
```

- `extension/scripts/keygen.sh` creates `extension/key.pem` (gitignored),
  prints the manifest `key` and writes `extension/extension-id.txt`. The
  extension ID is derived from the public key committed in
  `extension/static/manifest.json`, so every checkout gets the same ID; the
  private `key.pem` is only needed to pack a `.crx`.
- `node extension/scripts/icons.mjs` regenerates the toolbar icons.
- After changing the host, re-run `npm run build` (or `scripts/install.sh`).
  After changing the extension, rebuild and click reload on
  `chrome://extensions`.
