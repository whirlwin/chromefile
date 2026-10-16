// Chromefile's `tabs.duplicate.action`: what happens when a new tab loads a
// page another tab already shows. With "ask" the new tab offers to close the
// older ones; with "auto-close-duplicates" they close at once and the new tab
// offers Undo. Like the keyboard shortcuts it is a local convenience, so it
// works while the kill switch is off. See docs/architecture.md, "Duplicate
// tabs".
//
// The worker may be suspended between a tab's creation and its load, so which
// tabs are new lives in chrome.storage.session, one key per tab, so that
// concurrent events never read, modify and write a shared value.
import { DUPLICATES_KEY, duplicateAction } from "./constants";
import type { DuplicateAction } from "./constants";
import { showDuplicatePrompt } from "./duplicatePrompt";

// The messages the card's buttons send (duplicatePrompt.ts has its own copies).
export const CLOSE_OLDER = "duplicates.closeOlder";
export const UNDO = "duplicates.undo";
// Tabs created this soon after the browser started are session restore.
export const QUIET_MS = 10_000;
// chrome.storage.session, cleared on browser restart: when onStartup fired.
const STARTED_AT_KEY = "startedAt";
// What a new tab shows before the user picks a page.
const BLANK_URLS = new Set(["chrome://newtab/", "chrome://new-tab-page/", "about:blank"]);
// Chrome may list a closed tab under recently closed a moment after
// tabs.remove resolves, so a short match is tried once more after this.
const UNDO_RETRY_MS = 200;

const newTabKey = (tabId: number) => `newTab:${tabId}`;
const bridgeTabKey = (tabId: number) => `bridgeTab:${tabId}`;
const undoKey = (tabId: number) => `undo:${tabId}`;
const restoredTabKey = (tabId: number) => `restoredTab:${tabId}`;

export type TabLike = Pick<chrome.tabs.Tab, "id" | "url" | "pinned" | "incognito" | "active">;

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

// What auto-close takes: the duplicates, but never a tab that is active in its
// window, so Command+clicking a link to the page being read cannot close it
// from under the reader.
export function toAutoClose<T extends TabLike>(tab: TabLike, tabs: T[]): T[] {
  return olderDuplicates(tab, tabs).filter((other) => other.active !== true);
}

// Which recently closed entries bring back the `closed` tabs, most recent
// first, the order to restore in so tabs closed from one window go back to
// their old places. Each entry offers one slot per tab it holds (a window
// entry, recorded when a window's last tab closes, holds several) and each
// closed tab takes one slot with its exact URL, so two closed copies of a page
// need two entries. Entries older than `since` (seconds, like lastModified)
// were closed before the worker acted and are never taken. `matched` says how
// many closed tabs found a slot.
export function undoSessionIds(
  closed: readonly { url?: string }[],
  recent: readonly chrome.sessions.Session[],
  since: number,
): { sessionIds: string[]; matched: number } {
  const free = recent.map((entry) => (entry.lastModified >= since ? restorableUrls(entry) : []));
  const used = new Set<number>();
  let matched = 0;
  for (const { url } of closed) {
    if (url === undefined) continue;
    const index = free.findIndex((urls) => urls.includes(url));
    const urls = free[index];
    if (!urls) continue;
    urls.splice(urls.indexOf(url), 1);
    used.add(index);
    matched++;
  }
  const sessionIds = recent.flatMap((entry, index) => {
    const sessionId = sessionIdOf(entry);
    return used.has(index) && sessionId !== undefined ? [sessionId] : [];
  });
  return { sessionIds: [...new Set(sessionIds)], matched };
}

function sessionIdOf(entry: chrome.sessions.Session): string | undefined {
  return entry.tab ? entry.tab.sessionId : entry.window?.sessionId;
}

// The URLs a recently closed entry would reopen, none if it cannot be restored.
function restorableUrls(entry: chrome.sessions.Session): string[] {
  if (sessionIdOf(entry) === undefined) return [];
  const tabs = entry.tab ? [entry.tab] : (entry.window?.tabs ?? []);
  return tabs.flatMap((tab) => (tab.url === undefined ? [] : [tab.url]));
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

async function currentAction(): Promise<DuplicateAction> {
  const stored = await chrome.storage.local.get(DUPLICATES_KEY);
  return duplicateAction(stored[DUPLICATES_KEY]);
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

// Bridge tabs and tabs Undo brought back are left alone. Like the bridge mark,
// the restored mark may land after the tab's load starts, so this is read as
// late as possible.
async function leftAlone(tabId: number): Promise<boolean> {
  const keys = [bridgeTabKey(tabId), restoredTabKey(tabId)];
  const marks = await chrome.storage.session.get(keys);
  return keys.some((key) => marks[key] !== undefined);
}

async function tabCreated(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  const now = Date.now();
  const [action, session] = await Promise.all([currentAction(), chrome.storage.session.get(STARTED_AT_KEY)]);
  if (action === "none" || inQuietPeriod(now, session[STARTED_AT_KEY])) return;
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
  if (pageKey(tab.url) === null) return;
  const action = await currentAction();
  if (action === "ask") await offerToClose(tabId, tab);
  if (action === "auto-close-duplicates") await autoCloseQueued(tabId);
}

async function offerToClose(tabId: number, tab: chrome.tabs.Tab): Promise<void> {
  const count = olderDuplicates(tab, await chrome.tabs.query({})).length;
  if (count === 0 || (await leftAlone(tabId))) return;
  await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func: showDuplicatePrompt, args: ["ask", count] });
}

