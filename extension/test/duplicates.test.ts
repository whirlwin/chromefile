import { describe, expect, it } from "vitest";
import { duplicateAction } from "../src/constants";
import { showDuplicatePrompt } from "../src/duplicatePrompt";
import {
  CLOSE_OLDER,
  inQuietPeriod,
  isBlankPage,
  olderDuplicates,
  pageKey,
  QUIET_MS,
  toAutoClose,
  UNDO,
  undoSessionIds,
} from "../src/duplicates";
import type { TabLike } from "../src/duplicates";

describe("pageKey", () => {
  it("drops the fragment and keeps the query", () => {
    expect(pageKey("https://example.com/a?q=1#section")).toBe("https://example.com/a?q=1");
    expect(pageKey("https://example.com/a#")).toBe("https://example.com/a");
    expect(pageKey("http://example.com")).toBe("http://example.com/");
  });

  it("is null for anything but http and https", () => {
    for (const url of ["chrome://newtab/", "about:blank", "file:///tmp/x.html", "chrome-extension://abc/popup.html"]) {
      expect(pageKey(url)).toBeNull();
    }
  });

  it("is null for garbage and missing URLs", () => {
    expect(pageKey("not a url")).toBeNull();
    expect(pageKey("")).toBeNull();
    expect(pageKey(undefined)).toBeNull();
  });
});

type Tab = TabLike & { windowId: number };
const tab = (id: number, url: string, extra: Partial<Tab> = {}): Tab => ({
  id,
  url,
  pinned: false,
  incognito: false,
  active: false,
  windowId: 1,
  ...extra,
});
const page = "https://example.com/a?q=1";

