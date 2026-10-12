import { BridgeError } from "../protocol";
import type { HandlerMap, Params } from "../protocol";
import { CDP_TIMEOUT_MS, sendCommand } from "../debugger";
import { optBool, oneOf, str } from "../params";
import { resolveTabId } from "../target";

interface RemoteObject {
  type: string;
  value?: unknown;
  description?: string;
}

interface EvaluateResult {
  result: RemoteObject;
  exceptionDetails?: { text: string; exception?: RemoteObject };
}

// The host allows 120s for page.eval unless awaitPromise is false, so awaited
// evaluations get a matching (slightly shorter) budget.
const AWAIT_TIMEOUT_MS = 115_000;

async function evaluate(tabId: number, expression: string, awaitPromise: boolean): Promise<unknown> {
  const response = await sendCommand<EvaluateResult>(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise, userGesture: true },
    awaitPromise ? AWAIT_TIMEOUT_MS : CDP_TIMEOUT_MS,
  );
  const details = response.exceptionDetails;
  if (details) {
    throw new BridgeError("internal", details.exception?.description ?? details.text);
  }
  // JSON has no `undefined`, so an expression without a value yields null.
  return response.result.value ?? null;
}

const TEXT_EXPRESSION = "({url: location.href, title: document.title, text: document.body?.innerText ?? ''})";

export const pageMethods: HandlerMap = {
  "page.eval": async (params) => {
    const tabId = await resolveTabId(params);
    const value = await evaluate(tabId, str(params, "expression"), optBool(params, "awaitPromise") ?? true);
    return { value };
  },

  "page.cdp": async (params) => {
    const tabId = await resolveTabId(params);
    const cdpParams = params.params;
    if (cdpParams !== undefined && (typeof cdpParams !== "object" || cdpParams === null || Array.isArray(cdpParams))) {
      throw new BridgeError("bad_request", "params must be an object");
    }
    const result = await sendCommand(tabId, str(params, "method"), cdpParams as Record<string, unknown> | undefined);
    return { result };
  },

  "page.css": async (params: Params) => {
    const injection = { target: { tabId: await resolveTabId(params) }, css: str(params, "css") };
    if (optBool(params, "remove")) {
      await chrome.scripting.removeCSS(injection);
    } else {
      await chrome.scripting.insertCSS(injection);
    }
    return {};
  },

  "page.screenshot": async (params) => {
    const tabId = await resolveTabId(params);
    const format = oneOf(params, "format", ["png", "jpeg"] as const) ?? "png";
    const { data } = await sendCommand<{ data: string }>(tabId, "Page.captureScreenshot", { format, captureBeyondViewport: false });
    return { data, mimeType: `image/${format}` };
  },

  "page.text": async (params) => {
    const tabId = await resolveTabId(params);
    return await evaluate(tabId, TEXT_EXPRESSION, false);
  },
};
