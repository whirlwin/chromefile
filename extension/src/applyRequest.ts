// Requests `chromefile apply` sends to apply.html (docs/architecture.md, "Apply
// relay page"). Kept apart from apply.ts, which registers its listener on
// import, so the parsing can be tested without a DOM.
import { DUPLICATES_KEY, duplicateAction } from "./constants";
import type { DuplicateAction } from "./constants";

export const MAX_ID = 100;
const METHODS = ["get", "set"] as const;
// Error messages quote the offending field, cut to this many characters.
const MAX_SHOWN = 60;

export interface Setting {
  // What a "set" may store.
  values: readonly string[];
  // Turns what chrome.storage.local holds (possibly nothing) into the reply.
  read: (stored: unknown) => string;
}

// The only chrome.storage.local keys apply.html reads or writes, by storage
// key. A new setting the CLI should manage goes here.
export const SETTINGS: Record<string, Setting> = {
  [DUPLICATES_KEY]: { values: ["none", "ask", "auto-close-duplicates"] satisfies DuplicateAction[], read: duplicateAction },
};

export type ApplyRequest =
  | { ok: true; id: string; method: "get"; key: string; setting: Setting }
  | { ok: true; id: string; method: "set"; key: string; setting: Setting; value: string }
  | { ok: false; id: string; error: string };

export type ApplyReply = { id: string; ok: true; value: string } | { id: string; ok: false; error: string };

// `detail` must be a JSON string, since objects do not cross from the CLI's
// world into this one. Returns null when there is no usable id: there is
// nobody to answer, so the event is ignored.
export function parseRequest(detail: unknown): ApplyRequest | null {
  if (typeof detail !== "string") return null;
  let message: unknown;
  try {
    message = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!isObject(message)) return null;
  const { id, method, key, value } = message;
  if (typeof id !== "string" || id === "" || id.length > MAX_ID) return null;

  if (method !== "get" && method !== "set") return { ok: false, id, error: rejected("method", method, METHODS) };
  // Object.hasOwn, so "__proto__" or "constructor" cannot pass as a setting.
  const setting = typeof key === "string" && Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : undefined;
  if (typeof key !== "string" || !setting) return { ok: false, id, error: rejected("key", key, Object.keys(SETTINGS)) };
  if (method === "get") return { ok: true, id, method, key, setting };
  if (typeof value !== "string" || !setting.values.includes(value)) {
    return { ok: false, id, error: rejected(`${key} value`, value, setting.values) };
  }
  return { ok: true, id, method, key, setting, value };
}

// `unknown key "x" (allowed: duplicates)`, or `missing key (...)`.
function rejected(field: string, got: unknown, allowed: readonly string[]): string {
  const list = `(allowed: ${allowed.join(", ")})`;
  if (got === undefined) return `missing ${field} ${list}`;
  const shown = JSON.stringify(got);
  return `unknown ${field} ${shown.length > MAX_SHOWN ? `${shown.slice(0, MAX_SHOWN)}...` : shown} ${list}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