// Auto-closes run one at a time: two copies of a page loading together would
// otherwise each close the other.
let autoCloseQueue = Promise.resolve();
function autoCloseQueued(tabId: number): Promise<void> {
  const task = autoCloseQueue.then(() => autoClose(tabId));
  autoCloseQueue = task.catch(() => {});
  return task;
}

// Reopening an auto-closed tab with Command+Shift+T makes it a new tab like
// any other, so it auto-closes the newer copy in turn (unless that one is
// active) and offers its own Undo. That is accepted rather than special-cased.
async function autoClose(tabId: number): Promise<void> {
  // The tab as it is now: an earlier auto-close may have closed it, and which
  // tabs are active may have changed since it loaded.
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find((other) => other.id === tabId);
  if (!tab) return;
  const targets = toAutoClose(tab, tabs).filter((other): other is chrome.tabs.Tab & { id: number } => other.id !== undefined);
  // Checked before closing, which unlike showing a card cannot be taken back.
  if (targets.length === 0 || (await leftAlone(tabId))) return;
  // lastModified is in whole seconds; one to spare for the rounding.
  const since = Math.floor(Date.now() / 1000) - 1;
  await chrome.tabs.remove(targets.map((other) => other.id));
  // Recorded before the notice appears, so Undo never runs ahead of it. If
  // recording fails the notice still says what was closed.
  try {
    await recordUndo(tabId, targets, since);
  } catch (error) {
    console.warn("duplicates: could not record undo", tabId, error);
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: showDuplicatePrompt,
    args: ["closed", targets.length],
  });
}

// What Undo in `tabId` may restore: the recently closed entries of the tabs
// just closed. Undo reads only this, never anything the page sends.
async function recordUndo(tabId: number, closed: chrome.tabs.Tab[], since: number): Promise<void> {
  let match = undoSessionIds(closed, await chrome.sessions.getRecentlyClosed({ maxResults: 25 }), since);
  if (match.matched < closed.length) {
    await new Promise((resolve) => setTimeout(resolve, UNDO_RETRY_MS));
    match = undoSessionIds(closed, await chrome.sessions.getRecentlyClosed({ maxResults: 25 }), since);
  }
  await chrome.storage.session.set({ [undoKey(tabId)]: { sessionIds: match.sessionIds } });
}

// Restores what was recorded for this tab, once. Each entry is restored on its
// own: one the user already reopened with Command+Shift+T fails without
// costing the rest. Not tied to the current action, since it only brings back
// tabs the worker itself closed.
async function undo(tabId: number): Promise<{ restored: number }> {
  const key = undoKey(tabId);
  const record: unknown = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  let restored = 0;
  for (const sessionId of recordedSessionIds(record)) {
    try {
      const session = await chrome.sessions.restore(sessionId);
      const tabs = session.tab ? [session.tab] : (session.window?.tabs ?? []);
      const ids = tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
      restored += ids.length;
      // Otherwise a restored tab's load would close the tab Undo was clicked
      // in, or ask about it.
      await chrome.storage.session.set(Object.fromEntries(ids.map((id) => [restoredTabKey(id), true])));
    } catch (error) {
      console.warn("duplicates: could not restore", sessionId, error);
    }
  }
  return { restored };
}

function recordedSessionIds(record: unknown): string[] {
  if (typeof record !== "object" || record === null) return [];
  const { sessionIds } = record as { sessionIds?: unknown };
  return Array.isArray(sessionIds) ? sessionIds.filter((id): id is string => typeof id === "string") : [];
}

// What to close is worked out again at click time, from the sender tab as it
// is now, never from anything the prompt was shown with.
async function closeOlder(tabId: number): Promise<{ closed: number }> {
  if ((await currentAction()) !== "ask") return { closed: 0 };
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
    run("tab removed", async () =>
      chrome.storage.session.remove([newTabKey(tabId), bridgeTabKey(tabId), undoKey(tabId), restoredTabKey(tabId)]),
    ),
  );
  // Only the card's buttons send these. Nothing about them is taken on trust:
  // they must come from this extension's script in a tab's top frame, and the
  // worker acts on the sender tab with what it worked out or recorded itself.
  // Other messages get no answer from here.
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const type = typeof message === "object" && message !== null ? (message as { type?: unknown }).type : undefined;
    if (type !== CLOSE_OLDER && type !== UNDO) return;
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || tabId === undefined || sender.frameId !== 0) return;
    const task = type === CLOSE_OLDER ? closeOlder(tabId) : undo(tabId);
    const failed = type === CLOSE_OLDER ? { closed: 0 } : { restored: 0 };
    task.then(sendResponse, (error: unknown) => {
      console.warn(`duplicates: ${type} failed`, error);
      sendResponse(failed);
    });
    return true; // sendResponse is called asynchronously
  });
}
