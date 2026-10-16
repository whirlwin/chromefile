// The native messaging host registered by the installer (see host/).
export const NATIVE_HOST_NAME = "io.whirlwin.chromefile";

// chrome.storage.local: the kill switch, toggled from the popup.
export const ENABLED_KEY = "enabled";
// chrome.storage.local: Chromefile's `tabs.duplicates`, written by
// `chromefile apply` through apply.html. Missing means "allow".
export const DUPLICATES_KEY = "duplicates";
// chrome.storage.session: written by the worker, read by the popup.
export const STATUS_KEY = "status";
export const LOG_KEY = "log";
export const LOG_LIMIT = 50;

export function userScriptsHint(extensionId: string): string {
  return `Enable 'Allow User Scripts' on the extension's Details page (chrome://extensions/?id=${extensionId})`;
}

// "ask": a new tab showing a page that is already open offers to close the
// older tabs. "allow": duplicates are left alone.
export type DuplicatesSetting = "ask" | "allow";

// The one reading of DUPLICATES_KEY, so the worker and apply.html agree:
// anything but "ask", including nothing stored, is "allow".
export function duplicatesSetting(stored: unknown): DuplicatesSetting {
  return stored === "ask" ? "ask" : "allow";
}

// What the worker publishes for the popup under STATUS_KEY.
export type ConnectionState = "connecting" | "connected" | "disconnected" | "disabled";
export interface Status {
  state: ConnectionState;
  since: number; // epoch ms
  error?: string; // last chrome.runtime.lastError on disconnect
  retryAt?: number; // epoch ms of the next reconnect attempt
}
