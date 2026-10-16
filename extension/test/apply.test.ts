import { describe, expect, it } from "vitest";
import { MAX_ID, parseRequest } from "../src/applyRequest";

const request = (fields: Record<string, unknown>) => parseRequest(JSON.stringify(fields));

describe("parseRequest", () => {
  it("accepts get and set of duplicates", () => {
    expect(request({ id: "1", method: "get", key: "duplicates" })).toMatchObject({ ok: true, id: "1", method: "get", key: "duplicates" });
    expect(request({ id: "2", method: "set", key: "duplicates", value: "ask" })).toMatchObject({
      ok: true,
      id: "2",
      method: "set",
      key: "duplicates",
      value: "ask",
    });
    for (const value of ["none", "auto-close-duplicates"]) {
      expect(request({ id: "3", method: "set", key: "duplicates", value })).toMatchObject({ ok: true, value });
    }
  });

  it("reads back what is stored, with anything else as none", () => {
    const reply = request({ id: "1", method: "get", key: "duplicates" });
    const read = reply && reply.ok ? reply.setting.read : () => "unreachable";
    expect(read("auto-close-duplicates")).toBe("auto-close-duplicates");
    expect(read("ask")).toBe("ask");
    expect(read("allow")).toBe("none");
    expect(read(undefined)).toBe("none");
  });

  it("ignores requests nobody could be answered for", () => {
    for (const detail of [undefined, null, 42, { id: "1", method: "get", key: "duplicates" }]) {
      expect(parseRequest(detail)).toBeNull();
    }
    for (const detail of ["{not json", "", "null", "[]", '"text"', "7"]) {
      expect(parseRequest(detail)).toBeNull();
    }
    expect(request({ method: "get", key: "duplicates" })).toBeNull();
    expect(request({ id: "", method: "get", key: "duplicates" })).toBeNull();
    expect(request({ id: 1, method: "get", key: "duplicates" })).toBeNull();
    expect(request({ id: "x".repeat(MAX_ID + 1), method: "get", key: "duplicates" })).toBeNull();
    expect(request({ id: "x".repeat(MAX_ID), method: "get", key: "duplicates" })).toMatchObject({ ok: true });
  });

  it("rejects unknown methods", () => {
    expect(request({ id: "1", method: "delete", key: "duplicates" })).toEqual({
      ok: false,
      id: "1",
      error: 'unknown method "delete" (allowed: get, set)',
    });
    expect(request({ id: "1", key: "duplicates" })).toEqual({ ok: false, id: "1", error: "missing method (allowed: get, set)" });
  });

  it("rejects keys outside the allow-list, including prototype names", () => {
    expect(request({ id: "1", method: "get", key: "x" })).toEqual({
      ok: false,
      id: "1",
      error: 'unknown key "x" (allowed: duplicates)',
    });
    for (const key of ["__proto__", "constructor", "toString", "enabled", 5]) {
      expect(request({ id: "1", method: "set", key, value: "ask" })).toMatchObject({ ok: false, error: expect.stringMatching(/^unknown key/) });
    }
    expect(request({ id: "1", method: "get" })).toMatchObject({ ok: false, error: "missing key (allowed: duplicates)" });
  });

  it("rejects values a setting does not allow", () => {
    expect(request({ id: "1", method: "set", key: "duplicates", value: "on" })).toEqual({
      ok: false,
      id: "1",
      error: 'unknown duplicates value "on" (allowed: none, ask, auto-close-duplicates)',
    });
    // What an earlier version stored is read, but no longer written.
    expect(request({ id: "1", method: "set", key: "duplicates", value: "allow" })).toEqual({
      ok: false,
      id: "1",
      error: 'unknown duplicates value "allow" (allowed: none, ask, auto-close-duplicates)',
    });
    expect(request({ id: "1", method: "set", key: "duplicates" })).toMatchObject({
      ok: false,
      error: "missing duplicates value (allowed: none, ask, auto-close-duplicates)",
    });
    expect(request({ id: "1", method: "set", key: "duplicates", value: true })).toMatchObject({ ok: false });
  });

  it("cuts long values short in errors", () => {
    const reply = request({ id: "1", method: "set", key: "duplicates", value: "v".repeat(1_000) });
    // The JSON quote and 59 characters, then "...".
    expect(reply).toEqual({
      ok: false,
      id: "1",
      error: `unknown duplicates value "${"v".repeat(59)}... (allowed: none, ask, auto-close-duplicates)`,
    });
  });
});
