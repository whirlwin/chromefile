<p align="center"><img src="assets/logo.svg" alt="Chromefile logo" width="128"></p>

# Chromefile

A Chromefile is a small YAML file that declares how Google Chrome (and Chromium-based browsers) should be set up: tab layout, hotkeys, and more over time. Like a Brewfile, you keep it in your dotfiles and any tool that implements this open, tool-neutral specification can apply it. It describes the result you want, not browser internals, so the same file stays readable and portable across machines, platforms and tools.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/whirlwin/chromefile/main/schema/chromefile.schema.json
version: 1

tabs:
  layout: vertical          # vertical | horizontal

hotkeys:
  tab.next: Command+J       # the tab below (vertical) or to the right (horizontal), wrapping around
  tab.previous: Command+K
```

## Specification

- [SPEC.md](SPEC.md): the Chromefile Specification, version 1.
- [schema/chromefile.schema.json](schema/chromefile.schema.json): JSON Schema (draft 2020-12) for validation and editor support.

## Editor setup

Editors using [yaml-language-server](https://github.com/redhat-developer/yaml-language-server) (VS Code with the Red Hat YAML extension, Neovim, Helix, Zed and others) pick up the schema from the first-line comment and give completion, hover docs and validation. Since `Chromefile` has no extension, tell your editor it is YAML (in VS Code: `"files.associations": { "Chromefile": "yaml" }`).

To validate from the command line:

```sh
uvx check-jsonschema --default-filetype yaml \
  --schemafile https://raw.githubusercontent.com/whirlwin/chromefile/main/schema/chromefile.schema.json \
  Chromefile
```

## Reference implementation

The specification is tool-neutral: any tool may implement it, and nothing in a Chromefile depends on the code below. This repository also holds one implementation for macOS, called chromefile as well. It lets a locally running [Claude Code](https://claude.com/claude-code) drive the Chrome you are already logged in to: list and open tabs, read and screenshot pages, evaluate JavaScript, inject CSS, install persistent user scripts ("mods"), rewrite network requests and call most `chrome.*` APIs. It is made of:

- [`cli/`](cli/README.md): the `chromefile` command line tool (Rust). It installs everything below and is also the native messaging host and the MCP server.
- [`extension/`](extension/): the Chromefile Chrome extension (Manifest V3, TypeScript).
- [`host/`](host/): the Node host behind `chromefile host`, `chromefile mcp` and `chromefile call`, embedded in the binary.
- [`mods/`](mods/), [`chrome.yaml`](chrome.yaml) and [`scripts/chrome-apply.sh`](scripts/chrome-apply.sh): user scripts and declarative Chrome settings, in this implementation's own `chrome.yaml` format.

### How it works

```
Claude Code -stdio (MCP)-> chromefile mcp -Unix socket-> chromefile host <-native messaging-> extension
```

When the extension connects through native messaging, Chrome starts the `chromefile` binary as its native host, and the binary runs the embedded Node host. Claude Code starts `chromefile mcp`, which exposes the MCP tools and reaches the host through a Unix socket owned by your user. Nothing listens on a TCP port. See [docs/architecture.md](docs/architecture.md) for the protocol, methods and error codes.

### Install

Requires macOS, Node 24 or newer (the host runs on it), a Rust toolchain to build, and Google Chrome 135 or newer. Native host manifests are written for every installed Chromium browser (Chrome, Brave, Edge, Vivaldi, Arc, Chromium), but `chromefile install` loads the extension into Google Chrome only.

From a clone:

```sh
git clone https://github.com/whirlwin/chromefile.git
cd chromefile
scripts/install.sh
```

`scripts/install.sh` builds the extension and host (`npm ci` the first time, `npm run build`), copies the builds into the crate (`scripts/vendor.sh`), runs `cargo install --path cli --locked` and then `chromefile install`. Without a clone:

```sh
cargo install --git https://github.com/whirlwin/chromefile chromefile
chromefile install
```

Before running `chromefile install`, start Chrome with a window open, turn on **View > Developer > Allow JavaScript from Apple Events**, and give your terminal app Accessibility permission (System Settings > Privacy & Security > Accessibility); see [cli/README.md](cli/README.md) for why. It is safe to re-run, and each line reports `changed`, `unchanged`, `failed` or `unsupported`. In order, it:

1. migrates from the project's old name, claude-browser-bridge, when it finds leftovers: copies the old `config.json` keys into the new one and deletes `~/Library/Application Support/claude-browser-bridge`, deletes the old `io.whirlwin.claude_browser_bridge` host manifests and removes the old `claude-browser-bridge` MCP server from Claude Code;
2. extracts the host to `~/Library/Application Support/chromefile/host/` and records the absolute path of your node in `config.json` there (Chrome does not use your shell `PATH`, so mise shims and similar wrappers are resolved to the real binary; re-run after switching Node versions);
3. registers the native messaging host `io.whirlwin.chromefile`, pointing at the `chromefile` binary and allowed for this extension's ID only, with every installed Chromium browser;
4. registers the `chromefile` MCP server (`chromefile mcp`) with Claude Code at user scope, if `claude` is on your `PATH`;
5. loads the extension into Chrome from `~/Library/Application Support/chromefile/extension`, turning on developer mode and **Allow User Scripts** (which the `mods_*` tools need).

Then restart Claude Code and ask it to run `bridge_status`. `chromefile status` shows each piece without changing anything.

### Tools

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

Scripts can make the same requests with `chromefile call <method> [json-params]`, for example `chromefile call tabs.list`.

### Kill switch and badge

The toolbar badge shows `ON` while the extension is connected to the host, `...` while it is reconnecting and `OFF` when disabled. The popup has an on/off button and a log of recent commands. Switching it off detaches every debugger session, closes the native port and stops reconnecting until you switch it back on.

`page_eval`, `page_cdp`, `page_screenshot` and `page_text` attach `chrome.debugger` to the tab and stay attached; while they are, Chrome shows its "started debugging this browser" bar. The other tools leave no mark beyond the badge and the popup log.

### Keyboard shortcuts

| Shortcut (macOS / other) | Action |
|--------------------------|--------|
| `⌘J` / `Alt+J` | Next tab, one down (wraps around) |
| `⌘K` / `Alt+K` | Previous tab, one up (wraps around) |

They work everywhere, including the new tab page, and keep working while the kill switch is off. `⌘J` replaces Chrome's Downloads shortcut.

The bindings in the manifest are only defaults that Chrome applies on first install. The source of truth is the `shortcuts` section of [`chrome.yaml`](chrome.yaml): change them there and run `scripts/chrome-apply.sh` (see [Declarative Chrome config](#declarative-chrome-config)). Rebinding them by hand at `chrome://extensions/shortcuts` works too, but the next apply puts the `chrome.yaml` values back.

