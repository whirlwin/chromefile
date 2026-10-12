# Architecture

```
Claude Code ──stdio (MCP)──▶ cbb mcp ──Unix socket (NDJSON)──▶ cbb host ◀──native messaging──▶ extension
```

Chrome spawns the native host when the extension calls `chrome.runtime.connectNative`,
so Claude Code can never be the host itself, nor wake the extension. A small MCP
server, spawned by Claude Code, reaches the host through a Unix socket instead.

## Processes

| Process     | Started by  | stdin/stdout                        | Role                                  |
|-------------|-------------|-------------------------------------|---------------------------------------|
| extension   | Chrome      | n/a                                 | Executes commands with `chrome.*` APIs |
| `cbb host`  | Chrome      | native messaging framing            | Relays between extension and socket    |
| `cbb mcp`   | Claude Code | MCP over stdio                      | Exposes tools, forwards to socket      |
| `cbb call`  | a script    | prints one result as JSON           | One request over the socket, then exits |

Both `cbb` modes use stdout as a protocol channel. Logging goes to stderr only;
a stray `console.log` corrupts the framing.

## Socket

- Path: `~/Library/Application Support/claude-browser-bridge/bridge.sock`
  (override with `CBB_SOCKET` for tests).
- Directory mode `0700`, socket mode `0600`. The trust boundary is the OS user:
  any process running as you can connect.
- The newest host wins: on startup the host unlinks any existing socket and binds.
  On exit (Chrome closed the port, stdin EOF) it unlinks the socket only if it
  still owns it (inode check). "Newest wins" only applies to new connections:
  an MCP client already connected to an older host (say, another Chrome
  profile) keeps talking to it until that connection drops.
- No socket, or connection refused, means "browser not connected".
- Multiple MCP clients may connect at once. The host rewrites request ids to
  `<clientNumber>:<id>` before forwarding and restores them on the way back.

## Messages

All three hops carry the same JSON shapes. Socket framing is newline-delimited
JSON. Native messaging framing is a 4-byte little-endian length prefix followed
by UTF-8 JSON.

Request (MCP → host → extension):

```json
{ "id": "42", "method": "tabs.list", "params": {} }
```

Response (extension → host → MCP), exactly one per request:

```json
{ "id": "42", "result": { } }
{ "id": "42", "error": { "code": "not_found", "message": "No tab with id 7" } }
```

Event (extension → host, no id), sent once on connect:

```json
{ "event": "hello", "version": "0.1.0", "userAgent": "..." }
```

The host answers a request with error code `not_connected` if the extension port
is gone, and `too_large` if the encoded message exceeds 1 MiB (Chrome's limit for
host → extension messages). Extension → host messages may be up to 64 MiB, so
screenshots are fine.

Request (extension -> host), started by the extension on behalf of a mod. The id
always starts with `x-`, which never collides with the host's `<client>:<id>`
ids; the host answers on stdout with the same id, and the extension tells such
a reply from a host request by the `x-` prefix and the missing `method`:

```json
{ "id": "x-1", "method": "claude.spawn", "params": { "prompt": "...", "email": null, "origin": "https://outlook.office.com" } }
{ "id": "x-1", "result": {} }
{ "id": "x-1", "error": { "code": "internal", "message": "osascript failed: ..." } }
```

Error codes: `not_connected`, `too_large`, `bad_request`, `not_found`,
`unavailable` (API missing or disabled, message explains how to enable it),
`disabled` (kill switch on), `internal`, and `timeout`. `timeout` is produced
on the MCP side when the host never answered (30 s by default, 120 s for
`page_eval` with `awaitPromise`); it never travels over the socket.

## Methods

`tabId` is optional everywhere it appears; it defaults to the active tab of the
last focused window.

