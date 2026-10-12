import { describe, expect, it } from "vitest";
import { dispatch } from "../src/dispatcher";
import { BridgeError } from "../src/protocol";
import type { HandlerMap } from "../src/protocol";

const enabled = { isEnabled: () => true };

const handlers: HandlerMap = {
  echo: async (params) => ({ params }),
  empty: async () => undefined,
  missing: async () => {
    throw new BridgeError("not_found", "nope");
  },
  chromeMissing: async () => {
    throw new Error("No tab with id: 7.");
  },
  crash: async () => {
    throw new Error("boom");
  },
  throwsString: async () => {
    throw "plain string";
  },
  syncThrow: (() => {
    throw new Error("sync");
  }) as unknown as HandlerMap[string],
};

describe("dispatch", () => {
  it("returns the handler result under the request id", async () => {
    const response = await dispatch(handlers, { id: "1", method: "echo", params: { a: 1 } }, enabled);
    expect(response).toEqual({ id: "1", result: { params: { a: 1 } } });
  });

  it("defaults params to {} and a missing result to {}", async () => {
    expect(await dispatch(handlers, { id: "2", method: "echo" }, enabled)).toEqual({ id: "2", result: { params: {} } });
    expect(await dispatch(handlers, { id: "3", method: "empty" }, enabled)).toEqual({ id: "3", result: {} });
  });

  it("stringifies numeric ids", async () => {
    expect(await dispatch(handlers, { id: 4, method: "empty" }, enabled)).toEqual({ id: "4", result: {} });
  });

  it("rejects unknown methods, including inherited property names", async () => {
    for (const method of ["nope", "toString", "__proto__"]) {
      const response = await dispatch(handlers, { id: "5", method }, enabled);
      expect(response).toMatchObject({ id: "5", error: { code: "bad_request" } });
    }
  });

  it("rejects malformed method and params", async () => {
    expect(await dispatch(handlers, { id: "6", method: 1 }, enabled)).toMatchObject({ error: { code: "bad_request" } });
    expect(await dispatch(handlers, { id: "7", method: "echo", params: [] }, enabled)).toMatchObject({ error: { code: "bad_request" } });
  });

  it("maps errors to codes", async () => {
    expect(await dispatch(handlers, { id: "8", method: "missing" }, enabled)).toEqual({ id: "8", error: { code: "not_found", message: "nope" } });
    expect(await dispatch(handlers, { id: "9", method: "chromeMissing" }, enabled)).toMatchObject({ error: { code: "not_found" } });
    expect(await dispatch(handlers, { id: "10", method: "crash" }, enabled)).toEqual({ id: "10", error: { code: "internal", message: "boom" } });
    expect(await dispatch(handlers, { id: "11", method: "throwsString" }, enabled)).toEqual({ id: "11", error: { code: "internal", message: "plain string" } });
    expect(await dispatch(handlers, { id: "12", method: "syncThrow" }, enabled)).toEqual({ id: "12", error: { code: "internal", message: "sync" } });
  });

  it("answers disabled when the kill switch is on, without calling the handler", async () => {
    let called = false;
    const spy: HandlerMap = { run: async () => (called = true) };
    const response = await dispatch(spy, { id: "13", method: "run" }, { isEnabled: async () => false });
    expect(response).toMatchObject({ id: "13", error: { code: "disabled" } });
    expect(called).toBe(false);
  });

  it("answers internal if the enabled check itself fails", async () => {
    const response = await dispatch(handlers, { id: "14", method: "echo" }, {
      isEnabled: async () => {
        throw new Error("storage down");
      },
    });
    expect(response).toEqual({ id: "14", error: { code: "internal", message: "storage down" } });
  });

  it("returns null for messages that cannot be answered", async () => {
    for (const message of [null, "x", [], {}, { method: "echo" }, { id: {}, method: "echo" }]) {
      expect(await dispatch(handlers, message, enabled)).toBeNull();
    }
  });
});
