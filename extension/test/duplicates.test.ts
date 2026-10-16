import { describe, expect, it } from "vitest";
import { duplicatesSetting } from "../src/constants";
import { showDuplicatePrompt } from "../src/duplicatePrompt";
import { CLOSE_OLDER, inQuietPeriod, isBlankPage, olderDuplicates, pageKey, QUIET_MS } from "../src/duplicates";
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

describe("olderDuplicates", () => {
  type Tab = TabLike & { windowId: number };
  const tab = (id: number, url: string, extra: Partial<Tab> = {}): Tab => ({
    id,
    url,
    pinned: false,
    incognito: false,
    windowId: 1,
    ...extra,
  });
  const page = "https://example.com/a?q=1";

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

describe("duplicatesSetting", () => {
  it("reads anything but ask as allow", () => {
    expect(duplicatesSetting("ask")).toBe("ask");
    for (const stored of ["allow", undefined, "ASK", true, null]) expect(duplicatesSetting(stored)).toBe("allow");
  });
});

describe("showDuplicatePrompt", () => {
  // It is serialized on its own, so it carries its own copy of the message type.
  it("sends the message the worker listens for", () => {
    expect(String(showDuplicatePrompt)).toContain(JSON.stringify(CLOSE_OLDER));
  });
});
