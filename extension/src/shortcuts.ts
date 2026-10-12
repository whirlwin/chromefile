// Keyboard shortcuts declared under `commands` in manifest.json. They are a
// local convenience, not a bridge feature, so they keep working while the
// kill switch is off.

export const SHORTCUT_STEPS: Record<string, number> = {
  "select-previous-tab": -1,
  "select-next-tab": 1,
};

// Index of the tab `step` places away from `current`, wrapping at both ends.
export function wrapIndex(current: number, step: number, count: number): number {
  return (((current + step) % count) + count) % count;
}

async function switchTab(step: number): Promise<void> {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const current = tabs.findIndex((tab) => tab.active);
  if (current === -1 || tabs.length < 2) return;
  const target = tabs[wrapIndex(current, step, tabs.length)];
  if (target?.id !== undefined) await chrome.tabs.update(target.id, { active: true });
}

export function initShortcuts(): void {
  chrome.commands.onCommand.addListener((command) => {
    const step = SHORTCUT_STEPS[command];
    if (step !== undefined) switchTab(step).catch((err) => console.error("shortcut failed", command, err));
  });
}
