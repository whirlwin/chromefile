import { markBridgeAction, markBridgeTab } from "../duplicates";
import type { HandlerMap } from "../protocol";
import { numList, optBool, oneOf, optStr, str } from "../params";
import { resolveTabId } from "../target";

const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;

export function summarize(tab: chrome.tabs.Tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url ?? tab.pendingUrl,
    title: tab.title,
    active: tab.active,
    groupId: tab.groupId,
  };
}

export const tabsMethods: HandlerMap = {
  "tabs.list": async () => {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.map(summarize) };
  },

  "tabs.open": async (params) => {
    const tab = await chrome.tabs.create({ url: str(params, "url"), active: optBool(params, "active") ?? true });
    if (tab.id !== undefined) await markBridgeTab(tab.id);
    return { tab: summarize(tab) };
  },

  "tabs.close": async (params) => {
    await chrome.tabs.remove(numList(params, "tabIds"));
    return {};
  },

  "tabs.navigate": async (params) => {
    const tabId = await resolveTabId(params);
    const url = str(params, "url");
    // Marked first, so the page's load cannot run ahead of the mark. If the
    // update fails, the mark runs out on its own.
    await markBridgeAction(tabId);
    const tab = await chrome.tabs.update(tabId, { url });
    return { tab: tab ? summarize(tab) : undefined };
  },

  "tabs.focus": async (params) => {
    const tabId = await resolveTabId(params);
    // Marked first too: switching to a tab may otherwise ask about or close
    // its duplicates, which Claude bringing it forward must never do.
    await markBridgeAction(tabId);
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab) await chrome.windows.update(tab.windowId, { focused: true });
    return {};
  },

  "tabs.group": async (params) => {
    const tabIds = numList(params, "tabIds") as [number, ...number[]];
    const title = optStr(params, "title");
    const color = oneOf(params, "color", GROUP_COLORS);
    const groupId = await chrome.tabs.group({ tabIds });
    if (title !== undefined || color !== undefined) {
      await chrome.tabGroups.update(groupId, { title, color });
    }
    return { groupId };
  },
};
