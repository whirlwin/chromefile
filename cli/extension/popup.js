// src/constants.ts
var ENABLED_KEY = "enabled";
var STATUS_KEY = "status";
var LOG_KEY = "log";
function userScriptsHint(extensionId) {
  return `Enable 'Allow User Scripts' on the extension's Details page (chrome://extensions/?id=${extensionId})`;
}

// src/popup.ts
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from popup.html`);
  return node;
}
var LABELS = {
  connecting: "Connecting...",
  connected: "Connected",
  disconnected: "Disconnected",
  disabled: "Disabled"
};
var enabled = true;
async function render() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(ENABLED_KEY),
    chrome.storage.session.get([STATUS_KEY, LOG_KEY])
  ]);
  enabled = local[ENABLED_KEY] !== false;
  const status = session[STATUS_KEY];
  renderStatus(status);
  renderLog(session[LOG_KEY] ?? []);
}
function renderStatus(status) {
  const state = enabled ? status?.state ?? "disconnected" : "disabled";
  el("dot").className = `dot ${state}`;
  el("state").textContent = LABELS[state];
  const details = [];
  if (state !== "disabled" && status) {
    if (status.state === "connected") details.push(`since ${new Date(status.since).toLocaleTimeString()}`);
    if (status.error) details.push(status.error);
    if (status.retryAt) details.push(`retrying at ${new Date(status.retryAt).toLocaleTimeString()}`);
  }
  el("detail").textContent = details.join(" \xB7 ");
  const toggle = el("toggle");
  toggle.disabled = false;
  toggle.textContent = enabled ? "Disable bridge" : "Enable bridge";
  toggle.className = enabled ? "disable" : "";
}
function renderLog(log) {
  const list = el("log");
  list.replaceChildren(
    ...log.slice().reverse().map((entry) => {
      const item = document.createElement("li");
      const method = document.createElement("span");
      method.textContent = entry.method;
      if (!entry.ok) method.className = "fail";
      const time = document.createElement("span");
      time.className = "muted";
      time.textContent = new Date(entry.time).toLocaleTimeString();
      item.append(method, time);
      return item;
    })
  );
  el("log-empty").hidden = log.length > 0;
}
async function renderUserScripts() {
  const target = el("user-scripts");
  try {
    if (!chrome.userScripts) throw new Error("undefined");
    await chrome.userScripts.getScripts({ ids: [] });
    target.textContent = "Available";
  } catch {
    target.textContent = `Unavailable. ${userScriptsHint(chrome.runtime.id)}`;
  }
}
el("toggle").addEventListener("click", () => {
  void chrome.storage.local.set({ [ENABLED_KEY]: !enabled });
});
chrome.storage.onChanged.addListener(() => void render());
el("extension-id").textContent = chrome.runtime.id;
void render();
void renderUserScripts();