| Method              | Params                                              | Result                                   | Implementation                                  |
|---------------------|-----------------------------------------------------|------------------------------------------|-------------------------------------------------|
| `tabs.list`         | `{}`                                                | `{ tabs: [{id, windowId, url, title, active, groupId}] }` | `chrome.tabs.query`                 |
| `tabs.open`         | `{ url, active? }`                                  | `{ tab }`                                | `chrome.tabs.create`                            |
| `tabs.close`        | `{ tabIds: number[] }`                              | `{}`                                     | `chrome.tabs.remove`                            |
| `tabs.navigate`     | `{ tabId?, url }`                                   | `{ tab }`                                | `chrome.tabs.update`                            |
| `tabs.focus`        | `{ tabId }`                                         | `{}`                                     | `tabs.update` + `windows.update`                |
| `tabs.group`        | `{ tabIds, title?, color? }`                        | `{ groupId }`                            | `chrome.tabs.group` + `tabGroups.update`        |
| `page.eval`         | `{ tabId?, expression, awaitPromise? }`             | `{ value }` or error with exception text | CDP `Runtime.evaluate`, `returnByValue: true`   |
| `page.cdp`          | `{ tabId?, method, params? }`                       | `{ result }`                             | `chrome.debugger.sendCommand`                   |
| `page.css`          | `{ tabId?, css, remove? }`                          | `{}`                                     | `chrome.scripting.insertCSS` / `removeCSS`      |
| `page.screenshot`   | `{ tabId?, format? ("png"\|"jpeg") }`               | `{ data (base64), mimeType }`            | CDP `Page.captureScreenshot`                    |
| `page.text`         | `{ tabId? }`                                        | `{ url, title, text }`                   | CDP `Runtime.evaluate` of `document.body.innerText` |
| `mods.list`         | `{}`                                                | `{ mods: [...] }`                        | `chrome.userScripts.getScripts`                 |
| `mods.register`     | `{ id, matches, js, runAt?, world? }`               | `{}`                                     | `chrome.userScripts.register` (update if exists) |
| `mods.unregister`   | `{ ids }`                                           | `{}`                                     | `chrome.userScripts.unregister`                 |
| `net.rules.list`    | `{}`                                                | `{ rules }`                              | `declarativeNetRequest.getDynamicRules`         |
| `net.rules.add`     | `{ rules }` (DNR rule objects)                      | `{}`                                     | `updateDynamicRules({ addRules })`               |
| `net.rules.remove`  | `{ ids }`                                           | `{}`                                     | `updateDynamicRules({ removeRuleIds })`          |
| `chrome.call`       | `{ path: "cookies.getAll", args: [] }`              | `{ result }`                             | Resolves `chrome.<path>` and awaits it          |

`page.*` methods that use CDP attach `chrome.debugger` (protocol `1.3`) to the tab
on first use and stay attached; Chrome shows its "is debugging this browser" bar
while attached, which doubles as a visible indicator. The kill switch detaches
everything.

`mods.*` need the per-extension "Allow User Scripts" toggle (extension Details
page). Without it `chrome.userScripts` is undefined and the extension returns
`unavailable` with instructions.

## MCP tools

One tool per method, named with underscores (`tabs_list`, `page_eval`,
`net_rules_add`, `chrome_call`, ...). `page_screenshot` returns an MCP image
content block; everything else returns JSON text.

`bridge_status` (method `bridge.status`) is answered by the host itself:
`{ connected: true, hello }`. The host only runs while Chrome holds its port, so
when no host is listening (no socket, or connection refused) the MCP server
returns a normal, non-error result `{ "connected": false, "message": "..." }`,
so Claude can tell "not connected" apart from a failure.

## Kill switch

The popup toggles `enabled` in `chrome.storage.local`. When disabled the
extension detaches all debugger sessions, disconnects the native port, does not
reconnect, and the badge shows `OFF`. While connected the badge shows `ON`, and
`...` while it waits to reconnect.

The popup and the service worker never message each other directly; they
communicate through `chrome.storage`. The popup writes `enabled` to
`storage.local`; the worker publishes its connection status and a log of recent
commands to `storage.session`, which the popup reads and watches.

Reconnects back off with a `setTimeout`, backed by a `chrome.alarms` alarm
(hence the `alarms` permission) because an idle MV3 worker can be suspended and
lose its timers.

## Extension-initiated requests (mods to Claude Code)

A mod running in the `USER_SCRIPT` world can ask the bridge to open a new
interactive Claude Code session in a new tab of the current iTerm2 window.

```
mod ──chrome.runtime.sendMessage──▶ extension ──{id:"x-n", method:"claude.spawn"}──▶ cbb host ──osascript──▶ iTerm2: claude "<prompt>"
```

