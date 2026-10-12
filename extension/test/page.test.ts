// page.* against a stubbed chrome.debugger: kill switch race and eval defaults.
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/dispatcher";
import { handlers } from "../src/methods/index";

const call = (method: string, params: Record<string, unknown>) => dispatch(handlers, { id: "1", method, params }, { isEnabled: () => true });

function stubChrome(enabledAfterAttach: boolean) {
  const debuggerApi = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    getTargets: vi.fn(async () => []),
    sendCommand: vi.fn(async (_target: unknown, _method: string, _params: unknown) => ({ result: { type: "number", value: 2 } })),
  };
  const storage = { local: { get: vi.fn(async () => ({ enabled: enabledAfterAttach })) } };
  vi.stubGlobal("chrome", { debugger: debuggerApi, storage, runtime: { id: "abc" } });
  return debuggerApi;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("page.eval", () => {
  it("awaits promises by default and returns the value", async () => {
    const api = stubChrome(true);
    expect(await call("page.eval", { tabId: 101, expression: "1+1" })).toEqual({ id: "1", result: { value: 2 } });
    expect(api.sendCommand.mock.calls[0]?.[2]).toMatchObject({ awaitPromise: true, returnByValue: true, userGesture: true });
  });

  it("detaches and answers disabled if the kill switch flipped during attach", async () => {
    const api = stubChrome(false);
    expect(await call("page.eval", { tabId: 102, expression: "1" })).toMatchObject({ error: { code: "disabled" } });
    expect(api.detach).toHaveBeenCalledWith({ tabId: 102 });
    expect(api.sendCommand).not.toHaveBeenCalled();
  });
});
