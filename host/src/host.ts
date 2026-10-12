// `cbb host`: started by Chrome. Relays between the extension (native
// messaging on stdin/stdout) and any number of MCP servers connected to the
// Unix socket (NDJSON).
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { encodeMessage, MessageDecoder, MessageTooLargeError, MAX_OUTGOING_BYTES } from "./framing";
import { errorResponse, isObject, type RequestId, type Response } from "./protocol";
import { ensureSocketDir, socketPath } from "./socket-path";
import { SpawnError, spawnClaude } from "./spawn";

/** A socket line this long cannot become a valid native message anyway. */
const MAX_LINE_BYTES = 2 * MAX_OUTGOING_BYTES;

/** How long shutdown waits for replies to flush before exiting. */
const SHUTDOWN_GRACE_MS = 1000;

/**
 * Forget a request the extension never answered after this long. Longer
 * than the MCP side's longest timeout (120s), which has given up by then.
 */
const PENDING_TIMEOUT_MS = 150_000;

/** Ids of requests the extension sends to the host, not the other way round. */
const EXTENSION_ID_PREFIX = "x-";

/** sun_path is 104 bytes on macOS and 108 on Linux, including the NUL. */
const MAX_SOCKET_PATH_BYTES = process.platform === "darwin" ? 103 : 107;

interface Client {
  number: number;
  socket: Socket;
}

interface Pending {
  client: Client;
  originalId: RequestId;
  timer: NodeJS.Timeout;
}

function log(message: string): void {
  process.stderr.write(`cbb host: ${message}\n`);
}

