# chromefile CLI

`chromefile` installs, inspects and removes the Chromefile Chrome extension, its native messaging host and its Claude Code MCP server on macOS, applies Chromefiles to Chrome, and is itself the host and the MCP server. The extension and the Node host are embedded in the binary, so one file is all you need (plus Node 24 or newer to run the host).

```sh
chromefile install                  # install or update everything
chromefile install --replace        # also replace an extension copy loaded from another folder
chromefile status                   # show what is installed (read-only)
chromefile uninstall                # remove everything except config.json and sessions/
chromefile apply [--dry-run] [PATH] # apply a Chromefile (tab layout, hotkeys) to Chrome
chromefile apply --check [PATH]     # exit 2 if Chrome does not match the file, change nothing
chromefile mcp                      # the MCP server over stdio; Claude Code runs this
chromefile call <method> [json]     # one request to the extension, result as JSON
```

When Chrome starts the binary as a native messaging host it passes `chrome-extension://<id>/` as the first argument; that (or the hidden `chromefile host` subcommand) runs host mode. `mcp`, `call` and host mode extract the embedded host to `~/Library/Application Support/chromefile/host/chromefile-host.js` if it is missing or stale, then replace themselves with `node <that file> <mode> ...`, so stdio, signals and exit codes are node's. `call` exits 0 with the result on stdout, 1 on an error and 2 when the extension is not connected. Node is `CHROMEFILE_NODE` if set, else the path install recorded in `config.json`, else `node` from `PATH`.

## Requirements

- macOS. On other systems `install`, `status` and `uninstall` report `unsupported`, and `apply` validates the file and reports each setting `unsupported`.
- Node 24 or newer on your `PATH` when you run `install`.
- Google Chrome running with a window open. chromefile never starts Chrome, and refuses to run when more than one instance of it is running (for example your Chrome plus an automation instance with its own `--user-data-dir`), because AppleScript would pick one of them at random.
- In Chrome: **View > Developer > Allow JavaScript from Apple Events**.
- For `install` and `uninstall`: Accessibility permission for your terminal app (System Settings > Privacy & Security > Accessibility), and keep Chrome in front while they run. See below for why.

## Why the extension is installed this way

Branded Chrome ignores `--load-extension`, blocks off-store packed extensions on macOS, and extension policies belong to the company MDM. That leaves "Load unpacked", which chromefile scripts:

