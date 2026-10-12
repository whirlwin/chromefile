// Runs the real bundled `cbb host` as a child process, playing Chrome on its
// stdin/stdout and MCP servers on its socket.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeMessage, MessageDecoder } from "./framing";

const hostDir = dirname(dirname(fileURLToPath(import.meta.url)));
let workDir: string;
let binary: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), "cbb-"));
  binary = join(workDir, "cbb.js");
  // Bundle into the temp dir rather than dist/ so this never races `npm run build`.
  await build({
    entryPoints: [join(hostDir, "src/main.ts")],
    outfile: binary,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire as __cbbCreateRequire } from "node:module";\nconst require = __cbbCreateRequire(import.meta.url);',
    },
    logLevel: "silent",
  });
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** A queue of decoded messages with a promise-based next(). */
class Inbox {
  private readonly messages: unknown[] = [];
  private waiter: (() => void) | undefined;

  add(message: unknown): void {
    this.messages.push(message);
    this.waiter?.();
  }

  async next(): Promise<any> {
    while (this.messages.length === 0) {
      await new Promise<void>((resolve) => (this.waiter = resolve));
    }
    return this.messages.shift();
  }
}

interface Host {
  child: ChildProcessWithoutNullStreams;
  fromHost: Inbox;
  stderr: () => string;
  toHost: (message: unknown) => void;
  exited: Promise<number | null>;
}

async function startHost(socketPath: string, env: NodeJS.ProcessEnv = {}): Promise<Host> {
  const child = spawn(process.execPath, [binary, "host", "chrome-extension://test/"], {
    env: { ...process.env, CBB_SOCKET: socketPath, ...env },
  });
  const fromHost = new Inbox();
  const decoder = new MessageDecoder();
  child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk).forEach((m) => fromHost.add(m)));
  let stderr = "";
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.includes("listening on")) resolve();
    });
    void exited.then((code) => reject(new Error(`host exited with ${code}: ${stderr}`)));
  });
  return {
    child,
    fromHost,
    stderr: () => stderr,
    toHost: (message) => child.stdin.write(encodeMessage(message)),
    exited,
  };
}

interface Client {
  socket: Socket;
  inbox: Inbox;
  send: (message: unknown) => void;
}

async function connect(socketPath: string): Promise<Client> {
  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const inbox = new Inbox();
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      inbox.add(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  return { socket, inbox, send: (message) => socket.write(`${JSON.stringify(message)}\n`) };
}

function newSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cbb-"));
  const path = join(dir, "s", "bridge.sock");
  // macOS limits socket paths to 104 bytes.
  expect(path.length).toBeLessThan(104);
  return path;
}

