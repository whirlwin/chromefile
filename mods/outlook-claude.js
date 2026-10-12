// Outlook web: adds an "Ask Claude" button to each expanded email message and a
// small dialog that asks the bridge to open a Claude Code session in iTerm2.
//
// Registered as a mod (chrome.userScripts, USER_SCRIPT world) on
// https://outlook.cloud.microsoft/*; see the mods section of chrome.yaml.
//
// Security notes:
// - Only trusted user input acts: click and keydown handlers that open, submit
//   or Cmd+Enter ignore events with isTrusted === false, so page scripts or
//   email content cannot open the dialog or send anything.
// - Email content is read with textContent/innerText and never inserted as
//   HTML. No innerHTML is used anywhere (Outlook may enforce Trusted Types).
// - Email data is collected at submit time from the clicked button's message.
//
// Anchors are Outlook's English aria-labels ("Email message", "Reactions",
// "Reply"); a localized Outlook will not match them.
(() => {
  "use strict";
  if (globalThis.__cbbOutlookClaude) return;
  globalThis.__cbbOutlookClaude = true;

  const MESSAGE = 'div[aria-label="Email message"]';
  const MARK = "data-cbb-claude";
  const CLAUDE_ORANGE = "#D97757";
  // Bodies are passed to a terminal session; keep them a sane size.
  const MAX_BODY = 200000;
  // The extension rejects header fields over 2000 characters (long Cc lists).
  const MAX_FIELD = 2000;

  // Styles --------------------------------------------------------------------

  // Constructable stylesheets avoid inline <style> (CSP style-src) and work
  // from the isolated USER_SCRIPT world.
  function sheet(css) {
    const s = new CSSStyleSheet();
    s.replaceSync(css);
    return s;
  }

  const BUTTON_CSS = `
.cbb-claude-btn {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  min-width: 32px;
  margin: 0;
  padding: 0;
  border-radius: var(--borderRadiusMedium, 4px);
  background: transparent;
  cursor: pointer;
  flex: none;
}
.cbb-claude-btn:hover { background: var(--colorSubtleBackgroundHover, rgba(0, 0, 0, 0.06)); }
.cbb-claude-btn:active { background: var(--colorSubtleBackgroundPressed, rgba(0, 0, 0, 0.1)); }
.cbb-claude-btn:focus-visible {
  outline: 2px solid var(--colorStrokeFocus2, #000);
  outline-offset: -2px;
}
.cbb-claude-btn svg { width: 20px; height: 20px; display: block; pointer-events: none; }
`;

  function installButtonStyles() {
    try {
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet(BUTTON_CSS)];
    } catch {
      const style = document.createElement("style");
      style.textContent = BUTTON_CSS;
      (document.head || document.documentElement).append(style);
    }
  }

  const DIALOG_CSS = `
:host { all: initial; }
.panel {
  --bg: #ffffff; --fg: #242424; --muted: #616161; --border: #d1d1d1;
  --field: #ffffff; --btn: #f5f5f5; --btn-hover: #e8e8e8; --error: #b10e1c;
  position: fixed;
  z-index: 2147483647;
  box-sizing: border-box;
  width: 380px;
  max-width: calc(100vw - 16px);
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  color: var(--fg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.12);
  font: 14px/1.4 "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  .panel {
    --bg: #292929; --fg: #ffffff; --muted: #adadad; --border: #474747;
    --field: #1f1f1f; --btn: #3d3d3d; --btn-hover: #4a4a4a; --error: #f1707b;
  }
}
h2 { margin: 0 0 10px; font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
h2 svg { width: 18px; height: 18px; }
textarea {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 96px;
  resize: vertical;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--field);
  color: var(--fg);
  font: inherit;
}
textarea:focus { outline: 2px solid ${CLAUDE_ORANGE}; outline-offset: -1px; border-color: transparent; }
label { display: flex; align-items: center; gap: 6px; margin: 10px 0 0; color: var(--fg); cursor: pointer; user-select: none; }
input[type="checkbox"] { margin: 0; accent-color: ${CLAUDE_ORANGE}; }
.status { min-height: 1.4em; margin: 10px 0 0; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
.status.error { color: var(--error); }
.actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
button {
  box-sizing: border-box;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--btn);
  color: var(--fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
button:hover { background: var(--btn-hover); }
button.primary { background: ${CLAUDE_ORANGE}; border-color: ${CLAUDE_ORANGE}; color: #ffffff; }
button.primary:hover { background: #c4633f; border-color: #c4633f; }
button:disabled { opacity: 0.6; cursor: default; }
button:focus-visible { outline: 2px solid var(--fg); outline-offset: 1px; }
.hint { margin-right: auto; align-self: center; color: var(--muted); font-size: 12px; }
`;

  // DOM helpers ---------------------------------------------------------------

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key in node && typeof value !== "string") node[key] = value;
      else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
  }

  // Claude-style asterisk: eight rounded rays.
  function claudeIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const g = document.createElementNS(ns, "g");
    g.setAttribute("stroke", CLAUDE_ORANGE);
    g.setAttribute("stroke-linecap", "round");
    for (let i = 0; i < 8; i++) {
      const ray = document.createElementNS(ns, "line");
      ray.setAttribute("x1", "12");
      ray.setAttribute("y1", i % 2 ? "5" : "3");
      ray.setAttribute("x2", "12");
      ray.setAttribute("y2", "10");
      ray.setAttribute("stroke-width", i % 2 ? "2.2" : "2.6");
      ray.setAttribute("transform", `rotate(${i * 45} 12 12)`);
      g.append(ray);
    }
    svg.append(g);
    return svg;
  }

  // Email data ----------------------------------------------------------------

  function labelAfter(root, prefix) {
    const node = root.querySelector(`[aria-label^="${prefix}"]`);
    return node ? node.getAttribute("aria-label").slice(prefix.length).trim() : "";
  }

  function subject() {
    const headings = document.querySelectorAll("#ConversationReadingPaneContainer span[role=heading]");
    for (const h of headings) {
      if (h.closest(MESSAGE)) continue;
      const text = (h.textContent || "").trim();
      if (text) return text;
    }
    return "";
  }

  function clip(text) {
    return text.length > MAX_FIELD ? `${text.slice(0, MAX_FIELD - 3)}...` : text;
  }

  function collectEmail(message) {
    const bodyNode = message.querySelector('div[role=document][aria-label="Message body"]');
    let body = bodyNode ? (bodyNode.innerText || bodyNode.textContent || "").trim() : "";
    if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n[truncated]`;
    const dateNode = message.querySelector('[id$="_DATETIME"]');
    return {
      subject: clip(subject()),
      from: clip(labelAfter(message, "From: ")),
      to: clip(labelAfter(message, "To: ")),
      cc: clip(labelAfter(message, "Cc: ")),
      date: clip(dateNode ? (dateNode.textContent || "").trim() : ""),
      body,
    };
  }

  // Dialog --------------------------------------------------------------------

  let dialog = null; // { host, button, close }

  function swallow(event) {
    event.stopPropagation();
  }

  function position(panel, anchor) {
    const margin = 8;
    const r = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let top = r.bottom + 4;
    if (top + h > vh - margin && r.top - 4 - h >= margin) top = r.top - 4 - h;
    top = Math.max(margin, Math.min(top, vh - h - margin));
    let left = r.left;
    if (left + w > vw - margin) left = r.right - w;
    left = Math.max(margin, Math.min(left, vw - w - margin));
    panel.style.top = `${Math.round(top)}px`;
    panel.style.left = `${Math.round(left)}px`;
  }

  function openDialog(button, openedFrom) {
    if (dialog) {
      const same = dialog.button === button;
      dialog.close();
      if (same) return;
    }

    const host = el("div", { [MARK]: "dialog" });
    const root = host.attachShadow({ mode: "closed" });
    try {
      root.adoptedStyleSheets = [sheet(DIALOG_CSS)];
    } catch {
      root.append(el("style", { text: DIALOG_CSS }));
    }

    const textarea = el("textarea", {
      placeholder: "What should Claude do with this email?",
      "aria-label": "Prompt for Claude",
    });
    const include = el("input", { type: "checkbox", checked: true });
    const status = el("p", { class: "status", role: "status", "aria-live": "polite" });
    const cancel = el("button", { type: "button", text: "Cancel" });
    const submit = el("button", { type: "button", class: "primary", text: "Open in iTerm" });
    const title = el("h2", { id: "cbb-title" }, [claudeIcon(), "Ask Claude"]);
    const panel = el(
      "div",
      { class: "panel", role: "dialog", "aria-modal": "false", "aria-labelledby": "cbb-title" },
      [
        title,
        textarea,
        el("label", {}, [include, "Include this email"]),
        status,
        el("div", { class: "actions" }, [el("span", { class: "hint", text: "⌘↵ to open" }), cancel, submit]),
      ],
    );
    root.append(panel);

    let busy = false;
    const setStatus = (text, isError = false) => {
      status.textContent = text;
      status.classList.toggle("error", isError);
    };

    const onOutside = (event) => {
      const path = event.composedPath();
      if (path.includes(host) || path.includes(button)) return;
      close();
    };
    const onViewport = () => position(panel, button.isConnected ? button : host);

    function close({ restoreFocus = false } = {}) {
      if (dialog?.host !== host) return;
      dialog = null;
      document.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("resize", onViewport);
      host.remove();
      button.setAttribute("aria-expanded", "false");
      if (restoreFocus && button.isConnected) button.focus();
    }

    async function send(event) {
      if (!event.isTrusted || busy) return;
      const prompt = textarea.value.trim();
      const includeEmail = include.checked;
      if (!prompt) {
        setStatus("Tell Claude what to do first.", true);
        textarea.focus();
        return;
      }
      // Prefer the message the button lives in now; fall back to the one it
      // was opened from if React has since replaced the button.
      const message = button.closest(MESSAGE) || (openedFrom.isConnected ? openedFrom : null);
      if (includeEmail && !message) {
        setStatus("This email is no longer on screen; open it again.", true);
        return;
      }
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.sendMessage) {
        setStatus("The bridge extension is not reachable (chrome.runtime is missing). Is user-script messaging enabled?", true);
        return;
      }
      busy = true;
      submit.disabled = true;
      textarea.disabled = true;
      include.disabled = true;
      setStatus("Opening a Claude session in iTerm2...");
      let reply;
      try {
        reply = await runtime.sendMessage({
          type: "claude.spawn",
          prompt,
          email: includeEmail ? collectEmail(message) : null,
        });
      } catch (error) {
        reply = { ok: false, error: String(error?.message || error) };
      }
      if (dialog?.host !== host) return;
      if (reply?.ok === true) {
        close();
        return;
      }
      busy = false;
      submit.disabled = false;
      textarea.disabled = false;
      include.disabled = false;
      setStatus(reply?.error ? String(reply.error) : "No answer from the bridge extension.", true);
    }

    // Keep keystrokes and clicks away from Outlook's own handlers (shortcuts
    // like Delete would otherwise act on the email). Our handlers run inside
    // the shadow root before these bubble to the host.
    for (const type of ["keydown", "keypress", "keyup", "click", "mousedown", "pointerdown", "dblclick", "contextmenu"]) {
      host.addEventListener(type, swallow);
    }
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close({ restoreFocus: true });
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        send(event);
      }
    });
    cancel.addEventListener("click", () => close({ restoreFocus: true }));
    submit.addEventListener("click", send);

    document.body.append(host);
    position(panel, button);
    document.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("resize", onViewport);
    button.setAttribute("aria-expanded", "true");
    dialog = { host, button, close };
    textarea.focus();
  }

  // Button --------------------------------------------------------------------

  function makeButton(message) {
    const button = el("button", {
      type: "button",
      class: "cbb-claude-btn",
      [MARK]: "button",
      "aria-label": "Ask Claude about this email",
      "aria-haspopup": "dialog",
      "aria-expanded": "false",
      title: "Ask Claude about this email",
    });
    button.append(claudeIcon());
    // Outlook collapses the message or opens menus on these; keep them ours.
    for (const type of ["mousedown", "pointerdown", "mouseup", "pointerup", "dblclick", "keydown"]) {
      button.addEventListener(type, swallow);
    }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      if (!event.isTrusted) return;
      openDialog(button, message);
    });
    return button;
  }

  // The direct child of `toolbar` that contains `node`.
  function toolbarChild(toolbar, node) {
    while (node && node.parentElement !== toolbar) node = node.parentElement;
    return node;
  }

  function decorate(message) {
    const reactions = message.querySelector('button[aria-label="Reactions"]');
    const toolbar =
      reactions?.closest("div[role=toolbar]") ||
      message.querySelector('div[role=toolbar] [aria-label="Reply"]')?.closest("div[role=toolbar]");
    if (!toolbar || !message.contains(toolbar)) return; // collapsed message
    if (toolbar.querySelector(`[${MARK}="button"]`)) return;
    const after = reactions && toolbarChild(toolbar, reactions);
    const before = after ? after.nextSibling : toolbarChild(toolbar, toolbar.querySelector('[aria-label="Reply"]'));
    toolbar.insertBefore(makeButton(message), before || null);
  }

  function scan() {
    for (const message of document.querySelectorAll(MESSAGE)) decorate(message);
  }

  // A timer rather than requestAnimationFrame: rAF is paused in background
  // tabs, so messages opened while Outlook is hidden would stay undecorated.
  let pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan();
    }, 50);
  }

  installButtonStyles();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  schedule();
})();
