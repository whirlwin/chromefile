import { describe, expect, it } from "vitest";
import { duplicateAction } from "../src/constants";
import { showDuplicatePrompt } from "../src/duplicatePrompt";
import {
  activationActs,
  CLOSE_OLDER,
  inQuietPeriod,
  isApplyHelper,
  isBlankPage,
  isSkipped,
  KEEP,
  loadActs,
  olderDuplicates,
  pageChange,
  pageKey,
  QUIET_MS,
  SKIP_MS,
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

describe("isApplyHelper", () => {
  it("is true for the helper tabs chromefile apply opens", () => {
    for (const url of [
      "chrome://settings/?chromefile=1f2e",
      "chrome://extensions/?chromefile=1f2e",
      "chrome-extension://abc/apply.html?chromefile=1f2e",
    ]) {
      expect(isApplyHelper(url)).toBe(true);
    }
  });

  it("is false for web pages, chrome pages without the marker and garbage", () => {
    for (const url of [
      "https://example.com/?chromefile=1f2e",
      "chrome://settings/",
      "chrome-extension://abc/apply.html?other=1",
      "not a url",
      "",
      undefined,
    ]) {
      expect(isApplyHelper(url)).toBe(false);
    }
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

describe("isSkipped", () => {
  const markedAt = 1_000_000;

  it("is true for SKIP_MS from when the mark was set", () => {
    expect(isSkipped(markedAt, markedAt)).toBe(true);
    expect(isSkipped(markedAt, markedAt + SKIP_MS - 1)).toBe(true);
    expect(isSkipped(markedAt, markedAt + SKIP_MS)).toBe(false);
  });

  it("is false without a mark, or for anything but a time", () => {
    for (const mark of [undefined, null, true, "1000000", {}]) expect(isSkipped(mark, markedAt)).toBe(false);
  });
});

describe("pageChange", () => {
  const startedAt = 1_000_000;
  const createdAt = startedAt + QUIET_MS;
  const later = startedAt + QUIET_MS;
  const other = "https://example.com/other";

  it("lets a new tab on a blank page keep waiting", () => {
    for (const url of ["chrome://newtab/", "chrome://new-tab-page/", "about:blank", "", undefined]) {
      expect(pageChange(createdAt, url, true, startedAt, later)).toEqual({ act: false });
    }
  });

  it("acts on a new tab's first page, active or not, without its fragment", () => {
    expect(pageChange(createdAt, `${page}#top`, false, startedAt, later)).toEqual({ record: page, act: true });
    expect(pageChange(createdAt, page, true, startedAt, later)).toEqual({ record: page, act: true });
    expect(pageChange(createdAt, page, undefined, undefined, later)).toEqual({ record: page, act: true });
  });

  it("records but never acts on a new tab created during session restore", () => {
    expect(pageChange(startedAt + QUIET_MS - 1, page, true, startedAt, later)).toEqual({ record: page, act: false });
  });

  it("records a new tab's first page it cannot handle as none", () => {
    expect(pageChange(createdAt, "chrome://settings/", true, startedAt, later)).toEqual({ record: "", act: false });
  });

  it("does nothing while a tab shows the same page", () => {
    expect(pageChange(page, page, true, startedAt, later)).toEqual({ act: false });
    expect(pageChange(page, `${page}#section`, true, startedAt, later)).toEqual({ act: false });
    expect(pageChange("", "chrome://extensions/", true, startedAt, later)).toEqual({ act: false });
    expect(pageChange("", undefined, true, startedAt, later)).toEqual({ act: false });
  });

  it("acts when the active tab moves to a different page", () => {
    expect(pageChange(other, `${page}#top`, true, startedAt, later)).toEqual({ record: page, act: true });
  });

  it("records but never acts when a tab moves during session restore", () => {
    expect(pageChange(other, page, true, startedAt, startedAt + QUIET_MS - 1)).toEqual({ record: page, act: false });
  });

  it("records but never acts when a background tab moves", () => {
    expect(pageChange(other, page, false, startedAt, later)).toEqual({ record: page, act: false });
    expect(pageChange(other, page, undefined, startedAt, later)).toEqual({ record: page, act: false });
  });

  it("records a move to a page it cannot handle as none, without acting", () => {
    expect(pageChange(page, "chrome://settings/", true, startedAt, later)).toEqual({ record: "", act: false });
    expect(pageChange(page, "about:blank", true, startedAt, later)).toEqual({ record: "", act: false });
  });

  it("acts when the active tab moves from a page it cannot handle to one it can", () => {
    expect(pageChange("", page, true, startedAt, later)).toEqual({ record: page, act: true });
  });

  it("records but never acts when a background tab moves from a page it cannot handle to one it can", () => {
    expect(pageChange("", page, false, startedAt, later)).toEqual({ record: page, act: false });
  });

  it("only records a tab it has never seen, whatever it shows", () => {
    for (const shown of [undefined, null, {}, true]) {
      expect(pageChange(shown, page, true, startedAt, later)).toEqual({ record: page, act: false });
      expect(pageChange(shown, "chrome://newtab/", true, startedAt, later)).toEqual({ record: "", act: false });
    }
  });
});

describe("activationActs", () => {
  const startedAt = 1_000_000;
  const later = startedAt + QUIET_MS;

  it("acts on an http(s) page still shown, with no marks", () => {
    expect(activationActs(page, true, undefined, undefined, startedAt, later)).toBe(true);
    expect(activationActs(page, true, undefined, undefined, undefined, later)).toBe(true);
  });

  it("never acts on a page it cannot handle", () => {
    expect(activationActs(null, true, undefined, undefined, startedAt, later)).toBe(false);
  });

  it("never acts on a tab no longer shown, one only passed through", () => {
    expect(activationActs(page, false, undefined, undefined, startedAt, later)).toBe(false);
    expect(activationActs(page, undefined, undefined, undefined, startedAt, later)).toBe(false);
  });

  it("never acts while the tab shows the page the user chose Keep on", () => {
    expect(activationActs(page, true, page, undefined, startedAt, later)).toBe(false);
  });

  it("acts once the tab shows another page than the one kept", () => {
    expect(activationActs(page, true, "https://example.com/other", undefined, startedAt, later)).toBe(true);
    for (const kept of ["", null, true, {}]) expect(activationActs(page, true, kept, undefined, startedAt, later)).toBe(true);
  });

  it("never acts with a live skip mark, and acts once it runs out", () => {
    expect(activationActs(page, true, undefined, later - SKIP_MS + 1, startedAt, later)).toBe(false);
    expect(activationActs(page, true, undefined, later - SKIP_MS, startedAt, later)).toBe(true);
  });

  it("never acts during session restore", () => {
    expect(activationActs(page, true, undefined, undefined, startedAt, startedAt + QUIET_MS - 1)).toBe(false);
  });
});

describe("loadActs", () => {
  const startedAt = 1_000_000;
  const later = startedAt + QUIET_MS;
  const same = { act: false };

  it("acts on a changed record as pageChange says, once, whether or not the tab was switched to", () => {
    for (const activated of [undefined, true]) {
      expect(loadActs({ record: page, act: true }, activated, true, page, undefined, undefined, startedAt, later)).toBe(true);
    }
    expect(loadActs({ record: page, act: false }, undefined, true, page, undefined, undefined, startedAt, later)).toBe(false);
  });

  it("acts on a changed record pageChange does not act on if the switch to the tab would", () => {
    // A tab never seen, switched to while it loaded: its switch still counts.
    expect(loadActs({ record: page, act: false }, true, true, page, undefined, undefined, startedAt, later)).toBe(true);
    expect(loadActs({ record: page, act: false }, true, false, page, undefined, undefined, startedAt, later)).toBe(false);
    expect(loadActs({ record: page, act: false }, true, true, page, page, undefined, startedAt, later)).toBe(false);
  });

  it("never acts on a changed record with a live skip mark", () => {
    expect(loadActs({ record: page, act: true }, undefined, true, page, undefined, later - 1, startedAt, later)).toBe(false);
    expect(loadActs({ record: page, act: true }, true, true, page, undefined, later - 1, startedAt, later)).toBe(false);
    expect(loadActs({ record: page, act: true }, undefined, true, page, undefined, later - SKIP_MS, startedAt, later)).toBe(true);
  });

  it("still acts on a navigation when the tab has a Keep for its page", () => {
    expect(loadActs({ record: page, act: true }, undefined, true, page, page, undefined, startedAt, later)).toBe(true);
  });

  it("does nothing for the same page in a tab not switched to while it loaded", () => {
    for (const activated of [undefined, false, "true", 1]) {
      expect(loadActs(same, activated, true, page, undefined, undefined, startedAt, later)).toBe(false);
    }
  });

  it("acts for the same page in a tab switched to while it loaded and still shown", () => {
    expect(loadActs(same, true, true, page, undefined, undefined, startedAt, later)).toBe(true);
  });

  it("never acts once the user has switched away again", () => {
    expect(loadActs(same, true, false, page, undefined, undefined, startedAt, later)).toBe(false);
    expect(loadActs(same, true, undefined, page, undefined, undefined, startedAt, later)).toBe(false);
  });

  it("judges the switch as activationActs does", () => {
    expect(loadActs(same, true, true, null, undefined, undefined, startedAt, later)).toBe(false);
    expect(loadActs(same, true, true, page, page, undefined, startedAt, later)).toBe(false);
    expect(loadActs(same, true, true, page, undefined, later - 1, startedAt, later)).toBe(false);
    expect(loadActs(same, true, true, page, undefined, undefined, startedAt, startedAt + QUIET_MS - 1)).toBe(false);
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
    expect(String(showDuplicatePrompt)).toContain(JSON.stringify(KEEP));
  });
});
