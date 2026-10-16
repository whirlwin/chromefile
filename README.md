<p align="center"><img src="assets/logo.svg" alt="Chromefile logo" width="128"></p>

# Chromefile

A Chromefile is a small YAML file that declares how Google Chrome (and Chromium-based browsers) should be set up: tab layout, duplicate tabs, hotkeys, and more over time. Like a Brewfile, you keep it in your dotfiles and any tool that implements this open, tool-neutral specification can apply it. It describes the result you want, not browser internals, so the same file stays readable and portable across machines, platforms and tools.

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

- [`cli/`](cli/README.md): the `chromefile` command line tool (Rust). It installs everything below and is also the native messaging host and the MCP server. `chromefile apply` applies a Chromefile to Chrome on macOS; it supports specification version 1.
- [`extension/`](extension/): the Chromefile Chrome extension (Manifest V3, TypeScript).
- [`host/`](host/): the Node host behind `chromefile host`, `chromefile mcp` and `chromefile call`, embedded in the binary.
- [`mods/`](mods/), [`chrome.yaml`](chrome.yaml) and [`scripts/chrome-apply.sh`](scripts/chrome-apply.sh): user scripts and declarative Chrome settings, in this implementation's own `chrome.yaml` format.

### How it works

```
Claude Code -stdio (MCP)-> chromefile mcp -Unix socket-> chromefile host <-native messaging-> extension
```

When the extension connects through native messaging, Chrome starts the `chromefile` binary as its native host, and the binary runs the embedded Node host. Claude Code starts `chromefile mcp`, which exposes the MCP tools and reaches the host through a Unix socket owned by your user. Nothing listens on a TCP port. See [docs/architecture.md](docs/architecture.md) for the protocol, methods and error codes.

### Install

Requires macOS, Node 24 or newer (the host runs on it, also from a release binary) and Google Chrome 135 or newer; a Rust toolchain is needed only to build from source. Native host manifests are written for every installed Chromium browser (Chrome, Brave, Edge, Vivaldi, Arc, Chromium), but `chromefile install` loads the extension into Google Chrome only.

