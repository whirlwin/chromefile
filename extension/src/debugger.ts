// Lazily attaches chrome.debugger to tabs and keeps it attached. Chrome shows
// its "is debugging this browser" bar meanwhile, which is the visible indicator.
import { isEnabled } from "./enabled";
import { BridgeError, errorMessage } from "./protocol";
import { withTimeout } from "./timeout";

const PROTOCOL_VERSION = "1.3";
// Below the host's 30s request timeout, so the caller gets our error instead.
export const CDP_TIMEOUT_MS = 25_000;
const attached = new Set<number>();

// Must be called synchronously at worker start so the event can wake the worker.
export function initDebugger(): void {
  // Fires when the user dismisses the infobar, the tab closes, or DevTools takes over.
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId !== undefined) attached.delete(source.tabId);
  });
}

async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
  } catch (error) {
    // After a worker restart we may still hold a session we forgot about.
    if (!(await isOurs(tabId))) throw error;
  }
  // The kill switch may have run detachAll while attach was in flight.
  if (!(await isEnabled())) {
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    throw new BridgeError("disabled", "Claude Browser Bridge was disabled in the extension popup");
  }
  attached.add(tabId);
}

async function isOurs(tabId: number): Promise<boolean> {
  const targets = await chrome.debugger.getTargets();
  return targets.some((t) => t.tabId === tabId && t.attached && t.extensionId === chrome.runtime.id);
}

export async function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = CDP_TIMEOUT_MS,
): Promise<T> {
  const run = async () => {
    await ensureAttached(tabId);
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  };
  return withTimeout(run(), timeoutMs, method);
}

// Detaches every session this extension holds, including ones we lost track of.
export async function detachAll(): Promise<void> {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  const tabIds = new Set(attached);
  for (const t of targets) {
    if (t.attached && t.extensionId === chrome.runtime.id && t.tabId !== undefined) tabIds.add(t.tabId);
  }
  attached.clear();
  await Promise.all(
    [...tabIds].map((tabId) =>
      chrome.debugger.detach({ tabId }).catch((error: unknown) => {
        console.warn(`detach tab ${tabId}: ${errorMessage(error)}`);
      }),
    ),
  );
}
