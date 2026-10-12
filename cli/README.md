# chromefile CLI

`chromefile` installs, inspects and removes the [Claude Browser Bridge](https://github.com/whirlwin/claude-browser-bridge) Chrome extension in the running Google Chrome on macOS. The extension is embedded in the binary, so one file is all you need.

```sh
chromefile install     # install or update the extension
chromefile install --replace   # also replace a copy loaded from another folder
chromefile status      # show what is installed (read-only)
chromefile uninstall   # remove the extension and its files
```

It installs only the extension. The bridge's native messaging host and MCP registration are set up by the bridge itself; they keep working because the extension keeps its ID (`cbapdndkoijjfggigdfalnjgjopdebid`, fixed by the manifest `key`).

## Requirements

- macOS. On other systems every command reports `unsupported`.
- Google Chrome running with a window open. chromefile never starts Chrome, and refuses to run when more than one instance of it is running (for example your Chrome plus an automation instance with its own `--user-data-dir`), because AppleScript would pick one of them at random.
- In Chrome: **View > Developer > Allow JavaScript from Apple Events**.
- For `install` and `uninstall`: Accessibility permission for your terminal app (System Settings > Privacy & Security > Accessibility), and keep Chrome in front while they run. See below for why.

## Why it works this way

Branded Chrome ignores `--load-extension`, blocks off-store packed extensions on macOS, and extension policies belong to the company MDM. That leaves "Load unpacked", which chromefile scripts:

- The extension files are written to `~/Library/Application Support/chromefile/extensions/claude-browser-bridge`. Chrome loads an unpacked extension from its folder on every start, so the folder has to stay. chromefile owns it: files that differ from the embedded copy are rewritten and anything else in it is deleted.
- Chrome's private extension API (`chrome.developerPrivate`) only exists on the chrome://extensions page. chromefile opens that page in a background tab, drives it with AppleScript's `execute javascript`, and closes the tab again (also on errors and Ctrl-C). It never touches other tabs.
- `loadUnpacked` always opens a macOS folder picker. chromefile types the folder into it (Cmd+Shift+G, path, Return) and presses Select through System Events, which is what needs Accessibility. If that can't be done, it leaves the picker and the tab open, copies the path to the clipboard and prints the steps to finish by hand.
- Removing an extension asks for confirmation in a dialog (the silent API needs a user gesture that AppleScript can't give). chromefile accepts that dialog with System Events. Chrome cancels it as soon as Chrome loses focus.

## Commands

Each line reports one item with the Chromefile outcome words (`changed`, `unchanged`, `failed`, `unsupported`). Failures go to stderr. The exit status is 0 on success and 1 on failure.

### install

1. Writes the embedded files to the folder above.
2. Turns on developer mode if it is off (fails if a policy keeps it off).
3. Then, depending on what Chrome has:
   - nothing installed: loads the folder through the picker;
   - this folder, same version and files: nothing to do;
   - this folder, files changed: reloads the extension;
   - the same extension loaded from another folder (a dev checkout, say): fails, unless you pass `--replace`. Chrome ignores a second load of the same ID from a new folder, so the other copy has to be removed first, and **removing it also removes its registered user scripts (mods) and its storage**. Back up your mods before `chromefile install --replace`.
4. Turns on Allow User Scripts for the extension.
5. Checks that Chrome reports it enabled, from this folder, at the embedded version.

```text
$ chromefile install
developer mode: changed (turned on)
extension claude-browser-bridge: changed (installed 0.1.0 from ~/Library/Application Support/chromefile/extensions/claude-browser-bridge)
user scripts: changed (allowed)

$ chromefile install
developer mode: unchanged (on)
extension claude-browser-bridge: unchanged (0.1.0 from ~/Library/Application Support/chromefile/extensions/claude-browser-bridge)
user scripts: unchanged (allowed)
```

### status

Read-only. Exits 0 when the extension is installed, enabled, loaded from the folder above, at the embedded version and files, with user scripts allowed; 1 otherwise.

```text
$ chromefile status
extension claude-browser-bridge: installed (version 0.1.0, enabled, from ~/Library/Application Support/chromefile/extensions/claude-browser-bridge)
embedded copy: matches (version 0.1.0, ~/Library/Application Support/chromefile/extensions/claude-browser-bridge)
user scripts: allowed
developer mode: on
```

### uninstall

Removes the extension and deletes the folder above. Chrome removes the extension's registered user scripts (mods) and its storage with it.

```text
$ chromefile uninstall
extension claude-browser-bridge: changed (removed 0.1.0 that was loaded from ~/Library/Application Support/chromefile/extensions/claude-browser-bridge)
note: Chrome removed the extension's registered user scripts (mods) and its storage with it
files: changed (deleted ~/Library/Application Support/chromefile/extensions/claude-browser-bridge)
```

## Building

```sh
cargo build --release   # target/release/chromefile
cargo test
```

The extension lives in `extensions/claude-browser-bridge`, a vendored copy of the bridge's `extension/dist`, with the bridge commit it came from in `extensions/claude-browser-bridge.source`. To update it:

```sh
scripts/vendor-extension.sh [--no-build] [path/to/claude-browser-bridge]
```

It builds the bridge (`npm run build`, skipped with `--no-build`), replaces the vendored copy and records the commit. The default path is a `claude-browser-bridge` checkout next to this repository.

## Testing against Chrome for Testing

Two environment variables exist for tests only:

- `CHROMEFILE_CHROME_APP`: the browser's application name, default `Google Chrome`. Set it to `Google Chrome for Testing` to work against a Chrome for Testing instance instead of your own browser.
- `CHROMEFILE_HOME`: where chromefile keeps its files, default `~/Library/Application Support/chromefile`. Point it at a temporary folder.

Start Chrome for Testing with a window (not headless) and a throwaway profile that already allows JavaScript from Apple Events:

```sh
profile="$(mktemp -d)"
mkdir -p "$profile/Default"
echo '{"browser":{"allow_javascript_apple_events":true}}' > "$profile/Default/Preferences"
open -na "/path/to/Google Chrome for Testing.app" --args --user-data-dir="$profile" --no-first-run
CHROMEFILE_CHROME_APP="Google Chrome for Testing" CHROMEFILE_HOME="$(mktemp -d)" chromefile install
```
