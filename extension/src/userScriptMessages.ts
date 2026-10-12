// Messages from mods (user scripts in the USER_SCRIPT world) to the bridge,
// and the extension-initiated requests they turn into. See
// docs/architecture.md, "Extension-initiated requests".
import { errorMessage } from "./protocol";

export const NOT_CONNECTED = "Claude Browser Bridge is not connected";
export const UNSUPPORTED = "unsupported message";
export const HOST_REQUEST_TIMEOUT_MS = 15_000;
// Ids of requests this extension sends to the host. Replies carry the same id
// and no method, which is how they are told apart from host requests.
export const HOST_ID_PREFIX = "x-";

const MAX_PROMPT = 10_000;
const MAX_FIELD = 2_000;
const MAX_BODY = 200_000;
const TRUNCATED = "\n[truncated]";
const EMAIL_FIELDS = ["subject", "from", "to", "cc", "date", "body"] as const;

export type Email = Partial<Record<(typeof EMAIL_FIELDS)[number], string>>;

export interface SpawnParams {
  prompt: string;
  email: Email | null;
  origin: string;
}

export type UserScriptReply = { ok: true } | { ok: false; error: string };

type Parsed = { ok: true; params: SpawnParams } | { ok: false; error: string };

/** Accepts only `{ type: "claude.spawn", prompt, email? }`, with size caps. */
export function parseUserScriptMessage(message: unknown, senderUrl: string | undefined): Parsed {
  const unsupported: Parsed = { ok: false, error: UNSUPPORTED };
  if (!isObject(message) || message.type !== "claude.spawn") return unsupported;
  const { prompt, email } = message;
  if (typeof prompt !== "string" || prompt.trim() === "") return { ok: false, error: "prompt must be a non-empty string" };
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `prompt exceeds ${MAX_PROMPT} characters` };
  let parsedEmail: Email | null = null;
  if (email !== undefined && email !== null) {
    if (!isObject(email)) return { ok: false, error: "email must be an object or null" };
    parsedEmail = {};
    for (const key of EMAIL_FIELDS) {
      const raw = email[key];
      if (raw === undefined) continue;
      if (typeof raw !== "string") return { ok: false, error: `email.${key} must be a string` };
      let value = raw;
      if (key === "body") {
        if (value.length > MAX_BODY) value = value.slice(0, MAX_BODY) + TRUNCATED;
      } else if (value.length > MAX_FIELD) {
        return { ok: false, error: `email.${key} exceeds ${MAX_FIELD} characters` };
      }
      parsedEmail[key] = value;
    }
  }
  return { ok: true, params: { prompt, email: parsedEmail, origin: originOf(senderUrl) } };
}

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "unknown";
  } catch {
    return "unknown";
  }
}

/** A reply from the host to a request this extension started. */
export function isHostReply(message: unknown): message is { id: string; result?: unknown; error?: { message?: unknown } } {
  return isObject(message) && typeof message.id === "string" && message.id.startsWith(HOST_ID_PREFIX) && !("method" in message);
}

interface Pending {
  resolve: (reply: UserScriptReply) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Correlates extension-initiated requests with the host's replies. `request`
 * never rejects; every outcome is a UserScriptReply.
 */
export class HostRequests {
  private readonly pending = new Map<string, Pending>();
  private next = 1;

  constructor(private readonly timeoutMs = HOST_REQUEST_TIMEOUT_MS) {}

  request(method: string, params: unknown, post: (message: unknown) => void): Promise<UserScriptReply> {
    const id = `${HOST_ID_PREFIX}${this.next++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `No reply from the host within ${this.timeoutMs / 1000}s` });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        post({ id, method, params });
      } catch (error) {
        this.settle(id, { ok: false, error: errorMessage(error) });
      }
    });
  }

  /** Settles the matching request. Unknown or late replies are dropped. */
  handleReply(message: { id: string; result?: unknown; error?: { message?: unknown } }): void {
    if (message.error) {
      this.settle(message.id, { ok: false, error: String(message.error.message ?? "Unknown error") });
    } else {
      this.settle(message.id, { ok: true });
    }
  }

  /** The port went away or the kill switch flipped: fail everything now. */
  failAll(error: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, error });
  }

  private settle(id: string, reply: UserScriptReply): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(reply);
  }
}

/**
 * Lets USER_SCRIPT-world mods call chrome.runtime.sendMessage. There is no
 * event for the "Allow User Scripts" toggle, so this is called on worker
 * start and after every mods.register. Accessing chrome.userScripts can
 * itself throw while the toggle is off, so it is wrapped twice.
 */
export function enableUserScriptMessaging(): void {
  try {
    void chrome.userScripts?.configureWorld({ messaging: true }).catch(() => undefined);
  } catch {
    // User scripts unavailable.
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
