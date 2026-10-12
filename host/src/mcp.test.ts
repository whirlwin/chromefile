// Drives the MCP server through the SDK's Client against a fake host socket.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "./bridge-client";
import { createMcpServer } from "./mcp";

type Handler = (request: { id: string; method: string; params: any }, socket: Socket) => unknown;

let dir: string;
let socketPath: string;
let fakeHost: Server | undefined;
let bridge: BridgeClient;
let client: Client;

function startFakeHost(handler: Handler): Promise<void> {
  fakeHost = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const reply = handler(request, socket);
        if (reply !== undefined) socket.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
      }
    });
  });
  return new Promise((resolve) => fakeHost!.listen(socketPath, resolve));
}

function stopFakeHost(): Promise<void> {
  return new Promise((resolve) => {
    if (!fakeHost) return resolve();
    fakeHost.close(() => resolve());
    fakeHost = undefined;
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cbb-"));
  socketPath = join(dir, "bridge.sock");
  bridge = new BridgeClient(socketPath);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(bridge).connect(serverTransport);
  client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
  bridge.close();
  await stopFakeHost();
  rmSync(dir, { recursive: true, force: true });
});

function textOf(result: any): string {
  return result.content[0].text;
}

describe("cbb mcp", () => {
  it("lists one tool per method plus bridge_status", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("bridge_status");
    expect(names).toContain("net_rules_add");
    expect(names).toHaveLength(19);
    const pageEval = tools.find((tool) => tool.name === "page_eval")!;
    expect(pageEval.inputSchema.required).toEqual(["expression"]);
  });

  it("reports a missing browser as a tool error", async () => {
    const result: any = await client.callTool({ name: "tabs_list", arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^not_connected: .*Claude Browser Bridge extension/);

    const status: any = await client.callTool({ name: "bridge_status", arguments: {} });
    expect(status.isError).toBeFalsy();
    expect(JSON.parse(textOf(status))).toMatchObject({ connected: false });
  });

  it("forwards calls with the dotted method name and returns JSON", async () => {
    const seen: unknown[] = [];
    await startFakeHost((request) => {
      seen.push(request);
      return { result: { tab: { id: 9, url: request.params.url } } };
    });
    const result: any = await client.callTool({
      name: "tabs_open",
      arguments: { url: "https://example.com", active: false },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ tab: { id: 9, url: "https://example.com" } });
    expect(seen).toEqual([
      { id: expect.any(String), method: "tabs.open", params: { url: "https://example.com", active: false } },
    ]);
  });

  it("turns extension errors into code: message tool errors", async () => {
    await startFakeHost(() => ({ error: { code: "unavailable", message: "Enable Allow User Scripts" } }));
    const result: any = await client.callTool({
      name: "mods_register",
      arguments: { id: "m", matches: ["https://example.com/*"], js: "1" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("unavailable: Enable Allow User Scripts");
  });

  it("rejects arguments that do not match the schema", async () => {
    await startFakeHost(() => ({ result: {} }));
    const result: any = await client.callTool({ name: "tabs_close", arguments: { tabIds: "7" } });
    expect(result.isError).toBe(true);
  });

  it("returns screenshots as image content", async () => {
    await startFakeHost(() => ({ result: { data: "iVBORw0KGgo=", mimeType: "image/png" } }));
    const result: any = await client.callTool({ name: "page_screenshot", arguments: {} });
    expect(result.content).toEqual([{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }]);
  });

  it("reconnects after the host goes away", async () => {
    await startFakeHost((request, socket) => {
      socket.destroy();
      return undefined;
    });
    const dropped: any = await client.callTool({ name: "tabs_list", arguments: {} });
    expect(textOf(dropped)).toMatch(/^not_connected/);
    await stopFakeHost();
    rmSync(socketPath, { force: true });

    await startFakeHost(() => ({ result: { tabs: [] } }));
    const result: any = await client.callTool({ name: "tabs_list", arguments: {} });
    expect(JSON.parse(textOf(result))).toEqual({ tabs: [] });
  });

  it("times out requests the host never answers", async () => {
    await startFakeHost(() => undefined);
    const response = await bridge.request("tabs.list", {}, 50);
    expect(response.error?.code).toBe("timeout");
  });

  it("refuses requests over 1 MiB without sending them", async () => {
    let received = 0;
    await startFakeHost(() => {
      received++;
      return { result: {} };
    });
    // 600k characters but 1.2 MB of UTF-8.
    const result: any = await client.callTool({ name: "page_eval", arguments: { expression: "é".repeat(600_000) } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^too_large: /);
    expect(received).toBe(0);
  });

  it("fails in-flight requests with the code of an error the host could not attribute", async () => {
    await startFakeHost(() => ({ id: null, error: { code: "too_large", message: "Request line too long" } }));
    const result: any = await client.callTool({ name: "tabs_list", arguments: {} });
    expect(textOf(result)).toBe("too_large: Request line too long");
  });
});
