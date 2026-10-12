import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeError } from "../src/protocol";
import { withTimeout } from "../src/timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withTimeout", () => {
  it("passes through a promise that settles in time", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
    await expect(withTimeout(Promise.reject(new Error("no")), 1000, "x")).rejects.toThrow("no");
  });

  it("rejects with internal 'timed out' when the promise hangs", async () => {
    vi.useFakeTimers();
    const result = withTimeout(new Promise(() => {}), 25_000, "Page.captureScreenshot");
    vi.advanceTimersByTime(25_000);
    const error = await result.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: "internal", message: "Page.captureScreenshot timed out after 25s" });
  });
});
