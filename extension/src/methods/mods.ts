import { BridgeError, errorMessage } from "../protocol";
import type { HandlerMap } from "../protocol";
import { userScriptsHint } from "../constants";
import { oneOf, str, strList } from "../params";
import { enableUserScriptMessaging } from "../userScriptMessages";

// chrome.userScripts is undefined without the "Allow User Scripts" toggle on
// older Chrome, and throws from its methods on newer Chrome. Probe both.
async function userScripts(): Promise<typeof chrome.userScripts> {
  const unavailable = new BridgeError("unavailable", userScriptsHint(chrome.runtime.id));
  let api: typeof chrome.userScripts | undefined;
  try {
    api = chrome.userScripts;
    if (!api) throw unavailable;
    await api.getScripts({ ids: [] });
  } catch {
    throw unavailable;
  }
  return api;
}

// register checks getScripts and then registers or updates; running two at once
// for the same id could register it twice, so registrations run one at a time.
let registerQueue: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = registerQueue.then(task, task);
  registerQueue = run.catch(() => undefined);
  return run;
}

export const modsMethods: HandlerMap = {
  "mods.list": async () => {
    const api = await userScripts();
    return { mods: await api.getScripts() };
  },

  "mods.register": async (params) => {
    const script: chrome.userScripts.RegisteredUserScript = {
      id: str(params, "id"),
      matches: strList(params, "matches"),
      js: [{ code: str(params, "js") }],
      runAt: oneOf(params, "runAt", ["document_start", "document_end", "document_idle"] as const) ?? "document_idle",
      world: oneOf(params, "world", ["MAIN", "USER_SCRIPT"] as const) ?? "USER_SCRIPT",
    };
    const api = await userScripts();
    return serialized(async () => {
      const existing = await api.getScripts({ ids: [script.id] });
      try {
        await (existing.length > 0 ? api.update([script]) : api.register([script]));
      } catch (error) {
        // Chrome rejects invalid match patterns, bad code and the like: caller input.
        throw new BridgeError("bad_request", errorMessage(error));
      }
      // The toggle may have been switched on since the worker started.
      enableUserScriptMessaging();
      return {};
    });
  },

  "mods.unregister": async (params) => {
    const ids = strList(params, "ids");
    const api = await userScripts();
    await api.unregister({ ids });
    return {};
  },
};
