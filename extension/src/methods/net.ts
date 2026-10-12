import { BridgeError, errorMessage } from "../protocol";
import type { HandlerMap } from "../protocol";
import { numList, objList } from "../params";

// Chrome rejects malformed rules and duplicate ids; that is caller input.
async function updateRules(options: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void> {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules(options);
  } catch (error) {
    throw new BridgeError("bad_request", errorMessage(error));
  }
}

export const netMethods: HandlerMap = {
  "net.rules.list": async () => ({ rules: await chrome.declarativeNetRequest.getDynamicRules() }),

  "net.rules.add": async (params) => {
    const rules = objList(params, "rules") as unknown as chrome.declarativeNetRequest.Rule[];
    await updateRules({ addRules: rules });
    return {};
  },

  "net.rules.remove": async (params) => {
    await updateRules({ removeRuleIds: numList(params, "ids") });
    return {};
  },
};
