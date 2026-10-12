// The native messaging host registered by the installer (see host/).
export const NATIVE_HOST_NAME = "io.whirlwin.claude_browser_bridge";

// chrome.storage.local: the kill switch, toggled from the popup.
export const ENABLED_KEY = "enabled";
// chrome.storage.session: written by the worker, read by the popup.
export const STATUS_KEY = "status";
export const LOG_KEY = "log";
export const LOG_LIMIT = 50;

export function userScriptsHint(extensionId: string): string {
  return `Enable 'Allow User Scripts' on the extension's Details page (chrome://extensions/?id=${extensionId})`;
}

// What the worker publishes for the popup under STATUS_KEY.
export type ConnectionState = "connecting" | "connected" | "disconnected" | "disabled";
export interface Status {
  state: ConnectionState;
  since: number; // epoch ms
  error?: string; // last chrome.runtime.lastError on disconnect
  retryAt?: number; // epoch ms of the next reconnect attempt
}
