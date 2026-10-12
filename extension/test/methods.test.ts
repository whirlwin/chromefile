// Handlers that touch `chrome` run against a minimal stub of the global.
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/dispatcher";
import { handlers } from "../src/methods/index";

const enabled = { isEnabled: () => true };
const call = (method: string, params: Record<string, unknown> = {}) => dispatch(handlers, { id: "1", method, params }, enabled);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chrome.call", () => {
  it("calls the resolved function with args and wraps the result", async () => {
    const getAll = vi.fn(async (filter: unknown) => [filter]);
    vi.stubGlobal("chrome", { cookies: { getAll } });
    expect(await call("chrome.call", { path: "cookies.getAll", args: [{ domain: "x" }] })).toEqual({ id: "1", result: { result: [{ domain: "x" }] } });
  });

  it("rejects non-array args and unknown paths", async () => {
    vi.stubGlobal("chrome", { cookies: {} });
    expect(await call("chrome.call", { path: "cookies.getAll", args: {} })).toMatchObject({ error: { code: "bad_request" } });
    expect(await call("chrome.call", { path: "cookies.getAll" })).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("mods.*", () => {
  const runtime = { id: "abc" };

  it("is unavailable when chrome.userScripts is undefined", async () => {
    vi.stubGlobal("chrome", { runtime });
    const response = await call("mods.list");
    expect(response).toMatchObject({ error: { code: "unavailable" } });
    expect(JSON.stringify(response)).toContain("chrome://extensions/?id=abc");
  });

  it("is unavailable when chrome.userScripts throws", async () => {
    const getScripts = () => {
      throw new Error("User scripts are not enabled");
    };
    vi.stubGlobal("chrome", { runtime, userScripts: { getScripts } });
    expect(await call("mods.list")).toMatchObject({ error: { code: "unavailable" } });
  });

  it("registers new scripts with defaults and updates existing ones", async () => {
    const scripts = new Map<string, unknown>();
    const userScripts = {
      getScripts: vi.fn(async (filter?: { ids?: string[] }) => [...scripts.entries()].filter(([id]) => !filter?.ids || filter.ids.includes(id)).map(([, s]) => s)),
      register: vi.fn(async (list: { id: string }[]) => list.forEach((s) => scripts.set(s.id, s))),
      update: vi.fn(async (list: { id: string }[]) => list.forEach((s) => scripts.set(s.id, s))),
    };
    vi.stubGlobal("chrome", { runtime, userScripts });

    expect(await call("mods.register", { id: "m", matches: ["<all_urls>"], js: "1" })).toEqual({ id: "1", result: {} });
    expect(userScripts.register).toHaveBeenCalledWith([{ id: "m", matches: ["<all_urls>"], js: [{ code: "1" }], runAt: "document_idle", world: "USER_SCRIPT" }]);

    await call("mods.register", { id: "m", matches: ["<all_urls>"], js: "2", world: "MAIN" });
    expect(userScripts.update).toHaveBeenCalledTimes(1);
    expect(scripts.get("m")).toMatchObject({ js: [{ code: "2" }], world: "MAIN" });
  });

  it("serializes concurrent registrations of the same id", async () => {
    const scripts = new Map<string, unknown>();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    const userScripts = {
      getScripts: vi.fn(async (filter?: { ids?: string[] }) => {
        await tick();
        return [...scripts.entries()].filter(([id]) => !filter?.ids || filter.ids.includes(id)).map(([, s]) => s);
      }),
      register: vi.fn(async (list: { id: string }[]) => {
        await tick();
        for (const s of list) {
          if (scripts.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
          scripts.set(s.id, s);
        }
      }),
      update: vi.fn(async (list: { id: string }[]) => list.forEach((s) => scripts.set(s.id, s))),
    };
    vi.stubGlobal("chrome", { runtime, userScripts });

    const params = { id: "m", matches: ["<all_urls>"], js: "1" };
    const responses = await Promise.all([call("mods.register", params), call("mods.register", params)]);
    expect(responses).toEqual([{ id: "1", result: {} }, { id: "1", result: {} }]);
    expect(userScripts.register).toHaveBeenCalledTimes(1);
    expect(userScripts.update).toHaveBeenCalledTimes(1);
  });

  it("maps rejected registrations to bad_request", async () => {
    const userScripts = {
      getScripts: async () => [],
      register: async () => {
        throw new Error("Invalid url pattern 'nope'");
      },
    };
    vi.stubGlobal("chrome", { runtime, userScripts });
    expect(await call("mods.register", { id: "m", matches: ["nope"], js: "1" })).toEqual({
      id: "1",
      error: { code: "bad_request", message: "Invalid url pattern 'nope'" },
    });
  });

  it("validates params before touching the API", async () => {
    vi.stubGlobal("chrome", { runtime });
    expect(await call("mods.register", { id: "m", matches: [], js: "1" })).toMatchObject({ error: { code: "bad_request" } });
    expect(await call("mods.register", { id: "m", matches: ["*://*/*"], js: "1", world: "ISOLATED" })).toMatchObject({ error: { code: "bad_request" } });
  });
});