### Outlook: Ask Claude button

[`mods/outlook-claude.js`](mods/outlook-claude.js) is a mod for Outlook on the web (`https://outlook.cloud.microsoft/*`). It adds a Claude button to the header toolbar of every expanded email, between the emoji (Reactions) button and Reply.

Clicking it opens a small **Ask Claude** dialog next to the button: a prompt box, an **Include this email** checkbox (on by default), **Cancel** and **Open in iTerm**. `Cmd+Enter` submits, `Esc` or a click outside closes it. The host then opens a new iTerm2 tab in the current window, running an interactive Claude Code session in `claude.cwd` (see below) with your prompt. When the email is included, its subject, sender, recipients, date and body text are passed along, explicitly marked as untrusted content.

Setup: apply `chrome.yaml` with `scripts/chrome-apply.sh` (it registers the mod through the extension), and have **Allow User Scripts** on (`chromefile install` turns it on) and iTerm2 installed. Reload Outlook afterwards.

Be aware of what this combines: your private email, content written by whoever sent it (which can carry prompt injection) and a Claude that can run shell commands. Two things keep that in check: the button only acts on your own trusted click or keypress (synthetic events from page scripts or email content are ignored, and email HTML is never injected), and the result is an interactive session you watch, with Claude Code's permission prompts in front of every tool use. Read what it proposes before approving, especially for mail from people you don't know.

The mod finds Outlook's elements by their English accessibility labels, so it does nothing in a localized Outlook. To test it without an account, open [`mods/test/outlook-fixture.html`](mods/test/outlook-fixture.html), a copy of Outlook's DOM with a stubbed extension API (see the comment at its top).

### Declarative Chrome config

[`chrome.yaml`](chrome.yaml) declares Chrome preferences, extension keyboard shortcuts, where browser-spawned Claude sessions run, and mods; `scripts/chrome-apply.sh` makes Chrome match it:

