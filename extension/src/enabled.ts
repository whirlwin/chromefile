import { ENABLED_KEY } from "./constants";

// The kill switch. Missing means enabled.
export async function isEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get(ENABLED_KEY);
  return stored[ENABLED_KEY] !== false;
}