### User script messaging contract

On every worker start and after every `mods.register` the extension calls
`chrome.userScripts.configureWorld({ messaging: true })` (there is no event for
the "Allow User Scripts" toggle, and failures are ignored). A mod then sends:

```js
const reply = await chrome.runtime.sendMessage({
  type: "claude.spawn",
  prompt: "Draft a reply to this email",          // required, 1 to 10,000 chars
  email: {                                          // optional, or null
    subject, from, to, cc, date,                    // optional strings, 2,000 chars each
    body,                                           // optional string, truncated at 200,000 chars with "\n[truncated]"
  },
});
// reply: { ok: true } or { ok: false, error: "..." }
```

The extension listens on `chrome.runtime.onUserScriptMessage`, which only
fires for user scripts this extension registered. Anything not shaped like
the above gets `{ ok: false, error: "unsupported message" }`; a wrong type or an
oversized field gets a specific error. The extension adds the sender's origin
(`origin`, from `sender.url`, or `"unknown"`). When the kill switch is on or the
native port is down the reply is `{ ok: false, error: "Claude Browser Bridge is
not connected" }`. Otherwise it sends `claude.spawn` to the host and waits up to
15 s; port loss or the kill switch fails waiting requests at once. Each spawn is
recorded in the popup's command log.

### `claude.spawn` on the host

Only `claude.spawn` is accepted from the extension; any other method gets
`bad_request`. The host validates the params again, since it is the trusted
side and composes the prompt itself:

| Param    | Type                                                    |
|----------|---------------------------------------------------------|
| `prompt` | string, non-empty after trim (else `bad_request`)       |
| `email`  | `{ subject?, from?, to?, cc?, date?, body? }` or `null` |
| `origin` | string, the page origin the mod ran on                  |

The composed prompt is the user's prompt, then (with an email) a block telling
Claude the email is untrusted content from `origin` and wrapping it in
`<email>...</email>` with the present header lines (`Subject`, `From`, `To`,
`Cc`, `Date`), a blank line and the body. Literal `<email>`/`</email>` tags inside
the email are escaped and header values are kept on one line, so the email
cannot end the block early or forge headers.

The prompt goes to `claude` as a positional argument. `claude --help` does not
document `--`, so it is not used; instead a prompt that starts with `-` or has
no whitespace (and so could be read as an option or a subcommand such as
`update`) is prefixed with `Prompt: `.

- **Config:** `<appdir>/config.json`, where `<appdir>` is the socket's
  directory (`~/Library/Application Support/claude-browser-bridge`, or the
  directory of `CBB_SOCKET`): `{ "claude": { "cwd": "/abs/path" } }`. A
  leading `~` is expanded. Default `~/git`; a missing directory or a relative
  path falls back to the home directory.
- **Sessions:** the composed prompt is written to
  `<appdir>/sessions/<ISO timestamp>-<random>.md` (directory `0700`, file
  `0600`). Files older than 7 days are deleted on each spawn.
- **Launch:** `osascript` is run with `execFile` (no shell). The AppleScript is
  passed as `-e` lines and the cwd and file path as trailing argv, used only via
  `quoted form of`, never interpolated into the script. It activates iTerm2,
  creates a window if there is none or a tab in the current window otherwise,
  and types `cd '<cwd>' && claude "$(cat '<file>')"` into the new session.
  `CBB_OSASCRIPT` overrides the binary (tests). A failure is `internal` with
  osascript's stderr.

The first spawn triggers macOS's Automation prompt ("Google Chrome wants to
control iTerm2"), because Chrome spawned the host and is the responsible
process. While that prompt is open the extension's 15 s timeout may fire and
the host's late reply is dropped; that is expected. The host gives osascript
120 s.

## `cbb call`

`cbb call <method> [json-params]` connects to the socket, sends one request
(`params` must be a JSON object, default `{}`), prints the `result` as JSON on
stdout and exits 0. A bridge error prints `code: message` on stderr and exits
1; not connected (no host listening) exits 2, as does a missing method. Used by
scripts, e.g. `node host/dist/cbb.js call mods.list`.
