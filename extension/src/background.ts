// MV3 service worker. Owns the native messaging port to `cbb host` and
// dispatches requests to chrome.* APIs (see docs/architecture.md).
//
// An open native port keeps the worker alive, so the connected path needs no
// tricks. While disconnected the worker may be suspended, so every retry is
// scheduled twice: a setTimeout for short delays and a chrome.alarms backstop
// (minimum 30s) that wakes the worker if the timer died with it.
import { ENABLED_KEY, LOG_KEY, LOG_LIMIT, NATIVE_HOST_NAME, STATUS_KEY } from "./constants";
import type { ConnectionState, Status } from "./constants";
import { appendLog } from "./commandLog";
import type { LogEntry } from "./commandLog";
import { detachAll, initDebugger } from "./debugger";
import { dispatch } from "./dispatcher";
import { isEnabled } from "./enabled";
import { handlers } from "./methods/index";
import { initShortcuts } from "./shortcuts";
import type { Response } from "./protocol";
import {
  enableUserScriptMessaging,
  HostRequests,
  isHostReply,
  NOT_CONNECTED,
  parseUserScriptMessage,
} from "./userScriptMessages";
import type { UserScriptReply } from "./userScriptMessages";

const RETRY_ALARM = "reconnect";
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const ALARM_MIN_MS = 30_000;
// A port that stayed up this long was healthy, so the backoff starts over.
const STABLE_MS = 10_000;
// connectNative returns a port even when the host is missing; it disconnects
// almost at once. Only a port that survives this long counts as connected.
const ALIVE_MS = 500;

let port: chrome.runtime.Port | null = null;
let starting = false;
let retryDelay = RETRY_MIN_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
// Bumped on every kill switch change, so async work can tell that the
// `enabled` value it read may be stale.
let generation = 0;
// Requests this extension sends to the host on behalf of mods.
const hostRequests = new HostRequests();

// Idempotent: the startup events, the timer and the alarm may all call this.
// `starting` is set before the first await so overlapping calls cannot open
// two ports (each would spawn its own host process).
async function start(): Promise<void> {
  enableUserScriptMessaging();
  if (port || starting) return;
  starting = true;
  try {
    // Re-read until no toggle happened during the read, so a quick off/on/off
    // cannot leave us connecting on a stale "enabled".
    let enabled: boolean;
    let seen: number;
    do {
      seen = generation;
      enabled = await isEnabled();
    } while (seen !== generation);
    if (!enabled) {
      await setStatus({ state: "disabled", since: Date.now() });
      return;
    }
    connect();
  } catch (error) {
    console.error("start failed", error);
  } finally {
    starting = false;
  }
}

