// Chromefile's `tabs.duplicates: ask`: when a new tab loads a page another tab
// already shows, the new tab offers to close the older ones. Like the keyboard
// shortcuts it is a local convenience, so it works while the kill switch is off.
// See docs/architecture.md, "Duplicate tab prompt".
//
// The worker may be suspended between a tab's creation and its load, so which
// tabs are new lives in chrome.storage.session, one key per tab, so that
// concurrent events never read, modify and write a shared value.
import { DUPLICATES_KEY, duplicatesSetting } from "./constants";
import { showDuplicatePrompt } from "./duplicatePrompt";

// The message the prompt's button sends (duplicatePrompt.ts has its own copy).
export const CLOSE_OLDER = "duplicates.closeOlder";
// Tabs created this soon after the browser started are session restore.
export const QUIET_MS = 10_000;
// chrome.storage.session, cleared on browser restart: when onStartup fired.
const STARTED_AT_KEY = "startedAt";
// What a new tab shows before the user picks a page.
const BLANK_URLS = new Set(["chrome://newtab/", "chrome://new-tab-page/", "about:blank"]);

const newTabKey = (tabId: number) => `newTab:${tabId}`;
const bridgeTabKey = (tabId: number) => `bridgeTab:${tabId}`;

export type TabLike = Pick<chrome.tabs.Tab, "id" | "url" | "pinned" | "incognito">;

// What counts as the same page: the URL without its fragment. Only http(s),
// the pages the prompt can be injected into; null for anything else.
export function pageKey(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

// Other tabs showing the same page as `tab` in the same profile (incognito
// counts as its own). Pinned tabs are kept on purpose and never offered.
export function olderDuplicates<T extends TabLike>(tab: TabLike, tabs: T[]): T[] {
  const key = pageKey(tab.url);
  if (key === null) return [];
  return tabs.filter(
    (other) => other.id !== tab.id && !other.pinned && other.incognito === tab.incognito && pageKey(other.url) === key,
  );
}

// A new tab still on the new tab page has not picked its page yet.
export function isBlankPage(url: string | undefined): boolean {
  return !url || BLANK_URLS.has(url);
}

// onStartup and the onCreated events of restored tabs may arrive in either
// order, so this is checked both when a tab is created and when it loads.
export function inQuietPeriod(createdAt: number, startedAt: unknown): boolean {
  return typeof startedAt === "number" && createdAt < startedAt + QUIET_MS;
}

async function asking(): Promise<boolean> {
  const stored = await chrome.storage.local.get(DUPLICATES_KEY);
  return duplicatesSetting(stored[DUPLICATES_KEY]) === "ask";
}

// Tabs Claude opens with tabs.open never get the prompt. onCreated may fire
// before or after this lands, which is why the mark is checked when the tab
// loads. Never throws: the tab exists, and failing tabs.open now would make
// Claude open it again.
export async function markBridgeTab(tabId: number): Promise<void> {
  try {
    await chrome.storage.session.set({ [bridgeTabKey(tabId)]: true });
  } catch (error) {
    console.warn("duplicates: could not mark bridge tab", tabId, error);
  }
}

async function tabCreated(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const now = Date.now();
  const [ask, session] = await Promise.all([asking(), chrome.storage.session.get(STARTED_AT_KEY)]);
  if (!ask || inQuietPeriod(now, session[STARTED_AT_KEY])) return;
  await chrome.storage.session.set({ [newTabKey(tab.id)]: now });
}

async function tabLoaded(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;
  if (tabId === undefined) return;
  const key = newTabKey(tabId);
  const session = await chrome.storage.session.get([key, STARTED_AT_KEY]);
  const createdAt: unknown = session[key];
  if (createdAt === undefined || isBlankPage(tab.url)) return;
  // Only the first page a new tab loads counts.
  await chrome.storage.session.remove(key);
  if (typeof createdAt === "number" && inQuietPeriod(createdAt, session[STARTED_AT_KEY])) return;
  if (pageKey(tab.url) === null || !(await asking())) return;
  const count = olderDuplicates(tab, await chrome.tabs.query({})).length;
  if (count === 0) return;
  // Read last, to give tabs.open's mark the most time to land.
  const bridgeKey = bridgeTabKey(tabId);
  if ((await chrome.storage.session.get(bridgeKey))[bridgeKey] !== undefined) return;
  await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: showDuplicatePrompt, args: [count] });
}

// What to close is worked out again at click time, from the sender tab as it
// is now, never from anything the prompt was shown with.
async function closeOlder(tabId: number): Promise<{ closed: number }> {
  if (!(await asking())) return { closed: 0 };
  const tab = await chrome.tabs.get(tabId);
  const ids = olderDuplicates(tab, await chrome.tabs.query({})).flatMap((other) => (other.id === undefined ? [] : [other.id]));
  if (ids.length > 0) await chrome.tabs.remove(ids);
  return { closed: ids.length };
}

// Listener failures are logged, never thrown.
function run(what: string, task: () => Promise<unknown>): void {
  task().catch((error: unknown) => console.warn(`duplicates: ${what} failed`, error));
}

// Must be called synchronously at worker start so the events can wake the
// worker. Registered whatever the setting, which each handler reads itself.
export function initDuplicates(): void {
  chrome.runtime.onStartup.addListener(() =>
    run("startup", async () => chrome.storage.session.set({ [STARTED_AT_KEY]: Date.now() })),
  );
  chrome.tabs.onCreated.addListener((tab) => run("tab created", () => tabCreated(tab)));
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete") run("tab loaded", () => tabLoaded(tab));
  });
  chrome.tabs.onRemoved.addListener((tabId) =>
    run("tab removed", async () => chrome.storage.session.remove([newTabKey(tabId), bridgeTabKey(tabId)])),
  );
  // Only the prompt's button sends this. Nothing about it is taken on trust:
  // it must come from this extension's script in a tab's top frame. Other
  // messages get no answer from here.
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (typeof message !== "object" || message === null || (message as { type?: unknown }).type !== CLOSE_OLDER) return;
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || tabId === undefined || sender.frameId !== 0) return;
    closeOlder(tabId).then(sendResponse, (error: unknown) => {
      console.warn("duplicates: closing older tabs failed", error);
      sendResponse({ closed: 0 });
    });
    return true; // sendResponse is called asynchronously
  });
}