```yaml
settings:
  vertical_tabs.enabled: true        # pref name as chrome://settings stores it
shortcuts:
  Chromefile:                        # extension name, exactly as installed
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

It is idempotent: each line reports `unchanged` or `changed` (old -> new), and only differing values are written and then read back. Values keep their YAML type (booleans, numbers, strings, lists, maps). An unknown pref, extension or command is reported, the rest is still applied, and the exit status is non-zero. Keybindings use the manifest format (`Command+J`, `Alt+Shift+K`, `MacCtrl+L`; on macOS `Ctrl` means Command); an empty value clears a shortcut.

`claude.cwd` must be an existing directory (a leading `~` is expanded). It is written as an absolute path to `~/Library/Application Support/chromefile/config.json` (directory `0700`, file `0600`, other keys kept), where the host reads it when it spawns a Claude session.

`mods` are registered through the extension (`chromefile call mods.list` and `mods.register`), so the extension must be connected and **Allow User Scripts** on. A mod whose matches, code, `runAt` or `world` differ from the registered one is re-registered. Mods registered in Chrome but missing from `chrome.yaml` are reported as `extra` and left alone; nothing is ever unregistered (use the `mods_unregister` tool for that). If the extension is not connected the mods are reported as an error, the rest is still applied and the exit status is non-zero.

Requirements: macOS, `chromefile` on your `PATH`, `yq` (`mise install` in this repo), Google Chrome already running (the script never launches it) and **View > Developer > Allow JavaScript from Apple Events** turned on in Chrome. It applies to the profile of the front Chrome window.

Settings and shortcuts do not use the extension. For them the script drives Chrome through AppleScript: it opens `chrome://settings` and `chrome://extensions/shortcuts` as background tabs, calls the private APIs those pages expose (`chrome.settingsPrivate`, `chrome.developerPrivate`) with `execute javascript`, and closes the tabs again (only the ones it opened).

### Security

Be clear about what this is: a remote control for every site you are logged in to.

- **The trust boundary is your macOS user.** The socket is mode `0600` in a `0700` directory, so other users cannot reach it, but any process running as you can connect and drive your browser with your sessions. There is no extra secret on top of that.
- **Native messaging is restricted to this extension.** The host manifest only allows `chrome-extension://cbapdndkoijjfggigdfalnjgjopdebid/`, the ID fixed by the manifest `key` (see `extension/extension-id.txt`).
- **Activity is only partly visible.** The badge shows that the extension is connected, not what it is doing. The debugger bar appears only for the CDP tools (`page_eval`, `page_cdp`, `page_screenshot`, `page_text`). Tab, CSS, mod, network rule and `chrome_call` operations (for example reading cookies or history) show nothing beyond the `ON` badge and the popup's command log. The kill switch cuts everything.
- **Page content is untrusted input.** Text, screenshots and eval results flow back to Claude and can carry prompt injection. Be deliberate about which pages you let Claude read, especially in a session where it also has other tools (shell, email, file access) it could be talked into using.

### Uninstall

```sh
chromefile uninstall     # or scripts/uninstall.sh from a clone
cargo uninstall chromefile
```

`chromefile uninstall` removes the extension from Chrome (which also deletes its registered mods and storage), its folder, the native host manifests, the MCP registration and the extracted host. It keeps `config.json` and `sessions/` in `~/Library/Application Support/chromefile` and says so.

### Development

```sh
npm ci
npm run lint && npm test   # extension and host
npm run build              # extension/dist and host/dist/chromefile-host.js
scripts/vendor.sh          # build, then copy both into cli/ for the binary to embed
cd cli && cargo test       # the CLI; see cli/README.md
```

- `cli/extension/` and `cli/host/` are committed copies of the builds, so that `cargo install --git` works without Node. CI rebuilds them and fails if they differ, so run `scripts/vendor.sh` and commit the result after changing the extension or the host.
- `extension/scripts/keygen.sh` creates `extension/key.pem` (gitignored), prints the manifest `key` and writes `extension/extension-id.txt`. The extension ID is derived from the public key committed in `extension/static/manifest.json`, so every checkout gets the same ID; the private `key.pem` is only needed to pack a `.crx`.
- `node extension/scripts/icons.mjs` regenerates the toolbar icons.
- To try a change in Chrome, run `scripts/install.sh` again. Loading `extension/dist` by hand with **Load unpacked** works too, but then `chromefile install` sees the extension loaded from another folder and asks for `--replace`.

## Status

Draft, version 1. The format may change incompatibly until version 1 is marked final.

## Contributing

To propose a new setting or hotkey action, [open an issue](https://github.com/whirlwin/chromefile/issues) describing the user-visible behaviour you want to declare. See [section 9 of the spec](SPEC.md#9-extending-the-specification) for naming conventions and how versions evolve.

## License

- The specification and documentation ([SPEC.md](SPEC.md), this README) are licensed under [CC BY 4.0](LICENSE-SPEC).
- The schema, tests and other code are licensed under the [MIT License](LICENSE).