function connect(): void {
  clearRetry();
  const p = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  const connectedAt = Date.now();
  port = p;
  let alive = false;
  const markAlive = () => {
    clearTimeout(aliveTimer);
    if (port === p && !alive) {
      alive = true;
      void setStatus({ state: "connected", since: Date.now() });
    }
  };
  const aliveTimer = setTimeout(markAlive, ALIVE_MS);
  p.onMessage.addListener((message: unknown) => {
    markAlive();
    void handleMessage(p, message);
  });
  p.onDisconnect.addListener(() => {
    clearTimeout(aliveTimer);
    const error = chrome.runtime.lastError?.message;
    console.warn("native port disconnected:", error ?? "(no error)");
    if (port !== p) return; // replaced or closed by the kill switch
    port = null;
    hostRequests.failAll(NOT_CONNECTED);
    if (Date.now() - connectedAt >= STABLE_MS) retryDelay = RETRY_MIN_MS;
    scheduleRetry(error);
  });
  p.postMessage({ event: "hello", version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
  void setStatus({ state: "connecting", since: connectedAt });
}

function scheduleRetry(error: string | undefined): void {
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  const retryAt = Date.now() + delay;
  retryTimer = setTimeout(() => void start(), delay);
  void chrome.alarms.create(RETRY_ALARM, { when: Date.now() + Math.max(delay, ALARM_MIN_MS) });
  void setStatus({ state: "disconnected", since: Date.now(), error, retryAt });
}

function clearRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  void chrome.alarms.clear(RETRY_ALARM);
}

// Kill switch: no CDP sessions, no port, no reconnects.
async function disable(): Promise<void> {
  clearRetry();
  const p = port;
  port = null;
  p?.disconnect(); // our own disconnect() does not fire onDisconnect
  hostRequests.failAll(NOT_CONNECTED);
  const seen = generation;
  await detachAll();
  // If re-enabled meanwhile, start() owns the status now.
  if (seen === generation) await setStatus({ state: "disabled", since: Date.now() });
}

async function handleMessage(p: chrome.runtime.Port, message: unknown): Promise<void> {
  // Replies to our own requests must not reach dispatch(), which would answer
  // them as if they were malformed host requests.
  if (isHostReply(message)) {
    hostRequests.handleReply(message);
    return;
  }
  const response = await dispatch(handlers, message, { isEnabled });
  if (!response) {
    console.warn("dropping message without an id", message);
    return;
  }
  const method = (message as { method?: unknown }).method;
  void recordCommand(typeof method === "string" ? method : "?", "result" in response);
  send(p, response);
}

// Exactly one response per request: if the result cannot be posted (not
// serializable), the caller still gets an error.
function send(p: chrome.runtime.Port, response: Response): void {
  try {
    p.postMessage(response);
  } catch (error) {
    console.warn("postMessage failed", error);
    if (!("result" in response)) return;
    try {
      p.postMessage({ id: response.id, error: { code: "internal", message: `Could not send result: ${String(error)}` } });
    } catch {
      // The port is gone; the host answers pending requests itself.
    }
  }
}

// Writes to storage.session are serialized so concurrent requests do not
// overwrite each other's log entries.
let logQueue = Promise.resolve();
function recordCommand(method: string, ok: boolean): Promise<void> {
  logQueue = logQueue
    .then(async () => {
      const stored = await chrome.storage.session.get(LOG_KEY);
      const log = (stored[LOG_KEY] as LogEntry[] | undefined) ?? [];
      const entry: LogEntry = { time: new Date().toISOString(), method, ok };
      await chrome.storage.session.set({ [LOG_KEY]: appendLog(log, entry, LOG_LIMIT) });
    })
    .catch((error: unknown) => console.warn("command log write failed", error));
  return logQueue;
}

// A mod asked for something (only claude.spawn exists). Mods are scripts this
// extension registered, but the pages they run on are untrusted, so the
// message is validated and the host composes the final prompt.
async function handleUserScriptMessage(message: unknown, senderUrl: string | undefined): Promise<UserScriptReply> {
  const parsed = parseUserScriptMessage(message, senderUrl);
  if (!parsed.ok) return parsed;
  const p = port;
  if (!p || !(await isEnabled())) return { ok: false, error: NOT_CONNECTED };
  const reply = await hostRequests.request("claude.spawn", parsed.params, (m) => p.postMessage(m));
  if (!reply.ok) console.warn("claude.spawn failed:", reply.error);
  void recordCommand("claude.spawn", reply.ok);
  return reply;
}

const BADGES: Record<ConnectionState, { text: string; color: string }> = {
  connecting: { text: "...", color: "#d97757" },
  connected: { text: "ON", color: "#16a34a" },
  disabled: { text: "OFF", color: "#6b7280" },
  disconnected: { text: "...", color: "#d97757" },
};

async function setStatus(status: Status): Promise<void> {
  const badge = BADGES[status.state];
  await Promise.all([
    chrome.action.setBadgeText({ text: badge.text }),
    chrome.action.setBadgeBackgroundColor({ color: badge.color }),
    chrome.storage.session.set({ [STATUS_KEY]: status }),
  ]).catch((error: unknown) => console.warn("status update failed", error));
}

// Listeners are registered synchronously at top level so their events can wake
// a suspended worker.
initDebugger();
initShortcuts();
// Absent on Chrome without user script messaging; registered on its own so a
// failure here cannot cost the listeners below.
chrome.runtime.onUserScriptMessage?.addListener((message, sender, sendResponse) => {
  handleUserScriptMessage(message, sender.url).then(sendResponse, (error: unknown) =>
    sendResponse({ ok: false, error: String(error) }),
  );
  return true; // sendResponse is called asynchronously
});
chrome.runtime.onStartup.addListener(() => void start());
chrome.runtime.onInstalled.addListener(() => void start());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) void start();
});
chrome.storage.onChanged.addListener((changes, area) => {
  const change = changes[ENABLED_KEY];
  if (area !== "local" || !change) return;
  generation++;
  if (change.newValue === false) {
    void disable();
  } else {
    retryDelay = RETRY_MIN_MS;
    void start();
  }
});
void start();
