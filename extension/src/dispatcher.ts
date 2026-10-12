import { BridgeError, errorMessage } from "./protocol";
import type { ErrorCode, HandlerMap, Response } from "./protocol";

// Chrome phrases missing-object errors like "No tab with id: 7."
const NOT_FOUND_PATTERN = /\bNo (tab|window|group|frame|target) with id\b/i;

export interface DispatchOptions {
  isEnabled: () => boolean | Promise<boolean>;
}

// Turns a raw message into exactly one response. Never throws. Returns null only
// when the message has no usable id, since such a response could not be routed.
export async function dispatch(handlers: HandlerMap, message: unknown, options: DispatchOptions): Promise<Response | null> {
  if (!isObject(message) || (typeof message.id !== "string" && typeof message.id !== "number")) {
    return null;
  }
  const id = String(message.id);
  try {
    if (!(await options.isEnabled())) {
      throw new BridgeError("disabled", "Claude Browser Bridge is disabled in the extension popup");
    }
    const { method, params = {} } = message;
    if (typeof method !== "string") throw new BridgeError("bad_request", "method must be a string");
    if (!isObject(params)) throw new BridgeError("bad_request", "params must be an object");
    const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
    if (!handler) throw new BridgeError("bad_request", `Unknown method: ${method}`);
    return { id, result: (await handler(params)) ?? {} };
  } catch (error) {
    return { id, error: toErrorBody(error) };
  }
}

export function toErrorBody(error: unknown): { code: ErrorCode; message: string } {
  if (error instanceof BridgeError) return { code: error.code, message: error.message };
  const message = errorMessage(error);
  return { code: NOT_FOUND_PATTERN.test(message) ? "not_found" : "internal", message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
