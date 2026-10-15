// src/constants.ts
var NATIVE_HOST_NAME = "io.whirlwin.chromefile";
var ENABLED_KEY = "enabled";
var STATUS_KEY = "status";
var LOG_KEY = "log";
var LOG_LIMIT = 50;
function userScriptsHint(extensionId) {
  return `Enable 'Allow User Scripts' on the extension's Details page (chrome://extensions/?id=${extensionId})`;
}

// src/commandLog.ts
function appendLog(log, entry, limit) {
  return [...log, entry].slice(-limit);
}

// src/enabled.ts
async function isEnabled() {
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  return stored[ENABLED_KEY] !== false;
}

// src/protocol.ts
var BridgeError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
  code;
};
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

// src/timeout.ts
function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BridgeError("internal", `${what} timed out after ${ms / 1e3}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// src/debugger.ts
var PROTOCOL_VERSION = "1.3";
var CDP_TIMEOUT_MS = 25e3;
var attached = /* @__PURE__ */ new Set();
function initDebugger() {
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== void 0) attached.delete(source.tabId);
  });
}
async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (error) {
    if (!await isOurs(tabId)) throw error;
  }
  if (!await isEnabled()) {
    await chrome.debugger.detach({ tabId }).catch(() => void 0);
    throw new BridgeError("disabled", "Chromefile was disabled in the extension popup");
  }
  attached.add(tabId);
}
async function isOurs(tabId) {
  const targets = await chrome.debugger.getTargets();
  return targets.some((t) => t.tabId === tabId && t.attached && t.extensionId === chrome.runtime.id);
}
async function sendCommand(tabId, method, params, timeoutMs = CDP_TIMEOUT_MS) {
  const run = async () => {
    await ensureAttached(tabId);
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  };
  return withTimeout(run(), timeoutMs, method);
}
async function detachAll() {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  const tabIds = new Set(attached);
  for (const t of targets) {
    if (t.attached && t.extensionId === chrome.runtime.id && t.tabId !== void 0) tabIds.add(t.tabId);
  }
  attached.clear();
  await Promise.all(
    [...tabIds].map(
      (tabId) => chrome.debugger.detach({ tabId }).catch((error) => {
        console.warn(`detach tab ${tabId}: ${errorMessage(error)}`);
      })
    )
  );
}

// src/dispatcher.ts
var NOT_FOUND_PATTERN = /\bNo (tab|window|group|frame|target) with id\b/i;
async function dispatch(handlers2, message, options) {
  if (!isObject(message) || typeof message.id !== "string" && typeof message.id !== "number") {
    return null;
  }
  const id = String(message.id);
  try {
    if (!await options.isEnabled()) {
      throw new BridgeError("disabled", "Chromefile is disabled in the extension popup");
    }
    const { method, params = {} } = message;
    if (typeof method !== "string") throw new BridgeError("bad_request", "method must be a string");
    if (!isObject(params)) throw new BridgeError("bad_request", "params must be an object");
    const handler = Object.hasOwn(handlers2, method) ? handlers2[method] : void 0;
    if (!handler) throw new BridgeError("bad_request", `Unknown method: ${method}`);
    return { id, result: await handler(params) ?? {} };
  } catch (error) {
    return { id, error: toErrorBody(error) };
  }
}
function toErrorBody(error) {
  if (error instanceof BridgeError) return { code: error.code, message: error.message };
  const message = errorMessage(error);
  return { code: NOT_FOUND_PATTERN.test(message) ? "not_found" : "internal", message };
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/chromePath.ts
function resolveChromePath(root, path) {
  const segments = path.split(".");
  if (segments.some((s) => s === "")) {
    throw new BridgeError("bad_request", `Invalid path: "${path}"`);
  }
  let parent = void 0;
  let current = root;
  for (const segment of segments) {
    if (typeof current !== "object" && typeof current !== "function" || current === null) {
      throw new BridgeError("not_found", `chrome.${path} does not exist`);
    }
    parent = current;
    current = current[segment];
  }
  if (current === void 0 || current === null) {
    throw new BridgeError("not_found", `chrome.${path} does not exist`);
  }
  if (typeof current !== "function") {
    throw new BridgeError("bad_request", `chrome.${path} is not a function`);
  }
  return current.bind(parent);
}

// src/params.ts
function bad(message) {
  throw new BridgeError("bad_request", message);
}
function str(params, key) {
  const value = params[key];
  if (typeof value !== "string" || value === "") bad(`${key} must be a non-empty string`);
  return value;
}
function optStr(params, key) {
  return params[key] === void 0 ? void 0 : str(params, key);
}
function optNum(params, key) {
  const value = params[key];
  if (value === void 0) return void 0;
  if (typeof value !== "number" || !Number.isInteger(value)) bad(`${key} must be an integer`);
  return value;
}
function optBool(params, key) {
  const value = params[key];
  if (value === void 0) return void 0;
  if (typeof value !== "boolean") bad(`${key} must be a boolean`);
  return value;
}
function numList(params, key) {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => Number.isInteger(v))) {
    bad(`${key} must be a non-empty array of integers`);
  }
  return value;
}
function strList(params, key) {
  const value = params[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
    bad(`${key} must be a non-empty array of strings`);
  }
  return value;
}
function objList(params, key) {
  const value = params[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "object" && v !== null && !Array.isArray(v))) {
    bad(`${key} must be an array of objects`);
  }
  return value;
}
function oneOf(params, key, allowed) {
  const value = optStr(params, key);
  if (value !== void 0 && !allowed.includes(value)) {
    bad(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

// src/methods/chromeCall.ts
var chromeCallMethods = {
  "chrome.call": async (params) => {
    const args = params.args ?? [];
    if (!Array.isArray(args)) throw new BridgeError("bad_request", "args must be an array");
    const fn = resolveChromePath(chrome, str(params, "path"));
    return { result: await fn(...args) };
  }
};

// src/userScriptMessages.ts
var NOT_CONNECTED = "Chromefile is not connected";
var UNSUPPORTED = "unsupported message";
var HOST_REQUEST_TIMEOUT_MS = 15e3;
var DRAFT_TIMEOUT_MS = 12e4;
var HOST_ID_PREFIX = "x-";
var MAX_PROMPT = 1e4;
var MAX_FIELD = 2e3;
var MAX_BODY = 2e5;
var TRUNCATED = "\n[truncated]";
var EMAIL_FIELDS = ["subject", "from", "to", "cc", "date", "body"];
var MAX_TWEET_TEXT = 4e3;
var MAX_TWEET_FIELD = 500;
var TWEET_FIELDS = ["author", "handle", "url"];
var PERSONA_NAME = /^[a-z][a-z0-9-]{0,31}$/;
function parseUserScriptMessage(message, senderUrl) {
  if (!isObject2(message)) return { ok: false, error: UNSUPPORTED };
  if (message.type === "claude.spawn") return parseSpawn(message, senderUrl);
  if (message.type === "claude.draft") return parseDraft(message, senderUrl);
  return { ok: false, error: UNSUPPORTED };
}
function parseSpawn(message, senderUrl) {
  const { prompt, email } = message;
  if (typeof prompt !== "string" || prompt.trim() === "") return { ok: false, error: "prompt must be a non-empty string" };
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `prompt exceeds ${MAX_PROMPT} characters` };
  let parsedEmail = null;
  if (email !== void 0 && email !== null) {
    if (!isObject2(email)) return { ok: false, error: "email must be an object or null" };
    parsedEmail = {};
    for (const key of EMAIL_FIELDS) {
      const raw = email[key];
      if (raw === void 0) continue;
      if (typeof raw !== "string") return { ok: false, error: `email.${key} must be a string` };
      let value = raw;
      if (key === "body") {
        if (value.length > MAX_BODY) value = value.slice(0, MAX_BODY) + TRUNCATED;
      } else if (value.length > MAX_FIELD) {
        return { ok: false, error: `email.${key} exceeds ${MAX_FIELD} characters` };
      }
      parsedEmail[key] = value;
    }
  }
  return { ok: true, method: "claude.spawn", params: { prompt, email: parsedEmail, origin: originOf(senderUrl) } };
}
function parseDraft(message, senderUrl) {
  const { persona, tweet } = message;
  if (typeof persona !== "string" || !PERSONA_NAME.test(persona)) {
    return { ok: false, error: "persona must be a lowercase name: a-z, 0-9 and -, at most 32 characters, starting with a letter" };
  }
  if (!isObject2(tweet)) return { ok: false, error: "tweet must be an object" };
  const { text } = tweet;
  if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "tweet.text must be a non-empty string" };
  if (text.length > MAX_TWEET_TEXT) return { ok: false, error: `tweet.text exceeds ${MAX_TWEET_TEXT} characters` };
  const parsedTweet = { text };
  for (const key of TWEET_FIELDS) {
    const value = tweet[key];
    if (value === void 0) continue;
    if (typeof value !== "string") return { ok: false, error: `tweet.${key} must be a string` };
    if (value.length > MAX_TWEET_FIELD) return { ok: false, error: `tweet.${key} exceeds ${MAX_TWEET_FIELD} characters` };
    parsedTweet[key] = value;
  }
  return {
    ok: true,
    method: "claude.draft",
    params: { persona, tweet: parsedTweet, origin: originOf(senderUrl) }
  };
}
function originOf(url) {
  try {
    return url ? new URL(url).origin : "unknown";
  } catch {
    return "unknown";
  }
}
function isHostReply(message) {
  return isObject2(message) && typeof message.id === "string" && message.id.startsWith(HOST_ID_PREFIX) && !("method" in message);
}
var HostRequests = class {
  constructor(timeoutMs = HOST_REQUEST_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }
  timeoutMs;
  pending = /* @__PURE__ */ new Map();
  next = 1;
  request(method, params, post, timeoutMs = this.timeoutMs) {
    const id = `${HOST_ID_PREFIX}${this.next++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `No reply from the host within ${timeoutMs / 1e3}s` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        post({ id, method, params });
      } catch (error) {
        this.settle(id, { ok: false, error: errorMessage(error) });
      }
    });
  }
  /**
   * Settles the matching request. Unknown or late replies are dropped. A
   * string `text` in the result (claude.draft) is passed on to the mod.
   */
  handleReply(message) {
    if (message.error) {
      this.settle(message.id, { ok: false, error: String(message.error.message ?? "Unknown error") });
    } else if (isObject2(message.result) && typeof message.result.text === "string") {
      this.settle(message.id, { ok: true, text: message.result.text });
    } else {
      this.settle(message.id, { ok: true });
    }
  }
  /** The port went away or the kill switch flipped: fail everything now. */
  failAll(error) {
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, error });
  }
  settle(id, reply) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(reply);
  }
};
function enableUserScriptMessaging() {
  try {
    void chrome.userScripts?.configureWorld({ messaging: true }).catch(() => void 0);
  } catch {
  }
}
function isObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/methods/mods.ts
async function userScripts() {
  const unavailable = new BridgeError("unavailable", userScriptsHint(chrome.runtime.id));
  let api;
  try {
    api = chrome.userScripts;
    if (!api) throw unavailable;
    await api.getScripts({ ids: [] });
  } catch {
    throw unavailable;
  }
  return api;
}
var registerQueue = Promise.resolve();
function serialized(task) {
  const run = registerQueue.then(task, task);
  registerQueue = run.catch(() => void 0);
  return run;
}
var modsMethods = {
  "mods.list": async () => {
    const api = await userScripts();
    return { mods: await api.getScripts() };
  },
  "mods.register": async (params) => {
    const script = {
      id: str(params, "id"),
      matches: strList(params, "matches"),
      js: [{ code: str(params, "js") }],
      runAt: oneOf(params, "runAt", ["document_start", "document_end", "document_idle"]) ?? "document_idle",
      world: oneOf(params, "world", ["MAIN", "USER_SCRIPT"]) ?? "USER_SCRIPT"
    };
    const api = await userScripts();
    return serialized(async () => {
      const existing = await api.getScripts({ ids: [script.id] });
      try {
        await (existing.length > 0 ? api.update([script]) : api.register([script]));
      } catch (error) {
        throw new BridgeError("bad_request", errorMessage(error));
      }
      enableUserScriptMessaging();
      return {};
    });
  },
  "mods.unregister": async (params) => {
    const ids = strList(params, "ids");
    const api = await userScripts();
    await api.unregister({ ids });
    return {};
  }
};

