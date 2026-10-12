import { describe, expect, it } from "vitest";
import { wrapIndex } from "../src/shortcuts";

describe("wrapIndex", () => {
  it("steps forward and back", () => {
    expect(wrapIndex(1, 1, 3)).toBe(2);
    expect(wrapIndex(1, -1, 3)).toBe(0);
  });

  it("wraps at both ends", () => {
    expect(wrapIndex(2, 1, 3)).toBe(0);
    expect(wrapIndex(0, -1, 3)).toBe(2);
  });
});