- The extension files are written to `~/Library/Application Support/chromefile/extension`. Chrome loads an unpacked extension from its folder on every start, so the folder has to stay. chromefile owns it: files that differ from the embedded copy are rewritten and anything else in it is deleted. The extension keeps its ID (`cbapdndkoijjfggigdfalnjgjopdebid`, fixed by the manifest `key`), which the native host manifests allow.
- Chrome's private extension API (`chrome.developerPrivate`) only exists on the chrome://extensions page. chromefile opens that page in a background tab, drives it with AppleScript's `execute javascript`, and closes the tab again (also on errors and Ctrl-C). It never touches other tabs.
- `loadUnpacked` always opens a macOS folder picker. chromefile types the folder into it (Cmd+Shift+G, path, Return) and presses Select through System Events, which is what needs Accessibility. If that can't be done, it leaves the picker and the tab open, copies the path to the clipboard and prints the steps to finish by hand.
- Removing an extension asks for confirmation in a dialog (the silent API needs a user gesture that AppleScript can't give). chromefile accepts that dialog with System Events. Chrome cancels it as soon as Chrome loses focus.

## Commands

Each line reports one item with the Chromefile outcome words (`changed`, `unchanged`, `failed`, `unsupported`). Failures go to stderr. A failed step does not stop the steps after it; the exit status is 0 on success and 1 if anything failed.

### install

1. Migration from the old claude-browser-bridge names, only when something is left over: copies the keys of `~/Library/Application Support/claude-browser-bridge/config.json` into the new `config.json` (keys already there win) and deletes that old folder, deletes `io.whirlwin.claude_browser_bridge.json` host manifests, and runs `claude mcp remove --scope user claude-browser-bridge` if `claude mcp get claude-browser-bridge` finds it. Each removal is reported as `changed (removed ...)`.
2. Extracts the host to `~/Library/Application Support/chromefile/host/chromefile-host.js` (only if the bytes differ), resolves `node` from `PATH` to the real executable (asking it for `process.execPath`, so mise and asdf shims work although Chrome does not use your shell `PATH`), checks that it is Node 24 or newer and records it under `node` in `config.json` (other keys kept). Re-run install after switching Node versions.
3. Writes the native messaging host manifest `io.whirlwin.chromefile.json` into `NativeMessagingHosts` of every installed Chromium browser (Chrome, Chrome Beta, Canary, Chrome for Testing, Chromium, Brave, Edge, Vivaldi, Arc), pointing at this binary's absolute path and allowing only `chrome-extension://cbapdndkoijjfggigdfalnjgjopdebid/`.
4. If `claude` is on `PATH`, makes sure `claude mcp add --scope user chromefile -- <this binary> mcp` is registered; a registration with another command is removed and added again. Without `claude` it reports `mcp: unsupported (claude not on PATH)`.
5. The extension:
   1. Writes the embedded files to the folder above.
   2. Turns on developer mode if it is off (fails if a policy keeps it off).
   3. Then, depending on what Chrome has:
      - nothing installed: loads the folder through the picker;
      - this folder, same version and files: nothing to do;
      - this folder, files changed: reloads the extension;
      - the same extension loaded from another folder (a dev checkout, say): fails, unless you pass `--replace`. Chrome ignores a second load of the same ID from a new folder, so the other copy has to be removed first, and **removing it also removes its registered user scripts (mods) and its storage**. Back up your mods before `chromefile install --replace`.
   4. Turns on Allow User Scripts for the extension.
   5. Checks that Chrome reports it enabled, from this folder, at the embedded version, then deletes the folder older chromefile versions used (`extensions/` next to it), if present.

```text
$ chromefile install
host: changed (wrote ~/Library/Application Support/chromefile/host/chromefile-host.js)
node: changed (recorded /Users/me/.local/share/mise/installs/node/24.21.0/bin/node, v24.21.0 in config.json)
native host Chrome: changed (wrote ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.whirlwin.chromefile.json)
mcp: changed (registered /Users/me/.cargo/bin/chromefile mcp)
developer mode: changed (turned on)
extension: changed (installed 0.1.0 from ~/Library/Application Support/chromefile/extension)
user scripts: changed (allowed)

$ chromefile install
host: unchanged (~/Library/Application Support/chromefile/host/chromefile-host.js)
node: unchanged (/Users/me/.local/share/mise/installs/node/24.21.0/bin/node, v24.21.0)
native host Chrome: unchanged (~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.whirlwin.chromefile.json)
mcp: unchanged (/Users/me/.cargo/bin/chromefile mcp)
developer mode: unchanged (on)
extension: unchanged (0.1.0 from ~/Library/Application Support/chromefile/extension)
user scripts: unchanged (allowed)
```

### status

Read-only. Exits 0 when the host file matches the embedded copy, the recorded node exists, every installed browser has the current host manifest, the MCP server is registered with this binary, no old claude-browser-bridge folder is left, and the extension is installed, enabled, loaded from the folder above, at the embedded version and files, with user scripts allowed; 1 otherwise.

```text
$ chromefile status
host: matches (~/Library/Application Support/chromefile/host/chromefile-host.js)
node: /Users/me/.local/share/mise/installs/node/24.21.0/bin/node
native host Chrome: registered (~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.whirlwin.chromefile.json)
mcp: registered (/Users/me/.cargo/bin/chromefile mcp)
extension: installed (version 0.1.0, enabled, from ~/Library/Application Support/chromefile/extension)
embedded copy: matches (version 0.1.0, ~/Library/Application Support/chromefile/extension)
user scripts: allowed
developer mode: on
```

### uninstall

Removes the extension and deletes its folder (Chrome removes the extension's registered user scripts (mods) and its storage with it), then removes the native host manifests, the MCP registration and the extracted host. `config.json` and `sessions/` stay.

```text
$ chromefile uninstall
extension: changed (removed 0.1.0 that was loaded from ~/Library/Application Support/chromefile/extension)
note: Chrome removed the extension's registered user scripts (mods) and its storage with it
extension files: changed (deleted ~/Library/Application Support/chromefile/extension)
native host Chrome: changed (removed ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/io.whirlwin.chromefile.json)
mcp: changed (removed chromefile from Claude Code)
host: changed (deleted ~/Library/Application Support/chromefile/host)
note: kept ~/Library/Application Support/chromefile/config.json and ~/Library/Application Support/chromefile/sessions (delete them by hand if you want)
```

### apply

```sh
chromefile apply [--dry-run | --check] [PATH]
```

Applies a Chromefile ([SPEC.md](../SPEC.md)) to the running Google Chrome. It supports Chromefile specification version 1 and refuses files with any other `version`.

- **Which file.** PATH if given. Otherwise `./Chromefile` in the current folder if it exists, else `$XDG_CONFIG_HOME/chromefile/Chromefile` (when `XDG_CONFIG_HOME` is an absolute path, as the XDG spec requires) or `~/.config/chromefile/Chromefile`. Without PATH the name must be exactly `Chromefile`: macOS folders usually ignore case, but a `chromefile` folder or the `chromefile` binary is never taken for it. Only the first one found is applied, and the first line of output names it. If there is none, apply lists where it looked and exits 1.
- **Validation before any change.** The whole file is checked before Chrome is touched: YAML 1.2 with exactly one document, no duplicate keys and no tags besides the core ones (`!!str` and so on), a top level that is a mapping, a supported `version`, no unknown keys, actions or platforms, valid key combinations, and no two actions that resolve to the same combination on any platform (`Command` counts as `Ctrl`, modifier order does not matter). Errors in the YAML itself (syntax, a duplicate key, an unknown tag) give a line and column, and those about the number of documents or the top level give neither; every other error names the path of the value, such as `tabs.side` or `hotkeys.tab.next`. Then apply exits 1 and changes nothing.
- **What it sets.** Settings that are not in the file are left alone. Each value is read back after it is set.
  - `tabs.layout` is Chrome's `vertical_tabs.enabled` preference (`vertical` is true), set through `chrome.settingsPrivate` on a chrome://settings helper tab. If this Chrome has no such preference, the setting is `unsupported`.
  - `hotkeys` are the shortcuts of the Chromefile extension's commands (`tab.next` is `select-next-tab`, `tab.previous` is `select-previous-tab`), set through `chrome.developerPrivate` on a chrome://extensions helper tab. On macOS `Ctrl` means Command. A platform mapping uses its `mac` value, else `default`; with neither, the hotkey is left as it is and reported `unchanged`. `""` removes the shortcut. Hotkeys need the extension: without it each one is `failed`, so run `chromefile install` first.
  - Chrome on macOS refuses some shortcuts for extensions, and drops the command's old shortcut when it does. apply reports these `unsupported` without asking Chrome: `Alt` together with `Command`, `Ctrl` or `MacCtrl`; more than 2 modifiers; and the keys F2, F3, F5, F7, F8, F9, F10 and F12, which Chrome shows without their name, so the result can't be checked.
  - Chrome hands a combination that another command has to the new command, taking it from the old one without a word. So apply reads every extension's shortcuts first, and a hotkey whose combination another extension's command holds, or a Chromefile command the file does not change (left out, or `unchanged`, `unsupported` or `failed`), is `failed` with the holder named: `Command+K is taken by "Some Extension" (do-thing); free it first`. Hotkeys in the file can still trade combinations, to swap `tab.next` and `tab.previous` for example.
- **Requirements.** As for install's Chrome steps: exactly one Chrome running, with a window, and **Allow JavaScript from Apple Events** on. Accessibility permission is not needed. Helper tabs are opened only for settings that need them and closed again, also on errors and Ctrl-C. A file with no setting that needs Chrome (only `version`, say) does not touch Chrome; one whose values already match still reads them.
- **Outcomes.** One line per setting: `changed`, `unchanged`, `failed` (on stderr) or `unsupported`. Chrome reports no error when it does not take a shortcut, so a value that does not read back as set is `failed`, never skipped. A failure does not stop the other settings.
- **Dry run.** `--dry-run` reads Chrome but changes nothing, and reports `would change` for each setting a real run would change.
- **Check.** `--check` answers "does Chrome match the file?", for a cron job or a login hook. It is a dry run, with the same output, whose exit status reports drift: 0 when Chrome matches (every setting `unchanged` or `unsupported`, which no run can change), 2 when at least one setting would change, and 1 on an error (no file, a file that can't be read or is invalid, Chrome out of reach, a setting that would be `failed`). An error wins over drift. It still reads Chrome through helper tabs, so the requirements above apply and a chrome://settings or chrome://extensions tab opens in the background and closes again while it runs; if Chrome is not running, each setting that needs it is `failed` and the status is 1. `--check --dry-run` is the same as `--check`.
- **Built-in shortcuts.** A hotkey that replaces one of Chrome's own macOS shortcuts (`Command+Shift+J` for Downloads, `Command+T`, `Command+W` and a few more, from Google's [Chrome keyboard shortcuts](https://support.google.com/chrome/answer/157179) page) prints a `warning:` line. Warnings do not change the exit status.
- **Exit status.** 0 when every setting is `changed`, `unchanged`, `unsupported` or (in a dry run without `--check`) `would change`; 1 when no file is found, the file can't be read or is invalid, or any setting `failed`; 2 with `--check` when a setting would change and none failed; 130 when interrupted.
- **Other systems.** apply validates the file the same way, then reports each setting `unsupported` (or `unchanged` for a hotkey without a value for that platform) and exits 0.

```text
$ chromefile apply
applying ~/dotfiles/Chromefile
tabs.layout: changed (horizontal -> vertical)
hotkeys.tab.next: changed (Alt+J -> Command+J)
hotkeys.tab.previous: unchanged (Command+K)

$ chromefile apply ~/dotfiles/Chromefile
applying ~/dotfiles/Chromefile
error: tabs.side: unknown key (allowed: layout)
error: hotkeys.tab.next: "Command+j" is not a valid key combination: unknown key "j" (key names are case-sensitive: J)
~/dotfiles/Chromefile is not a valid Chromefile, so nothing was changed
```

## Building

```sh
cargo build --release   # target/release/chromefile
cargo test
```

The binary embeds `extension/` (a copy of the repository's `extension/dist`) and `host/chromefile-host.js` (a copy of `host/dist/chromefile-host.js`). Both are committed so that `cargo install --git https://github.com/whirlwin/chromefile chromefile` works without Node. To update them after changing the extension or the host, run from the repository root:

```sh
scripts/vendor.sh [--no-build]
```

It runs `npm run build` (skipped with `--no-build`) and replaces both copies. CI fails when they are stale.

## Testing

These environment variables exist for tests only:

- `CHROMEFILE_HOME`: the app folder, default `~/Library/Application Support/chromefile`. Point it at a temporary folder. The host uses it too, for its socket, `config.json` and `sessions/`.
- `CHROMEFILE_BROWSER_ROOT`: replaces `~/Library/Application Support` as the base of the browsers' `NativeMessagingHosts` folders and of the old claude-browser-bridge folder that install migrates.
- `CHROMEFILE_CLAUDE`: the `claude` binary to run, so tests can use a stub that logs its arguments.
- `CHROMEFILE_CHROME_APP`: the browser's application name, default `Google Chrome`. Set it to `Google Chrome for Testing` to work against a Chrome for Testing instance instead of your own browser.
- `CHROMEFILE_SOCKET`: the host's socket path (the host's own override).

`--skip-extension` on `install`, `status` and `uninstall` leaves Chrome alone, so the other steps can be tested without it:

```sh
root="$(mktemp -d)"
mkdir -p "$root/Google/Chrome"
CHROMEFILE_HOME="$(mktemp -d)" CHROMEFILE_BROWSER_ROOT="$root" CHROMEFILE_CLAUDE=/path/to/stub-claude \
  chromefile install --skip-extension
```

To test the extension steps, start Chrome for Testing with a window (not headless) and a throwaway profile that already allows JavaScript from Apple Events:

```sh
profile="$(mktemp -d)"
mkdir -p "$profile/Default"
echo '{"browser":{"allow_javascript_apple_events":true}}' > "$profile/Default/Preferences"
open -na "/path/to/Google Chrome for Testing.app" --args --user-data-dir="$profile" --no-first-run
CHROMEFILE_CHROME_APP="Google Chrome for Testing" CHROMEFILE_HOME="$(mktemp -d)" \
  CHROMEFILE_BROWSER_ROOT="$root" CHROMEFILE_CLAUDE=/path/to/stub-claude chromefile install
```