export function runHost(): void {
  const path = socketPath();
  const clients = new Set<Client>();
  // Keyed by the rewritten id sent to the extension: "<clientNumber>:<id>".
  const pending = new Map<string, Pending>();
  let hello: unknown = null;
  let nextClientNumber = 1;
  let socketInode: number | undefined;
  let shuttingDown = false;

  function send(client: Client, response: Response): void {
    if (!client.socket.writable) return;
    client.socket.write(`${JSON.stringify(response)}\n`);
  }

  function handleRequest(client: Client, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send(client, errorResponse(null, "bad_request", "Request is not valid JSON"));
      return;
    }
    const id = isObject(message) ? message.id : undefined;
    if (!isObject(message) || (typeof id !== "string" && typeof id !== "number")) {
      send(client, errorResponse(null, "bad_request", "Request needs a string or number id"));
      return;
    }
    if (typeof message.method !== "string") {
      send(client, errorResponse(id, "bad_request", "Request needs a string method"));
      return;
    }
    if (message.method === "bridge.status") {
      send(client, { id, result: { connected: true, hello } });
      return;
    }

    const rewrittenId = `${client.number}:${id}`;
    if (pending.has(rewrittenId)) {
      send(client, errorResponse(id, "bad_request", `Request id ${id} is already in flight`));
      return;
    }
    let frame: Buffer;
    try {
      frame = encodeMessage({ id: rewrittenId, method: message.method, params: message.params ?? {} });
    } catch (error) {
      if (error instanceof MessageTooLargeError) {
        send(client, errorResponse(id, "too_large", `${error.message} (Chrome's host to extension limit)`));
        return;
      }
      throw error;
    }
    const timer = setTimeout(() => {
      pending.delete(rewrittenId);
      log(`forgetting request ${rewrittenId}: no response after ${PENDING_TIMEOUT_MS / 1000}s`);
    }, PENDING_TIMEOUT_MS).unref();
    pending.set(rewrittenId, { client, originalId: id, timer });
    process.stdout.write(frame);
  }

  function handleExtensionMessage(message: unknown): void {
    if (!isObject(message)) {
      log("ignoring non-object message from the extension");
      return;
    }
    if (message.event === "hello") {
      hello = message;
      log(`extension connected (${String(message.version ?? "unknown version")})`);
      return;
    }
    if (typeof message.id !== "string") {
      // Other events have no consumer yet.
      return;
    }
    if (typeof message.method === "string" && message.id.startsWith(EXTENSION_ID_PREFIX)) {
      void handleExtensionRequest(message.id, message.method, message.params);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      log(`dropping response for unknown or abandoned id ${message.id}`);
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    send(entry.client, { ...message, id: entry.originalId } as Response);
  }

  // Requests the extension starts itself (on behalf of a mod), as opposed to
  // replies to socket clients. Only an allowlist of methods is served.
  async function handleExtensionRequest(id: string, method: string, params: unknown): Promise<void> {
    let response: Response;
    if (method !== "claude.spawn") {
      response = errorResponse(id, "bad_request", `Unknown extension request: ${method}`);
    } else {
      try {
        const { file, cwd } = await spawnClaude(params);
        log(`spawned Claude in ${cwd} with prompt file ${file}`);
        response = { id, result: {} };
      } catch (error) {
        const code = error instanceof SpawnError ? error.code : "internal";
        response = errorResponse(id, code, (error as Error).message);
        log(`claude.spawn failed: ${response.error!.message}`);
      }
    }
    if (shuttingDown) return;
    try {
      process.stdout.write(encodeMessage(response));
    } catch (error) {
      log(`could not reply to ${id}: ${(error as Error).message}`);
    }
  }

  function handleClient(socket: Socket): void {
    const client: Client = { number: nextClientNumber++, socket };
    clients.add(client);
    socket.setEncoding("utf8");
    let buffer = "";
    let rejected = false;

    socket.on("data", (chunk: string) => {
      if (rejected) return;
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleRequest(client, line);
      }
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        // end() rather than destroy() so the client reads the error first.
        send(client, errorResponse(null, "too_large", `Request line exceeds ${MAX_LINE_BYTES} bytes`));
        rejected = true;
        buffer = "";
        socket.end();
      }
    });
    socket.on("error", (error) => log(`client ${client.number}: ${error.message}`));
    socket.on("close", () => {
      clients.delete(client);
      for (const [id, entry] of pending) {
        if (entry.client !== client) continue;
        clearTimeout(entry.timer);
        pending.delete(id);
      }
    });
  }

  function removeSocketIfOurs(): void {
    // A newer host may have replaced our socket; only remove the one we made.
    // server.close() is deliberately never called: libuv unlinks the bound
    // path by name on close, which would delete the newer host's socket.
    try {
      if (socketInode !== undefined && lstatSync(path).ino === socketInode) unlinkSync(path);
    } catch {
      // Already gone.
    }
  }

  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down: ${reason}`);
    removeSocketIfOurs();

    for (const { client, originalId } of pending.values()) {
      send(client, errorResponse(originalId, "not_connected", "The browser extension disconnected"));
    }
    pending.clear();

    const flushed = [...clients].map(
      ({ socket }) => new Promise<void>((resolve) => socket.end(() => resolve())),
    );
    const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    void Promise.race([Promise.all(flushed), grace]).then(() => process.exit(0));
  }

  const decoder = new MessageDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      shutdown(`unreadable message from the extension: ${(error as Error).message}`);
      return;
    }
    for (const message of messages) handleExtensionMessage(message);
  });
  process.stdin.on("end", () => shutdown("extension closed the port"));
  process.stdin.on("error", (error) => shutdown(`stdin: ${error.message}`));
  process.stdout.on("error", (error) => shutdown(`stdout: ${error.message}`));

  const server: Server = createServer(handleClient);
  server.on("error", (error) => {
    log(`socket server: ${error.message}`);
    process.exit(1);
  });

  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    log(`socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes, which Unix sockets do not allow: ${path}`);
    process.exit(1);
  }
  ensureSocketDir(path);
  if (!removeStaleSocket(path)) {
    log(`refusing to replace ${path}: it exists and is not a socket`);
    process.exit(1);
  }
  // Bind with a restrictive umask so the socket is never briefly
  // connectable by others before the chmod below.
  const previousUmask = process.umask(0o177);
  server.listen(path, () => log(`listening on ${path}`));
  process.umask(previousUmask);
  // Binding a Unix socket happens synchronously inside listen(), so the
  // file exists now. Recording the inode here, not in the callback, means a
  // shutdown that races startup still cleans up. If the bind failed, the
  // server's error handler exits.
  try {
    chmodSync(path, 0o600);
    socketInode = lstatSync(path).ino;
  } catch {
    // Bind failed; reported through the "error" event.
  }
}

/** Removes a previous host's socket. Returns false if the path is something else. */
function removeStaleSocket(path: string): boolean {
  try {
    if (!lstatSync(path).isSocket()) return false;
  } catch {
    return true; // Nothing there.
  }
  unlinkSync(path);
  return true;
}
