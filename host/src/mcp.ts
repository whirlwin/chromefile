// `cbb mcp`: MCP server over stdio, started by Claude Code. Each tool call is
// forwarded to `cbb host` over the Unix socket.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BridgeClient, NOT_CONNECTED_MESSAGE } from "./bridge-client";
import { isObject, type Response } from "./protocol";
import { socketPath } from "./socket-path";

const VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = 30_000;
const AWAIT_PROMISE_TIMEOUT_MS = 120_000;

const tabId = z
  .number()
  .int()
  .optional()
  .describe("Tab id from tabs_list. Defaults to the active tab of the last focused window.");

const tabIds = z.array(z.number().int()).min(1).describe("Tab ids from tabs_list");

const groupColor = z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);

const dnrRule = z
  .record(z.string(), z.unknown())
  .describe("A chrome.declarativeNetRequest Rule object: { id, priority?, action, condition }");

type Shape = Record<string, z.ZodType>;

interface ToolSpec {
  name: string;
  method: string;
  description: string;
  shape: Shape;
  timeoutMs?: (args: Record<string, unknown>) => number;
}

const TOOLS: ToolSpec[] = [
  {
    name: "tabs_list",
    method: "tabs.list",
    description: "List all open tabs in the user's Chrome, with id, windowId, url, title, active and groupId.",
    shape: {},
  },
  {
    name: "tabs_open",
    method: "tabs.open",
    description: "Open a URL in a new tab. Returns the new tab.",
    shape: {
      url: z.string().describe("URL to open"),
      active: z.boolean().optional().describe("Focus the new tab (default true)"),
    },
  },
  {
    name: "tabs_close",
    method: "tabs.close",
    description: "Close one or more tabs.",
    shape: { tabIds },
  },
  {
    name: "tabs_navigate",
    method: "tabs.navigate",
    description: "Navigate an existing tab to a URL. Returns the updated tab.",
    shape: { tabId, url: z.string().describe("URL to load") },
  },
  {
    name: "tabs_focus",
    method: "tabs.focus",
    description: "Make a tab active and bring its window to the front.",
    shape: { tabId: z.number().int().describe("Tab id from tabs_list") },
  },
  {
    name: "tabs_group",
    method: "tabs.group",
    description: "Put tabs into a new tab group, optionally titled and coloured. Returns the groupId.",
    shape: {
      tabIds,
      title: z.string().optional().describe("Group title"),
      color: groupColor.optional().describe("Group colour"),
    },
  },
  {
    name: "page_eval",
    method: "page.eval",
    description:
      "Evaluate a JavaScript expression in the page's main world (the same context as the page's own scripts) " +
      "via the Chrome DevTools Protocol (Runtime.evaluate). Bypasses the page's Content Security Policy and can " +
      "read page globals. The result is returned by value, so it must be JSON-serialisable; return plain data, " +
      "not DOM nodes. Thrown exceptions come back as an error with the exception text. Attaches the debugger to " +
      "the tab on first use (Chrome shows a 'started debugging this browser' bar).",
    shape: {
      tabId,
      expression: z.string().describe("JavaScript expression, e.g. document.title or (() => { ... })()"),
      awaitPromise: z
        .boolean()
        .optional()
        .describe(
          "Wait for a returned promise to settle (default true, timeout 120s). Set false for a 30s timeout " +
          "and the promise object itself.",
        ),
    },
    timeoutMs: (args) => (args.awaitPromise === false ? DEFAULT_TIMEOUT_MS : AWAIT_PROMISE_TIMEOUT_MS),
  },
  {
    name: "page_cdp",
    method: "page.cdp",
    description:
      "Send any Chrome DevTools Protocol command to a tab (chrome.debugger, protocol 1.3), e.g. " +
      "'DOM.getDocument', 'Network.getCookies', 'Emulation.setDeviceMetricsOverride'. Returns the raw CDP result.",
    shape: {
      tabId,
      method: z.string().describe("CDP method, e.g. Page.reload"),
      params: z.record(z.string(), z.unknown()).optional().describe("CDP command parameters"),
    },
  },
  {
    name: "page_css",
    method: "page.css",
    description:
      "Inject a CSS stylesheet into a tab (chrome.scripting.insertCSS), or remove a previously injected one by " +
      "passing the identical css with remove: true. Lasts until the page reloads; use mods_register for " +
      "persistent changes.",
    shape: {
      tabId,
      css: z.string().describe("CSS source"),
      remove: z.boolean().optional().describe("Remove this exact stylesheet instead of inserting it"),
    },
  },
  {
    name: "page_screenshot",
    method: "page.screenshot",
    description: "Capture a screenshot of a tab's visible viewport (CDP Page.captureScreenshot). Returns an image.",
    shape: { tabId, format: z.enum(["png", "jpeg"]).optional().describe("Image format (default png)") },
  },
  {
    name: "page_text",
    method: "page.text",
    description: "Get a tab's url, title and visible text (document.body.innerText). Cheaper than a screenshot.",
    shape: { tabId },
  },
  {
    name: "mods_list",
    method: "mods.list",
    description: "List the registered mods (persistent user scripts).",
    shape: {},
  },
  {
    name: "mods_register",
    method: "mods.register",
    description:
      "Register or update a mod: a user script (chrome.userScripts) that runs on every matching page and " +
      "persists across reloads and browser restarts. Registering an existing id replaces it. Requires the " +
      "'Allow User Scripts' toggle on the extension's Details page in chrome://extensions; without it this " +
      "returns 'unavailable'.",
    shape: {
      id: z.string().describe("Stable mod id, used to update or unregister it"),
      matches: z.array(z.string()).min(1).describe("Match patterns, e.g. https://example.com/*"),
      js: z.string().describe("JavaScript source to run"),
      runAt: z
        .enum(["document_start", "document_end", "document_idle"])
        .optional()
        .describe("When to inject (default document_idle)"),
      world: z
        .enum(["USER_SCRIPT", "MAIN"])
        .optional()
        .describe("USER_SCRIPT (isolated, default) or MAIN (shares globals with the page)"),
    },
  },
  {
    name: "mods_unregister",
    method: "mods.unregister",
    description: "Unregister mods by id.",
    shape: { ids: z.array(z.string()).min(1).describe("Mod ids") },
  },
  {
    name: "net_rules_list",
    method: "net.rules.list",
    description: "List the network rules (declarativeNetRequest dynamic rules) currently installed.",
    shape: {},
  },
  {
    name: "net_rules_add",
    method: "net.rules.add",
    description:
      "Add network rules as declarativeNetRequest dynamic rules: block, redirect, or modify request and " +
      "response headers. Rules persist across browser restarts until removed. Each rule needs a unique " +
      "integer id; adding an id that already exists fails, so remove it first.",
    shape: { rules: z.array(dnrRule).min(1).describe("Rule objects") },
  },
  {
    name: "net_rules_remove",
    method: "net.rules.remove",
    description: "Remove declarativeNetRequest dynamic rules by id.",
    shape: { ids: z.array(z.number().int()).min(1).describe("Rule ids") },
  },
  {
    name: "chrome_call",
    method: "chrome.call",
    description:
      "Escape hatch: call any chrome.* extension API function the extension has permission for and return " +
      "its awaited result, e.g. path 'cookies.getAll' with args [{ domain: 'example.com' }], or " +
      "'history.search' with args [{ text: '' }]. Prefer the dedicated tools when one fits.",
    shape: {
      path: z.string().describe("Function path under chrome., e.g. bookmarks.getTree"),
      args: z.array(z.unknown()).optional().describe("Positional arguments (default [])"),
    },
  },
];

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function toToolResult(response: Response): CallToolResult {
  if (response.error) {
    return text(`${response.error.code}: ${response.error.message}`, true);
  }
  return text(JSON.stringify(response.result ?? {}, null, 2));
}

