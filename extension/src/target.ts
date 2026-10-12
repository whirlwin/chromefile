import { BridgeError } from "./protocol";
import type { Params } from "./protocol";
import { optNum } from "./params";

// `tabId` is optional everywhere; it defaults to the active tab of the last
// focused normal window (DevTools and app windows are skipped).
export async function resolveTabId(params: Params): Promise<number> {
  const tabId = optNum(params, "tabId");
  if (tabId !== undefined) return tabId;
  const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined);
  const [tab] = await chrome.tabs.query(win?.id !== undefined ? { active: true, windowId: win.id } : { active: true, lastFocusedWindow: true });
  if (tab?.id === undefined) throw new BridgeError("not_found", "No active tab");
  return tab.id;
}