// src/methods/net.ts
async function updateRules(options) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules(options);
  } catch (error) {
    throw new BridgeError("bad_request", errorMessage(error));
  }
}
var netMethods = {
  "net.rules.list": async () => ({ rules: await chrome.declarativeNetRequest.getDynamicRules() }),
  "net.rules.add": async (params) => {
    const rules = objList(params, "rules");
    await updateRules({ addRules: rules });
    return {};
  },
  "net.rules.remove": async (params) => {
    await updateRules({ removeRuleIds: numList(params, "ids") });
    return {};
  }
};

// src/target.ts
async function resolveTabId(params) {
  const tabId = optNum(params, "tabId");
  if (tabId !== void 0) return tabId;
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => void 0);
  const [tab] = await chrome.tabs.query(win?.id !== void 0 ? { active: true, windowId: win.id } : { active: true, lastFocusedWindow: true });
  if (tab?.id === void 0) throw new BridgeError("not_found", "No active tab");
  return tab.id;
}

// src/methods/page.ts
var AWAIT_TIMEOUT_MS = 115e3;
async function evaluate(tabId, expression, awaitPromise) {
  const response = await sendCommand(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise, userGesture: true },
    awaitPromise ? AWAIT_TIMEOUT_MS : CDP_TIMEOUT_MS
  );
  const details = response.exceptionDetails;
  if (details) {
    throw new BridgeError("internal", details.exception?.description ?? details.text);
  }
  return response.result.value ?? null;
}
var TEXT_EXPRESSION = "({url: location.href, title: document.title, text: document.body?.innerText ?? ''})";
var pageMethods = {
  "page.eval": async (params) => {
    const tabId = await resolveTabId(params);
    const value = await evaluate(tabId, str(params, "expression"), optBool(params, "awaitPromise") ?? true);
    return { value };
  },
  "page.cdp": async (params) => {
    const tabId = await resolveTabId(params);
    const cdpParams = params.params;
    if (cdpParams !== void 0 && (typeof cdpParams !== "object" || cdpParams === null || Array.isArray(cdpParams))) {
      throw new BridgeError("bad_request", "params must be an object");
    }
    const result = await sendCommand(tabId, str(params, "method"), cdpParams);
    return { result };
  },
  "page.css": async (params) => {
    const injection = { target: { tabId: await resolveTabId(params) }, css: str(params, "css") };
    if (optBool(params, "remove")) {
      await chrome.scripting.removeCSS(injection);
    } else {
      await chrome.scripting.insertCSS(injection);
    }
    return {};
  },
  "page.screenshot": async (params) => {
    const tabId = await resolveTabId(params);
    const format = oneOf(params, "format", ["png", "jpeg"]) ?? "png";
    const { data } = await sendCommand(tabId, "Page.captureScreenshot", { format, captureBeyondViewport: false });
    return { data, mimeType: `image/${format}` };
  },
  "page.text": async (params) => {
    const tabId = await resolveTabId(params);
    return await evaluate(tabId, TEXT_EXPRESSION, false);
  }
};

