// apply.html: the relay `chromefile apply` uses to change settings in
// chrome.storage.local. The CLI opens this page in a background tab and runs
// JavaScript in it through AppleScript. That script shares the page's DOM but
// runs in another world without chrome.* APIs, so it sends DOM events and this
// script, which has the APIs, answers them.
//
// Who can send a request: only code that runs in this extension page's DOM
// (the extension itself, DevTools, AppleScript with "Allow JavaScript from
// Apple Events"). The page is not in web_accessible_resources, so web pages
// cannot open or frame it; keep it that way. Even so, only the keys in
// SETTINGS can be touched, with their allowed values.
import { parseRequest } from "./applyRequest";
import type { ApplyReply, ApplyRequest } from "./applyRequest";
import { errorMessage } from "./protocol";

async function answer(request: ApplyRequest): Promise<ApplyReply> {
  if (!request.ok) return { id: request.id, ok: false, error: request.error };
  const { id, key, setting } = request;
  try {
    if (request.method === "set") await chrome.storage.local.set({ [key]: request.value });
    // Read back, so the reply is what is stored now rather than what was asked.
    const stored = await chrome.storage.local.get(key);
    return { id, ok: true, value: setting.read(stored[key]) };
  } catch (error) {
    return { id, ok: false, error: errorMessage(error) };
  }
}

// Registered synchronously, before the ready marker below, so a request sent
// as soon as the marker shows up is never missed.
document.addEventListener("chromefile:request", (event) => {
  const request = parseRequest((event as CustomEvent<unknown>).detail);
  if (!request) return;
  void answer(request).then((reply) => {
    document.dispatchEvent(new CustomEvent("chromefile:reply", { detail: JSON.stringify(reply) }));
  });
});
// The CLI treats a page without this marker as a missing or outdated extension.
document.documentElement.dataset.chromefileApply = "1";
