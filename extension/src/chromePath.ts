import { BridgeError } from "./protocol";

// Resolves "cookies.getAll" against `root` (normally the `chrome` global) to a
// function bound to its parent object, so `this` is correct when called.
export function resolveChromePath(root: unknown, path: string): (...args: unknown[]) => unknown {
  const segments = path.split(".");
  if (segments.some((s) => s === "")) {
    throw new BridgeError("bad_request", `Invalid path: "${path}"`);
  }
  let parent: unknown = undefined;
  let current: unknown = root;
  for (const segment of segments) {
    if ((typeof current !== "object" && typeof current !== "function") || current === null) {
      throw new BridgeError("not_found", `chrome.${path} does not exist`);
    }
    parent = current;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined || current === null) {
    throw new BridgeError("not_found", `chrome.${path} does not exist`);
  }
  if (typeof current !== "function") {
    throw new BridgeError("bad_request", `chrome.${path} is not a function`);
  }
  return (current as (...args: unknown[]) => unknown).bind(parent);
}
