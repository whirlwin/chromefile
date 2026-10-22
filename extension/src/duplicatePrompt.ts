// The card a tab shows when it starts showing a page that is already open, or
// is switched to while it shows one (see duplicates.ts).
// "ask": `count` other tabs show it, and the card offers to close them. Keep
// tells the worker, so switching to this tab or the others on this page asks
// no more.
// "closed": `count` older tabs were just closed, and the card offers Undo.
// chrome.scripting.executeScript serializes this function and runs it in the
// tab's isolated world, so it must be self-contained: no imports and no
// references to anything outside its body, whose names esbuild may change.
//
// The page is untrusted. The card lives in a closed shadow root and is built
// without innerHTML. Styles go through the CSSOM, which a strict page CSP does
// not block (it can block <style> elements and style attributes). The buttons
// act only on trusted clicks, so page scripts cannot press them, and nothing
// takes focus away from the page.
export function showDuplicatePrompt(kind: "ask" | "closed", count: number): void {
  // Keep in sync with CLOSE_OLDER, UNDO and KEEP in duplicates.ts.
  const CLOSE_OLDER_TYPE = "duplicates.closeOlder";
  const UNDO_TYPE = "duplicates.undo";
  const KEEP_TYPE = "duplicates.keep";
  const MARKER = "data-chromefile-duplicates";
  const HIDE_MS = 15_000;

  // !important so page rules aimed at the host element cannot hide or move it.
  const style = (node: HTMLElement, styles: Record<string, string>) => {
    for (const [name, value] of Object.entries(styles)) node.style.setProperty(name, value, "important");
  };
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text: string, styles: Record<string, string>) => {
    const node = document.createElement(tag);
    node.textContent = text;
    style(node, styles);
    return node;
  };

  for (const old of document.querySelectorAll(`[${MARKER}]`)) old.remove();

  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const colors = dark
    ? { bg: "#1e1f22", fg: "#e6e6e6", muted: "#9ca3af", border: "#3a3b3f", shadow: "rgba(0, 0, 0, 0.5)" }
    : { bg: "#ffffff", fg: "#1f2328", muted: "#6b7280", border: "#e5e7eb", shadow: "rgba(0, 0, 0, 0.15)" };
  const accent = "#d97757";

  const host = document.createElement("div");
  host.setAttribute(MARKER, "");
  // `all` first: it resets every other property, including the ones below.
  style(host, { all: "initial" });
  style(host, { position: "fixed", top: "16px", right: "16px", "z-index": "2147483647" });
  const root = host.attachShadow({ mode: "closed" });

  const card = make("div", "", {
    display: "block",
    "box-sizing": "border-box",
    "max-width": "320px",
    padding: "12px 14px",
    "border-radius": "10px",
    border: `1px solid ${colors.border}`,
    background: colors.bg,
    color: colors.fg,
    "box-shadow": `0 6px 24px ${colors.shadow}`,
    "font-family": "system-ui, -apple-system, sans-serif",
    "font-size": "13px",
    "line-height": "1.4",
  });
  const label = make("div", "Chromefile", { "font-size": "11px", color: colors.muted, "margin-bottom": "4px" });
  const asking = kind === "ask";
  const tabs = count === 1 ? "tab" : "tabs";
  const message = make("div", asking ? `Already open in ${count} other ${tabs}` : `Closed ${count} older ${tabs}`, {});
  const buttons = make("div", "", { display: "flex", gap: "8px", "justify-content": "flex-end", "margin-top": "10px" });
  const button = (text: string, primary: boolean) => {
    const node = make("button", text, {
      padding: "5px 10px",
      "border-radius": "6px",
      border: `1px solid ${primary ? accent : colors.border}`,
      background: primary ? accent : "transparent",
      color: primary ? "#ffffff" : colors.fg,
      "font-family": "inherit",
      "font-size": "inherit",
      "font-weight": "600",
      cursor: "pointer",
    });
    node.type = "button";
    return node;
  };
  const primaryButton = button(asking ? `Close older ${tabs}` : "Undo", true);
  const secondaryButton = button(asking ? "Keep" : "OK", false);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer);
    host.remove();
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(hide, HIDE_MS);
  };

  primaryButton.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    hide();
    // The worker decides what to close or restore; there is nothing to do if
    // it fails.
    try {
      chrome.runtime.sendMessage({ type: asking ? CLOSE_OLDER_TYPE : UNDO_TYPE }).catch(() => {});
    } catch {
      // The extension was reloaded or removed since this card was shown.
    }
  });
  secondaryButton.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    hide();
    // Keep is remembered by the worker, for this page in this tab and the
    // others showing it; OK after an auto-close has nothing to tell it.
    if (!asking) return;
    try {
      chrome.runtime.sendMessage({ type: KEEP_TYPE }).catch(() => {});
    } catch {
      // The extension was reloaded or removed since this card was shown.
    }
  });
  card.addEventListener("mouseenter", () => clearTimeout(timer));
  card.addEventListener("mouseleave", arm);

  buttons.append(secondaryButton, primaryButton);
  card.append(label, message, buttons);
  root.append(card);
  document.documentElement.append(host);
  // A tab opened in the background (Command+click) shows the card only once
  // it is switched to, so the countdown starts then.
  if (document.visibilityState === "visible") {
    arm();
  } else {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisible);
      if (host.isConnected) arm();
    };
    document.addEventListener("visibilitychange", onVisible);
  }
}
