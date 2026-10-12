// Popup UI: connection status, the kill switch and the recent command log.
// It talks to the worker only through storage: it writes `enabled` to
// chrome.storage.local (which wakes the worker), and renders the status and
// log the worker keeps in chrome.storage.session.
import { ENABLED_KEY, LOG_KEY, STATUS_KEY, userScriptsHint } from "./constants";
import type { Status } from "./constants";
import type { LogEntry } from "./commandLog";

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} missing from popup.html`);
  return node;
}

const LABELS: Record<Status["state"], string> = {
  connecting: "Connecting...",
  connected: "Connected",
  disconnected: "Disconnected",
  disabled: "Disabled",
};

let enabled = true;

async function render(): Promise<void> {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(ENABLED_KEY),
    chrome.storage.session.get([STATUS_KEY, LOG_KEY]),
  ]);
  enabled = local[ENABLED_KEY] !== false;
  const status = session[STATUS_KEY] as Status | undefined;
  renderStatus(status);
  renderLog((session[LOG_KEY] as LogEntry[] | undefined) ?? []);
}

function renderStatus(status: Status | undefined): void {
  const state = enabled ? (status?.state ?? "disconnected") : "disabled";
  el("dot").className = `dot ${state}`;
  el("state").textContent = LABELS[state];

  const details: string[] = [];
  if (state !== "disabled" && status) {
    if (status.state === "connected") details.push(`since ${new Date(status.since).toLocaleTimeString()}`);
    if (status.error) details.push(status.error);
    if (status.retryAt) details.push(`retrying at ${new Date(status.retryAt).toLocaleTimeString()}`);
  }
  el("detail").textContent = details.join(" · ");

  const toggle = el("toggle") as HTMLButtonElement;
  toggle.disabled = false;
  toggle.textContent = enabled ? "Disable bridge" : "Enable bridge";
  toggle.className = enabled ? "disable" : "";
}

function renderLog(log: LogEntry[]): void {
  const list = el("log");
  list.replaceChildren(
    ...log
      .slice()
      .reverse()
      .map((entry) => {
        const item = document.createElement("li");
        const method = document.createElement("span");
        method.textContent = entry.method;
        if (!entry.ok) method.className = "fail";
        const time = document.createElement("span");
        time.className = "muted";
        time.textContent = new Date(entry.time).toLocaleTimeString();
        item.append(method, time);
        return item;
      }),
  );
  el("log-empty").hidden = log.length > 0;
}

// Same probe as the worker: undefined on older Chrome, throws on newer Chrome.
async function renderUserScripts(): Promise<void> {
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