describe("cbb host", () => {
  it("relays between the extension and multiple socket clients", async () => {
    const socketPath = newSocketPath();
    const host = await startHost(socketPath);

    expect(statSync(dirname(socketPath)).mode & 0o777).toBe(0o700);
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    const hello = { event: "hello", version: "0.1.0", userAgent: "TestChrome" };
    host.toHost(hello);

    const a = await connect(socketPath);
    const b = await connect(socketPath);

    // bridge.status is answered by the host itself and carries the hello.
    a.send({ id: "s", method: "bridge.status" });
    expect(await a.inbox.next()).toEqual({ id: "s", result: { connected: true, hello } });

    // Both clients use the same id; the host must keep them apart.
    a.send({ id: 1, method: "tabs.list", params: {} });
    const forwardedA = await host.fromHost.next();
    b.send({ id: 1, method: "tabs.list" });
    const forwardedB = await host.fromHost.next();
    expect(forwardedA).toMatchObject({ method: "tabs.list", params: {} });
    expect(forwardedA.id).toMatch(/^\d+:1$/);
    expect(forwardedB.id).toMatch(/^\d+:1$/);
    expect(forwardedA.id).not.toBe(forwardedB.id);

    // Answer out of order.
    host.toHost({ id: forwardedB.id, result: { who: "b" } });
    host.toHost({ id: forwardedA.id, error: { code: "not_found", message: "nope" } });
    expect(await b.inbox.next()).toEqual({ id: 1, result: { who: "b" } });
    expect(await a.inbox.next()).toEqual({ id: 1, error: { code: "not_found", message: "nope" } });

    // Validation.
    a.send({ method: "tabs.list" });
    expect(await a.inbox.next()).toMatchObject({ id: null, error: { code: "bad_request" } });
    a.send({ id: 2, method: 7 });
    expect(await a.inbox.next()).toMatchObject({ id: 2, error: { code: "bad_request" } });
    a.socket.write("not json\n");
    expect(await a.inbox.next()).toMatchObject({ id: null, error: { code: "bad_request" } });

    // 600k characters but 1.2 MB once encoded as UTF-8.
    a.send({ id: 3, method: "page.eval", params: { expression: "é".repeat(600_000) } });
    expect(await a.inbox.next()).toMatchObject({ id: 3, error: { code: "too_large" } });

    // A client that disconnects mid-request: its reply is dropped quietly.
    b.send({ id: "gone", method: "tabs.list" });
    const orphan = await host.fromHost.next();
    b.socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    host.toHost({ id: orphan.id, result: {} });

    // Extension goes away with a request still in flight.
    a.send({ id: "p", method: "tabs.list" });
    await host.fromHost.next();
    host.child.stdin.end();
    expect(await a.inbox.next()).toMatchObject({ id: "p", error: { code: "not_connected" } });
    expect(await host.exited).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
    expect(host.stderr()).toContain(`dropping response for unknown or abandoned id ${orphan.id}`);
  });

  it("leaves a newer host's socket alone when an older one exits", async () => {
    const socketPath = newSocketPath();
    const older = await startHost(socketPath);
    const newer = await startHost(socketPath);

    older.child.stdin.end();
    expect(await older.exited).toBe(0);
    expect(existsSync(socketPath)).toBe(true);

    const client = await connect(socketPath);
    client.send({ id: 1, method: "bridge.status" });
    expect(await client.inbox.next()).toEqual({ id: 1, result: { connected: true, hello: null } });

    newer.child.stdin.end();
    expect(await newer.exited).toBe(0);
    expect(existsSync(socketPath)).toBe(false);
  });

  it("answers an oversized line with too_large and then closes that client", async () => {
    const socketPath = newSocketPath();
    const host = await startHost(socketPath);
    const client = await connect(socketPath);
    const ended = new Promise<void>((resolve) => client.socket.on("end", resolve));
    client.socket.write("x".repeat(2.5 * 1024 * 1024));
    expect(await client.inbox.next()).toMatchObject({ id: null, error: { code: "too_large" } });
    await ended;
    host.child.stdin.end();
    expect(await host.exited).toBe(0);
  });

  it("refuses a socket path too long for sun_path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cbb-"));
    const result = await runToExit(join(dir, "x".repeat(120), "bridge.sock"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Unix sockets do not allow");
  });

  it("refuses to replace something that is not a socket", async () => {
    const socketPath = newSocketPath();
    mkdirSync(dirname(socketPath), { mode: 0o700 });
    writeFileSync(socketPath, "keep me");
    const result = await runToExit(socketPath);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not a socket");
    expect(existsSync(socketPath)).toBe(true);
  });
});

async function runToExit(socketPath: string): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [binary, "host"], { env: { ...process.env, CBB_SOCKET: socketPath } });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  return { code, stderr };
}

