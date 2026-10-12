import { BridgeError } from "../protocol";
import type { HandlerMap } from "../protocol";
import { resolveChromePath } from "../chromePath";
import { str } from "../params";

export const chromeCallMethods: HandlerMap = {
  "chrome.call": async (params) => {
    const args = params.args ?? [];
    if (!Array.isArray(args)) throw new BridgeError("bad_request", "args must be an array");
    const fn = resolveChromePath(chrome, str(params, "path"));
    return { result: await fn(...args) };
  },
};
