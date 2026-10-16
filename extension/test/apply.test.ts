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
    expect(request({ id: "3", method: "set", key: "duplicates", value: "allow" })).toMatchObject({ ok: true, value: "allow" });
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
      error: 'unknown duplicates value "on" (allowed: ask, allow)',
    });
    expect(request({ id: "1", method: "set", key: "duplicates" })).toMatchObject({
      ok: false,
      error: "missing duplicates value (allowed: ask, allow)",
    });
    expect(request({ id: "1", method: "set", key: "duplicates", value: true })).toMatchObject({ ok: false });
  });

  it("cuts long values short in errors", () => {
    const reply = request({ id: "1", method: "set", key: "duplicates", value: "v".repeat(1_000) });
    expect(reply).toMatchObject({ ok: false });
    expect(reply && !reply.ok ? reply.error.length : 0).toBeLessThan(120);
  });
});