// src/methods/tabs.ts
var GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
function summarize(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? tab.pendingUrl,
    title: tab.title,
    active: tab.active,
    groupId: tab.groupId
  };
}
var tabsMethods = {
  "tabs.list": async () => {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.map(summarize) };
  },
  "tabs.open": async (params) => {
    const tab = await chrome.tabs.create({ url: str(params, "url"), active: optBool(params, "active") ?? true });
    return { tab: summarize(tab) };
  },
  "tabs.close": async (params) => {
    await chrome.tabs.remove(numList(params, "tabIds"));
    return {};
  },
  "tabs.navigate": async (params) => {
    const tab = await chrome.tabs.update(await resolveTabId(params), { url: str(params, "url") });
    return { tab: tab ? summarize(tab) : void 0 };
  },
  "tabs.focus": async (params) => {
    const tab = await chrome.tabs.update(await resolveTabId(params), { active: true });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    return {};
  },
  "tabs.group": async (params) => {
    const tabIds = numList(params, "tabIds");
    const title = optStr(params, "title");
    const color = oneOf(params, "color", GROUP_COLORS);
    const groupId = await chrome.tabs.group({ tabIds });
    if (title !== void 0 || color !== void 0) {
      await chrome.tabGroups.update(groupId, { title, color });
    }
    return { groupId };
  }
};