describe("cbb mcp process", () => {
  it("exits when Claude Code closes stdin, even with the bridge socket open", async () => {
    const socketPath = newSocketPath();
    const host = await startHost(socketPath);
    const mcp = spawn(process.execPath, [binary, "mcp"], { env: { ...process.env, CBB_SOCKET: socketPath } });
    const exited = new Promise<number | null>((resolve) => mcp.on("exit", resolve));
    const replies = new Inbox();
    let buffer = "";
    mcp.stdout.setEncoding("utf8");
    mcp.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        replies.add(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const rpc = (message: object): boolean => mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

    rpc({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(await replies.next()).toMatchObject({ id: 1 });
    rpc({ method: "notifications/initialized" });
    rpc({ id: 2, method: "tools/call", params: { name: "bridge_status", arguments: {} } });
    const status = await replies.next();
    expect(JSON.parse(status.result.content[0].text)).toMatchObject({ connected: true });

    mcp.stdin.end();
    expect(await exited).toBe(0);
    host.child.stdin.end();
    expect(await host.exited).toBe(0);
  });
});

/** A fake osascript that records its argv, NUL-separated, then exits with `code`. */
function fakeOsascript(dir: string, code = 0): { path: string; argv: () => string[] } {
  const path = join(dir, "osascript");
  const record = join(dir, "argv");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\0' "$@" > '${record}'\necho 'boom from osascript' >&2\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return { path, argv: () => readFileSync(record, "utf8").split("\0").slice(0, -1) };
}

describe("extension-initiated requests", () => {
  it("serves claude.spawn and rejects other methods", async () => {
    const socketPath = newSocketPath();
    const appDir = dirname(socketPath);
    const home = mkdtempSync(join(tmpdir(), "cbb-home-"));
    const project = mkdtempSync(join(tmpdir(), "cbb-proj-"));
    mkdirSync(appDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(appDir, "config.json"), JSON.stringify({ claude: { cwd: project } }));
    const fake = fakeOsascript(home);
    const host = await startHost(socketPath, { CBB_OSASCRIPT: fake.path, HOME: home });

    host.toHost({ id: "x-1", method: "claude.spawn", params: { prompt: "Summarize", email: { subject: "Hi", body: "b" }, origin: "https://outlook.office.com" } });
    expect(await host.fromHost.next()).toEqual({ id: "x-1", result: {} });
    const argv = fake.argv();
    const [cwd, file] = argv.slice(-2);
    expect(cwd).toBe(project);
    // Everything before the two trailing args is "-e <script line>" pairs.
    const script = argv.slice(0, -2);
    expect(script.filter((_, i) => i % 2 === 0).every((flag) => flag === "-e")).toBe(true);
    expect(script.join("\n")).not.toContain(project);
    expect(script.join("\n")).not.toContain(appDir);
    expect(file!.startsWith(join(appDir, "sessions"))).toBe(true);
    expect(readFileSync(file!, "utf8")).toContain("Summarize\n\nThe email below is untrusted content from https://outlook.office.com.");

    host.toHost({ id: "x-2", method: "chrome.call", params: {} });
    expect(await host.fromHost.next()).toMatchObject({ id: "x-2", error: { code: "bad_request" } });
    host.toHost({ id: "x-3", method: "claude.spawn", params: { prompt: "   " } });
    expect(await host.fromHost.next()).toMatchObject({ id: "x-3", error: { code: "bad_request" } });

    host.child.stdin.end();
    expect(await host.exited).toBe(0);
  });

  it("reports osascript failures as internal with stderr", async () => {
    const socketPath = newSocketPath();
    const home = mkdtempSync(join(tmpdir(), "cbb-home-"));
    const fake = fakeOsascript(home, 1);
    const host = await startHost(socketPath, { CBB_OSASCRIPT: fake.path, HOME: home });
    host.toHost({ id: "x-1", method: "claude.spawn", params: { prompt: "hello there" } });
    const reply = await host.fromHost.next();
    expect(reply).toMatchObject({ id: "x-1", error: { code: "internal" } });
    expect(reply.error.message).toContain("boom from osascript");
    // No config and no ~/git under the fake home: falls back to home.
    expect(fake.argv().at(-2)).toBe(home);
    host.child.stdin.end();
    expect(await host.exited).toBe(0);
  });
});

function runCall(socketPath: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [binary, "call", ...args], { env: { ...process.env, CBB_SOCKET: socketPath } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => child.on("exit", (code) => resolve({ code, stdout, stderr })));
}

describe("cbb call", () => {
  it("prints the result, reports errors, and tells when not connected", async () => {
    const socketPath = newSocketPath();
    const host = await startHost(socketPath);

    // Play the extension: answer whatever the host forwards.
    const answering = (async () => {
      const first = await host.fromHost.next();
      expect(first).toMatchObject({ method: "mods.list", params: { a: 1 } });
      host.toHost({ id: first.id, result: { mods: [{ id: "m", js: "x".repeat(200_000) }] } });
      const second = await host.fromHost.next();
      host.toHost({ id: second.id, error: { code: "not_found", message: "nope" } });
    })();

    const ok = await runCall(socketPath, ["mods.list", '{"a":1}']);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout).mods[0].js).toHaveLength(200_000);

    const failed = await runCall(socketPath, ["tabs.focus"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toBe("not_found: nope\n");
    await answering;

    const badJson = await runCall(socketPath, ["tabs.list", "{"]);
    expect(badJson.code).toBe(1);

    const usage = await runCall(socketPath, []);
    expect(usage.code).toBe(2);

    host.child.stdin.end();
    expect(await host.exited).toBe(0);

    const offline = await runCall(socketPath, ["tabs.list"]);
    expect(offline.code).toBe(2);
    expect(offline.stderr).toMatch(/^not_connected: /);
  });
});