describe("olderDuplicates", () => {
  it("finds other tabs on the same page, ignoring fragments and windows", () => {
    const self = tab(9, page);
    const tabs = [self, tab(1, page), tab(2, `${page}#top`), tab(3, page, { windowId: 2 })];
    expect(olderDuplicates(self, tabs).map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it("skips itself, pinned tabs, the other incognito state and other queries", () => {
    const self = tab(9, page);
    const tabs = [
      self,
      tab(1, page, { pinned: true }),
      tab(2, page, { incognito: true }),
      tab(3, "https://example.com/a?q=2"),
      tab(4, "https://example.com/a"),
    ];
    expect(olderDuplicates(self, tabs)).toEqual([]);
    expect(olderDuplicates(tab(8, page, { incognito: true }), tabs).map((t) => t.id)).toEqual([2]);
  });

  it("finds nothing for pages it cannot handle", () => {
    expect(olderDuplicates(tab(9, "chrome://newtab/"), [tab(1, "chrome://newtab/")])).toEqual([]);
  });

  it("offers active tabs too", () => {
    expect(olderDuplicates(tab(9, page), [tab(1, page, { active: true })]).map((t) => t.id)).toEqual([1]);
  });
});

describe("toAutoClose", () => {
  it("takes inactive copies, in other windows too", () => {
    const self = tab(9, page, { active: true });
    const tabs = [self, tab(1, page), tab(2, `${page}#top`, { windowId: 2 })];
    expect(toAutoClose(self, tabs).map((t) => t.id)).toEqual([1, 2]);
  });

  it("never takes a tab active in its window, a pinned tab or the other incognito state", () => {
    const self = tab(9, page);
    const tabs = [
      self,
      tab(1, page, { active: true }),
      tab(2, page, { active: true, windowId: 2 }),
      tab(3, page, { pinned: true }),
      tab(4, page, { incognito: true }),
      tab(5, "https://example.com/other"),
      tab(6, page),
    ];
    expect(toAutoClose(self, tabs).map((t) => t.id)).toEqual([6]);
  });
});

describe("undoSessionIds", () => {
  const other = "https://example.com/other";
  const closedTab = (sessionId: string, url: string, lastModified = 100): chrome.sessions.Session => ({
    lastModified,
    tab: { ...tab(0, url), sessionId } as chrome.tabs.Tab,
  });
  const closedWindow = (sessionId: string, urls: string[], lastModified = 100): chrome.sessions.Session => ({
    lastModified,
    window: { sessionId, tabs: urls.map((url) => tab(0, url) as chrome.tabs.Tab) } as chrome.windows.Window,
  });

  it("matches tab entries by URL, most recent first", () => {
    const recent = [closedTab("s1", other), closedTab("s2", page), closedTab("s3", "https://example.com/b")];
    expect(undoSessionIds([{ url: "https://example.com/b" }, { url: page }], recent, 0)).toEqual({
      sessionIds: ["s2", "s3"],
      matched: 2,
    });
  });

  it("matches a window entry holding the closed tab", () => {
    const recent = [closedTab("s1", other), closedWindow("w1", [other, page])];
    expect(undoSessionIds([{ url: page }], recent, 0)).toEqual({ sessionIds: ["w1"], matched: 1 });
  });

  it("lets a window entry stand for each of its tabs once", () => {
    const recent = [closedWindow("w1", [page, page])];
    expect(undoSessionIds([{ url: page }, { url: page }], recent, 0)).toEqual({ sessionIds: ["w1"], matched: 2 });
    expect(undoSessionIds([{ url: page }, { url: page }, { url: page }], recent, 0)).toEqual({
      sessionIds: ["w1"],
      matched: 2,
    });
  });

  it("matches two closed copies of a page to two entries, never reusing one", () => {
    const recent = [closedTab("s1", page), closedTab("s2", page), closedTab("s3", page)];
    expect(undoSessionIds([{ url: page }, { url: page }], recent, 0)).toEqual({ sessionIds: ["s1", "s2"], matched: 2 });
    expect(undoSessionIds([{ url: page }], [closedTab("s1", page)], 0)).toEqual({ sessionIds: ["s1"], matched: 1 });
    expect(undoSessionIds([{ url: page }, { url: page }], [closedTab("s1", page)], 0)).toEqual({
      sessionIds: ["s1"],
      matched: 1,
    });
  });

  it("ignores unrelated entries, other URLs and entries closed before the worker acted", () => {
    const recent = [
      closedTab("s1", other),
      closedTab("s2", `${page}#top`),
      closedTab("s3", page, 99),
      { lastModified: 100 },
      { lastModified: 100, tab: tab(0, page) as chrome.tabs.Tab },
    ];
    expect(undoSessionIds([{ url: page }, {}], recent, 100)).toEqual({ sessionIds: [], matched: 0 });
    expect(undoSessionIds([], recent, 0)).toEqual({ sessionIds: [], matched: 0 });
  });
});

describe("isBlankPage", () => {
  it("is true while a new tab has not picked a page", () => {
    for (const url of ["chrome://newtab/", "chrome://new-tab-page/", "about:blank", "", undefined]) {
      expect(isBlankPage(url)).toBe(true);
    }
  });

  it("is false for real pages", () => {
    expect(isBlankPage("https://example.com/")).toBe(false);
    expect(isBlankPage("chrome://settings/")).toBe(false);
  });
});

describe("inQuietPeriod", () => {
  const startedAt = 1_000_000;

  it("covers tabs created up to QUIET_MS after startup, or before it", () => {
    expect(inQuietPeriod(startedAt - 50, startedAt)).toBe(true);
    expect(inQuietPeriod(startedAt + QUIET_MS - 1, startedAt)).toBe(true);
    expect(inQuietPeriod(startedAt + QUIET_MS, startedAt)).toBe(false);
  });

  it("is off when onStartup has not fired this session", () => {
    expect(inQuietPeriod(startedAt, undefined)).toBe(false);
  });
});

describe("duplicateAction", () => {
  it("keeps the two actions and reads anything else as none", () => {
    expect(duplicateAction("ask")).toBe("ask");
    expect(duplicateAction("auto-close-duplicates")).toBe("auto-close-duplicates");
    expect(duplicateAction("none")).toBe("none");
  });

  it("reads what an earlier version stored, or nothing, as none", () => {
    for (const stored of ["allow", undefined, "ASK", "auto-close", true, null, {}]) expect(duplicateAction(stored)).toBe("none");
  });
});

describe("showDuplicatePrompt", () => {
  // It is serialized on its own, so it carries its own copies of the message types.
  it("sends the messages the worker listens for", () => {
    expect(String(showDuplicatePrompt)).toContain(JSON.stringify(CLOSE_OLDER));
    expect(String(showDuplicatePrompt)).toContain(JSON.stringify(UNDO));
  });
});
