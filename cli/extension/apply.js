// src/constants.ts
var DUPLICATES_KEY = "duplicates";
function duplicatesSetting(stored) {
  return stored === "ask" ? "ask" : "allow";
}

// src/applyRequest.ts
var MAX_ID = 100;
var METHODS = ["get", "set"];
var MAX_SHOWN = 60;
var SETTINGS = {
  [DUPLICATES_KEY]: { values: ["ask", "allow"], read: duplicatesSetting }
};
function parseRequest(detail) {
  if (typeof detail !== "string") return null;
  let message;
  try {
    message = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!isObject(message)) return null;
  const { id, method, key, value } = message;
  if (typeof id !== "string" || id === "" || id.length > MAX_ID) return null;
  if (method !== "get" && method !== "set") return { ok: false, id, error: rejected("method", method, METHODS) };
  const setting = typeof key === "string" && Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : void 0;
  if (typeof key !== "string" || !setting) return { ok: false, id, error: rejected("key", key, Object.keys(SETTINGS)) };
  if (method === "get") return { ok: true, id, method, key, setting };
  if (typeof value !== "string" || !setting.values.includes(value)) {
    return { ok: false, id, error: rejected(`${key} value`, value, setting.values) };
  }
  return { ok: true, id, method, key, setting, value };
}
function rejected(field, got, allowed) {
  const list = `(allowed: ${allowed.join(", ")})`;
  if (got === void 0) return `missing ${field} ${list}`;
  const shown = JSON.stringify(got);
  return `unknown ${field} ${shown.length > MAX_SHOWN ? `${shown.slice(0, MAX_SHOWN)}...` : shown} ${list}`;
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/protocol.ts
function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

// src/apply.ts
async function answer(request) {
  if (!request.ok) return { id: request.id, ok: false, error: request.error };
  const { id, key, setting } = request;
  try {
    if (request.method === "set") await chrome.storage.local.set({ [key]: request.value });
    const stored = await chrome.storage.local.get(key);
    return { id, ok: true, value: setting.read(stored[key]) };
  } catch (error) {
    return { id, ok: false, error: errorMessage(error) };
  }
}
document.addEventListener("chromefile:request", (event) => {
  const request = parseRequest(event.detail);
  if (!request) return;
  void answer(request).then((reply) => {
    document.dispatchEvent(new CustomEvent("chromefile:reply", { detail: JSON.stringify(reply) }));
  });
});
document.documentElement.dataset.chromefileApply = "1";