// src/methods/index.ts
var handlers = {
  ...tabsMethods,
  ...pageMethods,
  ...modsMethods,
  ...netMethods,
  ...chromeCallMethods
};

// src/shortcuts.ts
var SHORTCUT_STEPS = {
  "select-previous-tab": -1,
  "select-next-tab": 1
};
function wrapIndex(current, step, count) {
  return ((current + step) % count + count) % count;
}
async function switchTab(step) {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const current = tabs.findIndex((tab) => tab.active);
  if (current === -1 || tabs.length < 2) return;
  const target = tabs[wrapIndex(current, step, tabs.length)];
  if (target?.id !== void 0) await chrome.tabs.update(target.id, { active: true });
}
function initShortcuts() {
  chrome.commands.onCommand.addListener((command) => {
    const step = SHORTCUT_STEPS[command];
    if (step !== void 0) switchTab(step).catch((err) => console.error("shortcut failed", command, err));
  });
}

// src/background.ts
var RETRY_ALARM = "reconnect";
var RETRY_MIN_MS = 1e3;
var RETRY_MAX_MS = 6e4;
var ALARM_MIN_MS = 3e4;
var STABLE_MS = 1e4;
var ALIVE_MS = 500;
var port = null;
var starting = false;
var retryDelay = RETRY_MIN_MS;
var retryTimer;
var generation = 0;
var hostRequests = new HostRequests();
async function start() {
  enableUserScriptMessaging();
  if (port || starting) return;
  starting = true;
  try {
    let enabled;
    let seen;
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
function connect() {
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
  p.onMessage.addListener((message) => {
    markAlive();
    void handleMessage(p, message);
  });
  p.onDisconnect.addListener(() => {
    clearTimeout(aliveTimer);
    const error = chrome.runtime.lastError?.message;
    console.warn("native port disconnected:", error ?? "(no error)");
    if (port !== p) return;
    port = null;
    hostRequests.failAll(NOT_CONNECTED);
    if (Date.now() - connectedAt >= STABLE_MS) retryDelay = RETRY_MIN_MS;
    scheduleRetry(error);
  });
  p.postMessage({ event: "hello", version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent });
  void setStatus({ state: "connecting", since: connectedAt });
}
function scheduleRetry(error) {
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  const retryAt = Date.now() + delay;
  retryTimer = setTimeout(() => void start(), delay);
  void chrome.alarms.create(RETRY_ALARM, { when: Date.now() + Math.max(delay, ALARM_MIN_MS) });
  void setStatus({ state: "disconnected", since: Date.now(), error, retryAt });
}
function clearRetry() {
  clearTimeout(retryTimer);
  retryTimer = void 0;
  void chrome.alarms.clear(RETRY_ALARM);
}
async function disable() {
  clearRetry();
  const p = port;
  port = null;
  p?.disconnect();
  hostRequests.failAll(NOT_CONNECTED);
  const seen = generation;
  await detachAll();
  if (seen === generation) await setStatus({ state: "disabled", since: Date.now() });
}
async function handleMessage(p, message) {
  if (isHostReply(message)) {
    hostRequests.handleReply(message);
    return;
  }
  const response = await dispatch(handlers, message, { isEnabled });
  if (!response) {
    console.warn("dropping message without an id", message);
    return;
  }
  const method = message.method;
  void recordCommand(typeof method === "string" ? method : "?", "result" in response);
  send(p, response);
}
function send(p, response) {
  try {
    p.postMessage(response);
  } catch (error) {
    console.warn("postMessage failed", error);
    if (!("result" in response)) return;
    try {
      p.postMessage({ id: response.id, error: { code: "internal", message: `Could not send result: ${String(error)}` } });
    } catch {
    }
  }
}
var logQueue = Promise.resolve();
function recordCommand(method, ok) {
  logQueue = logQueue.then(async () => {
    const stored = await chrome.storage.session.get(LOG_KEY);
    const log = stored[LOG_KEY] ?? [];
    const entry = { time: (/* @__PURE__ */ new Date()).toISOString(), method, ok };
    await chrome.storage.session.set({ [LOG_KEY]: appendLog(log, entry, LOG_LIMIT) });
  }).catch((error) => console.warn("command log write failed", error));
  return logQueue;
}
async function handleUserScriptMessage(message, senderUrl) {
  const parsed = parseUserScriptMessage(message, senderUrl);
  if (!parsed.ok) return parsed;
  const p = port;
  if (!p || !await isEnabled()) return { ok: false, error: NOT_CONNECTED };
  const timeout = parsed.method === "claude.draft" ? DRAFT_TIMEOUT_MS : HOST_REQUEST_TIMEOUT_MS;
  const reply = await hostRequests.request(parsed.method, parsed.params, (m) => p.postMessage(m), timeout);
  if (!reply.ok) console.warn(`${parsed.method} failed:`, reply.error);
  void recordCommand(parsed.method, reply.ok);
  return reply;
}
var BADGES = {
  connecting: { text: "...", color: "#d97757" },
  connected: { text: "ON", color: "#16a34a" },
  disabled: { text: "OFF", color: "#6b7280" },
  disconnected: { text: "...", color: "#d97757" }
};
async function setStatus(status) {
  const badge = BADGES[status.state];
  await Promise.all([
    chrome.action.setBadgeText({ text: badge.text }),
    chrome.action.setBadgeBackgroundColor({ color: badge.color }),
    chrome.storage.session.set({ [STATUS_KEY]: status })
  ]).catch((error) => console.warn("status update failed", error));
}
initDebugger();
initShortcuts();
chrome.runtime.onUserScriptMessage?.addListener((message, sender, sendResponse) => {
  handleUserScriptMessage(message, sender.url).then(
    sendResponse,
    (error) => sendResponse({ ok: false, error: String(error) })
  );
  return true;
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