function toScreenshotResult(response: Response): CallToolResult {
  const result = response.result;
  if (response.error || !isObject(result) || typeof result.data !== "string") return toToolResult(response);
  const mimeType = typeof result.mimeType === "string" ? result.mimeType : "image/png";
  return { content: [{ type: "image", data: result.data, mimeType }] };
}

export function createMcpServer(bridge: BridgeClient): McpServer {
  const server = new McpServer({ name: "claude-browser-bridge", version: VERSION });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.shape },
      async (args: Record<string, unknown>) => {
        const timeoutMs = tool.timeoutMs?.(args) ?? DEFAULT_TIMEOUT_MS;
        const response = await bridge.request(tool.method, args, timeoutMs);
        return tool.name === "page_screenshot" ? toScreenshotResult(response) : toToolResult(response);
      },
    );
  }

  server.registerTool(
    "bridge_status",
    {
      description:
        "Check whether the browser extension is connected, and report its version and user agent. " +
        "Use this first if other tools report that the browser is not connected.",
      inputSchema: {},
    },
    async () => {
      const response = await bridge.request("bridge.status", {}, DEFAULT_TIMEOUT_MS);
      if (response.error?.code === "not_connected") {
        return text(JSON.stringify({ connected: false, message: NOT_CONNECTED_MESSAGE }, null, 2));
      }
      return toToolResult(response);
    },
  );

  return server;
}

export async function runMcp(): Promise<void> {
  const bridge = new BridgeClient(socketPath());
  const server = createMcpServer(bridge);
  await server.connect(new StdioServerTransport());
  // StdioServerTransport does not watch for EOF, and an open bridge socket
  // would keep the process alive after Claude Code goes away.
  let exiting = false;
  const exit = (): void => {
    if (exiting) return;
    exiting = true;
    bridge.close();
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.once("end", exit);
  process.stdin.once("close", exit);
}
