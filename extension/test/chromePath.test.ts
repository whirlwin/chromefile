import { describe, expect, it } from "vitest";
import { resolveChromePath } from "../src/chromePath";
import { BridgeError } from "../src/protocol";

const fakeChrome = {
  version: "1",
  cookies: {
    prefix: "c:",
    getAll(this: { prefix: string }, filter: { name: string }) {
      return Promise.resolve([this.prefix + filter.name]);
    },
  },
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof BridgeError ? error.code : "other";
  }
  return undefined;
}

describe("resolveChromePath", () => {
  it("resolves a nested function bound to its parent", async () => {
    const fn = resolveChromePath(fakeChrome, "cookies.getAll");
    expect(await fn({ name: "sid" })).toEqual(["c:sid"]);
  });

  it("returns not_found for paths that do not resolve", () => {
    expect(codeOf(() => resolveChromePath(fakeChrome, "nope.getAll"))).toBe("not_found");
    expect(codeOf(() => resolveChromePath(fakeChrome, "cookies.nope"))).toBe("not_found");
    expect(codeOf(() => resolveChromePath(fakeChrome, "version.length.x"))).toBe("not_found");
  });

  it("returns bad_request for non-functions and malformed paths", () => {
    expect(codeOf(() => resolveChromePath(fakeChrome, "version"))).toBe("bad_request");
    expect(codeOf(() => resolveChromePath(fakeChrome, "cookies"))).toBe("bad_request");
    expect(codeOf(() => resolveChromePath(fakeChrome, ""))).toBe("bad_request");
    expect(codeOf(() => resolveChromePath(fakeChrome, "cookies..getAll"))).toBe("bad_request");
  });
});
