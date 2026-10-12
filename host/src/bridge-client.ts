// Client side of the host's Unix socket, used by `cbb mcp`.
import { createConnection, type Socket } from "node:net";
import { MAX_OUTGOING_BYTES } from "./framing";
import { errorResponse, isObject, type BridgeError, type Response } from "./protocol";

export const NOT_CONNECTED_MESSAGE =
  "The browser is not connected. Open Chrome with the Claude Browser Bridge extension enabled.";

interface Pending {
  resolve: (response: Response) => void;
  timer: NodeJS.Timeout;
}

/**
 * Connects lazily on the first request and again after the host goes away,
 * so the MCP server can start before Chrome and survive Chrome restarts.
 * request() never rejects: failures come back as error responses.
 */
export class BridgeClient {
  private readonly path: string;
  private socket: Promise<Socket> | undefined;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;

  constructor(path: string) {
    this.path = path;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<Response> {
    const id = String(this.nextId++);
    const line = `${JSON.stringify({ id, method, params })}\n`;
    // Chrome would reject it anyway; refuse here so the host never has to
    // drop the connection over it.
    if (Buffer.byteLength(line) > MAX_OUTGOING_BYTES) {
      return errorResponse(id, "too_large", `Request exceeds Chrome's ${MAX_OUTGOING_BYTES} byte message limit`);
    }

    let socket: Socket;
    try {
      socket = await this.connect();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const detail = code === "ENOENT" || code === "ECONNREFUSED" ? "" : ` (${(error as Error).message})`;
      return errorResponse(null, "not_connected", NOT_CONNECTED_MESSAGE + detail);
    }

    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(errorResponse(id, "timeout", `No response to ${method} within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      socket.write(line);
    });
  }

  close(): void {
    void this.socket?.then((socket) => socket.destroy(), () => {});
  }

  private connect(): Promise<Socket> {
    this.socket ??= new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(this.path);
      socket.once("error", (error) => {
        this.socket = undefined;
        reject(error);
      });
      socket.once("connect", () => {
        this.attach(socket);
        resolve(socket);
      });
    });
    return this.socket;
  }

  private attach(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
    socket.on("error", () => {
      // Reported through "close" below.
    });
    socket.on("close", () => {
      this.socket = undefined;
      this.failAll({ code: "not_connected", message: NOT_CONNECTED_MESSAGE });
    });
  }

  private failAll(error: BridgeError): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, error });
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write("cbb mcp: ignoring invalid JSON from the host\n");
      return;
    }
    if (!isObject(message)) return;
    if (message.id === null || message.id === undefined) {
      // The host could not tell which request this answers (for example an
      // oversized line, after which it closes the connection), so it applies
      // to everything in flight.
      const error = message.error as BridgeError | undefined;
      if (error) this.failAll(error);
      return;
    }
    const id = String(message.id);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(message as unknown as Response);
  }
}