With [mise](https://mise.jdx.dev), from a release:

```sh
mise use -g github:whirlwin/chromefile
chromefile install
```

The [releases page](https://github.com/whirlwin/chromefile/releases) has the binaries for macOS on arm64 and x86_64, with build provenance attestations (see [cli/README.md](cli/README.md#releasing)). `chromefile install` records the binary's exact path, and mise keeps each version in a folder of its own, so run `chromefile install` again after every upgrade; until you do, `chromefile status` reports the native host manifests and the MCP server as `differs` and exits 1.

From a clone:

```sh
git clone https://github.com/whirlwin/chromefile.git
cd chromefile
scripts/install.sh
```

`scripts/install.sh` builds the extension and host (`npm ci` the first time, `npm run build`), copies the builds into the crate (`scripts/vendor.sh`), runs `cargo install --path cli --locked` and then `chromefile install`. To build without a clone:

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

They work everywhere, including the new tab page, and keep working while the kill switch is off.

The bindings in the manifest are only defaults that Chrome applies on first install. The source of truth is the `hotkeys` section of the [`Chromefile`](Chromefile): change them there and run `chromefile apply` (see [cli/README.md](cli/README.md#apply)). Rebinding them by hand at `chrome://extensions/shortcuts` works too, but the next apply puts the Chromefile values back, and `chromefile apply --check` reports the difference.

### Duplicate tabs

`tabs.duplicate.action` says what happens when a new tab loads a page another tab already shows (in any window of the same profile; incognito tabs only match each other):

- `none`: nothing.
- `ask`: the new tab offers to close the older tabs.
- `auto-close-duplicates`: the older tabs close without asking, so the new tab is the only one showing the page.

With `ask`, the new tab gets a small card in its top right corner. Under a muted Chromefile label it says "Already open in 1 other tab" (or "Already open in N other tabs") and offers **Keep** and **Close older tab** (**Close older tabs** when there are several). Nothing closes unless you click. The card never takes focus, and it hides itself 15 seconds after you first see the tab (a tab opened in the background waits until you switch to it) unless the pointer is on it. Page scripts can't press its buttons: only real clicks count.

With `auto-close-duplicates`, the older tabs close as soon as the new tab loads, and the new tab shows the same card saying "Closed 1 older tab" (or "Closed N older tabs") with **OK** and **Undo**. Undo reopens the closed tabs with their history (from Chrome's recently closed tabs, hence the extension's `sessions` permission), and the tabs it brings back don't close anything in turn. The tab a window is showing is never closed this way, so Command+clicking a link to the page you are reading can't close it under you; if every older copy is pinned or shown in its window, nothing closes. Command+Shift+T on an auto-closed tab reopens it as a new tab like any other, so it closes the newer copy in turn, with an Undo of its own.

- Two tabs show the same page when their URLs match, ignoring the `#fragment`. Only `http` and `https` pages count.
- Pinned tabs are never offered for closing, and never closed.
- Only the first page a new tab loads counts; the new tab page and `about:blank` don't. Tabs restored when Chrome starts are not new, and tabs opened through the bridge (`tabs_open`) are left alone.
- On a page Chrome lets no extension script (the Chrome Web Store, for one), no card can appear: `ask` does nothing there, and `auto-close-duplicates` still closes the older tabs, just without the card; Command+Shift+T reopens them.

The source of truth is `tabs.duplicate.action` in the [`Chromefile`](Chromefile): set it to `none`, `ask` or `auto-close-duplicates` there and run `chromefile apply` (see [cli/README.md](cli/README.md#apply)); `chromefile apply --check` reports when Chrome differs. `none` turns both off, and is also how the extension behaves until it is told otherwise (the `allow` an earlier version stored reads as `none` too). Removing the key does not turn it off: apply then leaves the setting as it is. Like the keyboard shortcuts, it keeps working while the kill switch is off. See [docs/architecture.md](docs/architecture.md#duplicate-tabs) for how it works.

### Outlook: Ask Claude button

[`mods/outlook-claude.js`](mods/outlook-claude.js) is a mod for Outlook on the web (`https://outlook.cloud.microsoft/*`). It adds a Claude button to the header toolbar of every expanded email, between the emoji (Reactions) button and Reply.

Clicking it opens a small **Ask Claude** dialog next to the button: a prompt box, an **Include this email** checkbox (on by default), **Cancel** and **Open in iTerm**. `Cmd+Enter` submits, `Esc` or a click outside closes it. The host then opens a new iTerm2 tab in the current window, running an interactive Claude Code session in `claude.cwd` (see below) with your prompt. When the email is included, its subject, sender, recipients, date and body text are passed along, explicitly marked as untrusted content.

Setup: apply `chrome.yaml` with `scripts/chrome-apply.sh` (it registers the mod through the extension), and have **Allow User Scripts** on (`chromefile install` turns it on) and iTerm2 installed. Reload Outlook afterwards.

Be aware of what this combines: your private email, content written by whoever sent it (which can carry prompt injection) and a Claude that can run shell commands. Two things keep that in check: the button only acts on your own trusted click or keypress (synthetic events from page scripts or email content are ignored, and email HTML is never injected), and the result is an interactive session you watch, with Claude Code's permission prompts in front of every tool use. Read what it proposes before approving, especially for mail from people you don't know.

The mod finds Outlook's elements by their English accessibility labels, so it does nothing in a localized Outlook. To test it without an account, open [`mods/test/outlook-fixture.html`](mods/test/outlook-fixture.html), a copy of Outlook's DOM with a stubbed extension API (see the comment at its top).

### Drafting replies in a persona

A mod can ask your local Claude for a short draft reply to a post on X, written in a voice you describe (a persona). None of the mods in this repository use it; it is there for your own (see [Personal config](#personal-config)). From a mod:

```js
const reply = await chrome.runtime.sendMessage({
  type: "claude.draft",
  persona: "plain",                       // a name configured under claude.personas
  tweet: { text, author, handle, url },   // text is required, the rest optional
});
// reply: { ok: true, text: "..." } or { ok: false, error: "..." }
```

The draft is one or two sentences and at most 280 characters. What happens to it next is up to the mod: put it in front of the user to read, edit and post, and leave the posting to them.

Personas are configured, not built in. Declare them under `claude.personas` and apply the file with `scripts/chrome-apply.sh` (see [Declarative Chrome config](#declarative-chrome-config)), which writes them to `~/Library/Application Support/chromefile/config.json`:

```yaml
claude:
  personas:
    plain: >-
      Plain and friendly. Short sentences, everyday words, no jargon,
      and one concrete point rather than general agreement.
```

A name is lowercase letters, digits and hyphens, starts with a letter and is at most 32 characters; a voice is a non-empty string of at most 4,000 characters. The host puts the voice inside a fixed prompt whose rules are in the code ([`host/src/draft.ts`](host/src/draft.ts)): only the reply text, one or two sentences, no hashtags, no claim to be the person whose voice it is and no signature, the post's language, and the post treated as data rather than instructions. The rules stay in the repository and only the voice comes from your config, so the voices you use can stay out of it. A request for a persona that is not configured fails with an error that says where to add it.

Each request runs one `claude -p` on your Claude account. The host runs it with no tools (`--tools ""`) and no MCP servers (`--strict-mcp-config` with an empty config), in an empty private directory, with the prompt on stdin, and passes the post (author, handle, text and link) marked as untrusted content. A post carrying prompt injection can therefore only change the draft text, which you read before posting it yourself. Hooks and plugins from your Claude Code user settings still load, as for any `claude -p`. See [docs/architecture.md](docs/architecture.md#claudedraft-on-the-host) for the details.

Chrome does not give the host your shell `PATH`, so it looks for `claude` in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin` and then `PATH`. If yours lives elsewhere, set `"claude": { "bin": "/absolute/path/to/claude" }` in `config.json`.

### Declarative Chrome config

[`chrome.yaml`](chrome.yaml) declares Chrome preferences, extension keyboard shortcuts, where browser-spawned Claude sessions run, and mods (the same format also takes [personas](#drafting-replies-in-a-persona)); `scripts/chrome-apply.sh` makes Chrome match it:

```yaml
settings:
  vertical_tabs.enabled: true        # pref name as chrome://settings stores it
shortcuts:
  Chromefile:                        # extension name, exactly as installed
    select-next-tab: Command+J       # command name: manifest-style keybinding
claude:
  cwd: ~/git                         # working directory of spawned Claude sessions
  personas:                          # optional: name: voice, for claude.draft
    plain: Plain and friendly. Short sentences, everyday words, no jargon.
mods:
  outlook-claude:                    # mod id
    matches: ["https://outlook.cloud.microsoft/*"]
    file: mods/outlook-claude.js     # relative to the YAML file's directory
    runAt: document_idle             # optional, the default
    world: USER_SCRIPT               # optional, the default
    enabled: true                    # optional, the default; false unregisters it
  example:
    matches: ["https://example.com/*"]
    file: mods/example.js            # its code contains __ASSET_LOGO__
    assets:                          # optional: NAME: https URL of an image
      LOGO: https://example.com/logo.png
```

```sh
scripts/chrome-apply.sh                       # apply chrome.yaml, then your personal config
scripts/chrome-apply.sh --dry-run             # show what would change, change nothing
scripts/chrome-apply.sh --check               # the same, exit 2 if anything would change
scripts/chrome-apply.sh --list-settings tabs  # pref names and current values matching a regex
scripts/chrome-apply.sh path/to/chrome.yaml   # apply only that file
```

It is idempotent: each line reports `unchanged` or `changed` (old -> new), and only differing values are written and then read back. Values keep their YAML type (booleans, numbers, strings, lists, maps). An unknown pref, extension or command is reported, the rest is still applied, and the exit status is non-zero. Keybindings use the manifest format (`Command+J`, `Alt+Shift+K`, `MacCtrl+L`; on macOS `Ctrl` means Command); an empty value clears a shortcut. The script translates them for `chrome.developerPrivate`, which reads `Ctrl` as the Control key and does not know `MacCtrl`.

`--check` is the dry run for a cron job or a login hook: the same output, with an exit status that says whether Chrome matches the config. 0 means in sync (`unchanged` and `extra` lines only), 2 means something would change (a `would set` or `would remove` line), and 1 means an error, which wins over drift. Without a path, the two runs are combined the same way. It changes nothing, but it is not passive: settings and shortcuts still open their helper tabs in Chrome (so Chrome must be running, or the check exits 1), and mod assets are still downloaded.

`claude.cwd` must be an existing directory (a leading `~` is expanded). It is written as an absolute path to `~/Library/Application Support/chromefile/config.json` (directory `0700`, file `0600`, other keys kept), where the host reads it when it spawns a Claude session.

`claude.personas` maps persona names to voices for [draft replies](#drafting-replies-in-a-persona). A name matches `^[a-z][a-z0-9-]{0,31}$` and a voice is a non-empty string of at most 4,000 characters; a name or voice that breaks these rules is reported as an error. Each entry is written to `claude.personas.<name>` in the same `config.json`, keeping other keys and other personas. Personas the YAML does not list are left alone, so removing one from the YAML does not remove it from `config.json`. The voice text is never printed: the lines read `unchanged  claude.personas.<name>` or `changed    claude.personas.<name>`, and `would set  claude.personas.<name>` in a dry run.

`mods` are registered through the extension (`chromefile call mods.list`, `mods.register` and `mods.unregister`), so the extension must be connected and **Allow User Scripts** on. A mod whose matches, code, `runAt` or `world` differ from the registered one is re-registered. A mod with `enabled: false` (missing means `true`) is unregistered if it is registered (`removed`) and reported as `unchanged` if it is not; its file, matches and assets are not checked or downloaded, so a stale path or asset URL cannot stand in the way of turning it off. Tabs that are already open keep the injected script until they are reloaded, so reload them after turning a mod off or back on. Mods registered in Chrome but missing from the file being applied (from both files, when your [personal config](#personal-config) is applied too) are reported as `extra`, with the line naming the file or files by path, and left alone, since they may come from another file or have been registered by other means (use the `mods_unregister` tool to remove those); to turn off a mod that a file declares, use `enabled: false` rather than deleting its entry. If the extension is not connected the mods are reported as an error, the rest is still applied and the exit status is non-zero.

A mod's `assets` keep images out of the repository: on every run (dry runs too) each URL is downloaded with `curl` (`https://` only, redirects included), checked to be an image by its bytes and at most 256 KB (the code travels as a command line argument and a native message, which Chrome caps at 1 MiB), and inlined as a `data:` URI wherever the mod's code contains `__ASSET_<NAME>__` (`NAME` matches `[A-Z0-9_]+`). The comparison with the registered mod uses the inlined code, so the mod is re-registered only when the code or the image changed. A failed download is an error for that mod; the others are still applied. `scripts/test/chrome-apply-assets.sh` tests this without Chrome; it sets `CHROMEFILE_ASSET_ALLOW_FILE=1`, a test-only switch that also allows `file://` URLs.

Requirements: macOS, `chromefile` on your `PATH`, `yq` (`mise install` in this repo), and for settings and shortcuts Google Chrome already running (the script never launches it) with **View > Developer > Allow JavaScript from Apple Events** turned on. It applies to the profile of the front Chrome window.

Settings and shortcuts do not use the extension. For them the script drives Chrome through AppleScript: it opens `chrome://settings` and `chrome://extensions/shortcuts` as background tabs, calls the private APIs those pages expose (`chrome.settingsPrivate`, `chrome.developerPrivate`) with `execute javascript`, and closes the tabs again (only the ones it opened).

### Personal config

Mods and personas that are only for you live outside the repository entirely, in `~/.config/chromefile/chrome.yaml` with the mods' code in `~/.config/chromefile/mods/`. Nothing personal sits in a clone, ignored or not, so it cannot be committed by accident and it survives deleting or recloning the repository. If `XDG_CONFIG_HOME` is set to an absolute path, the file is `$XDG_CONFIG_HOME/chromefile/chrome.yaml` instead; a relative `XDG_CONFIG_HOME` is ignored, as the XDG spec says. The file has the same format as `chrome.yaml`, and a relative `file:` resolves against the YAML file's directory, so `file: mods/<name>.js` points into `~/.config/chromefile/mods/`:

```yaml
# ~/.config/chromefile/chrome.yaml
claude:
  personas:
    plain: Plain and friendly. Short sentences, everyday words, no jargon.
mods:
  my-mod:
    matches: ["https://example.com/*"]
    file: mods/my-mod.js
```

Without a path, `scripts/chrome-apply.sh` applies `chrome.yaml` and then, if it exists, your personal config, with an `applying   ~/.config/chromefile/chrome.yaml` line before the second file's lines. Each file gets a run of its own, so your personal config is applied even when the run for `chrome.yaml` fails (Chrome not running, for example), and the exit status is non-zero if either run had errors. With `--check` it is 1 if either run had errors, else 2 if either found drift. Given a path, the script applies only that file:

```sh
scripts/chrome-apply.sh                                   # chrome.yaml, then your personal config
scripts/chrome-apply.sh ~/.config/chromefile/chrome.yaml  # only your personal config
```

Each run leaves alone the mods and personas its file does not declare, so the two runs do not undo each other. Neither run reports the other file's mods as `extra`; a registered mod that neither file declares is reported once, naming both files. A Chrome setting, a shortcut, `claude.cwd` or a persona declared in both files ends up with the value from your personal config, since it is applied last, so keep each in one file.

### Security

Be clear about what this is: a remote control for every site you are logged in to.

- **The trust boundary is your macOS user.** The socket is mode `0600` in a `0700` directory, so other users cannot reach it, but any process running as you can connect and drive your browser with your sessions. There is no extra secret on top of that.
- **Native messaging is restricted to this extension.** The host manifest only allows `chrome-extension://cbapdndkoijjfggigdfalnjgjopdebid/`, the ID fixed by the manifest `key` (see `extension/extension-id.txt`).
- **Activity is only partly visible.** The badge shows that the extension is connected, not what it is doing. The debugger bar appears only for the CDP tools (`page_eval`, `page_cdp`, `page_screenshot`, `page_text`). Tab, CSS, mod, network rule and `chrome_call` operations (for example reading cookies or history) show nothing beyond the `ON` badge and the popup's command log. The kill switch cuts the bridge entirely; only the local [keyboard shortcuts](#keyboard-shortcuts) and [duplicate tab handling](#duplicate-tabs) keep working.
- **`chrome_call` reaches every permission the extension has.** It calls any `chrome.*` function, with no allow-list: cookies, history, bookmarks, downloads, and, since Undo for duplicate tabs needs `sessions`, your recently closed tabs and the tabs open on your other signed-in devices (`sessions.getDevices`).
- **Page content is untrusted input.** Text, screenshots and eval results flow back to Claude and can carry prompt injection. Be deliberate about which pages you let Claude read, especially in a session where it also has other tools (shell, email, file access) it could be talked into using.

### Uninstall

```sh
chromefile uninstall                       # or scripts/uninstall.sh from a clone
cargo uninstall chromefile                 # if you installed it with cargo
mise unuse -g github:whirlwin/chromefile   # if you installed it with mise
```

`chromefile uninstall` removes the extension from Chrome (which also deletes its registered mods and storage), its folder, the native host manifests, the MCP registration and the extracted host. It keeps `config.json` and `sessions/` in `~/Library/Application Support/chromefile` and says so.

### Development

```sh
npm ci
npm run lint && npm test   # extension and host
npm run build              # extension/dist and host/dist/chromefile-host.js
scripts/vendor.sh          # build, then copy both into cli/ for the binary to embed
cd cli && cargo test       # the CLI; see cli/README.md
scripts/test/chrome-apply-assets.sh   # chrome-apply.sh mod assets, disabled mods, personas and the personal config (macOS)
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
