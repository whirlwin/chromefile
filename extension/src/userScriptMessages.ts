// Messages from mods (user scripts in the USER_SCRIPT world) to the bridge,
// and the extension-initiated requests they turn into. See
// docs/architecture.md, "Extension-initiated requests".
import { errorMessage } from "./protocol";

export const NOT_CONNECTED = "Chromefile is not connected";
export const UNSUPPORTED = "unsupported message";
export const HOST_REQUEST_TIMEOUT_MS = 15_000;
// Generating a draft runs a whole Claude request; the host gives up after 90s.
export const DRAFT_TIMEOUT_MS = 120_000;
// Ids of requests this extension sends to the host. Replies carry the same id
// and no method, which is how they are told apart from host requests.
export const HOST_ID_PREFIX = "x-";

const MAX_PROMPT = 10_000;
const MAX_FIELD = 2_000;
const MAX_BODY = 200_000;
const TRUNCATED = "\n[truncated]";
const EMAIL_FIELDS = ["subject", "from", "to", "cc", "date", "body"] as const;
const MAX_TWEET_TEXT = 4_000;
const MAX_TWEET_FIELD = 500;
const TWEET_FIELDS = ["author", "handle", "url"] as const;
// Only the shape of a persona name is checked here: which personas exist is
// up to config.json, and the host says so if one is not configured.
const PERSONA_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export type Email = Partial<Record<(typeof EMAIL_FIELDS)[number], string>>;

export interface SpawnParams {
  prompt: string;
  email: Email | null;
  origin: string;
}

export interface Tweet {
  text: string;
  author?: string;
  handle?: string;
  url?: string;
}

export interface DraftParams {
  persona: string;
  tweet: Tweet;
  origin: string;
}

export type UserScriptReply = { ok: true; text?: string } | { ok: false; error: string };

type Parsed =
  | { ok: true; method: "claude.spawn"; params: SpawnParams }
  | { ok: true; method: "claude.draft"; params: DraftParams }
  | { ok: false; error: string };

/**
 * Accepts only `{ type: "claude.spawn", prompt, email? }` and
 * `{ type: "claude.draft", persona, tweet }`, with size caps.
 */
export function parseUserScriptMessage(message: unknown, senderUrl: string | undefined): Parsed {
  if (!isObject(message)) return { ok: false, error: UNSUPPORTED };
  if (message.type === "claude.spawn") return parseSpawn(message, senderUrl);
  if (message.type === "claude.draft") return parseDraft(message, senderUrl);
  return { ok: false, error: UNSUPPORTED };
}

function parseSpawn(message: Record<string, unknown>, senderUrl: string | undefined): Parsed {
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
  return { ok: true, method: "claude.spawn", params: { prompt, email: parsedEmail, origin: originOf(senderUrl) } };
}

function parseDraft(message: Record<string, unknown>, senderUrl: string | undefined): Parsed {
  const { persona, tweet } = message;
  if (typeof persona !== "string" || !PERSONA_NAME.test(persona)) {
    return { ok: false, error: "persona must be a lowercase name: a-z, 0-9 and -, at most 32 characters, starting with a letter" };
  }
  if (!isObject(tweet)) return { ok: false, error: "tweet must be an object" };
  const { text } = tweet;
  if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "tweet.text must be a non-empty string" };
  if (text.length > MAX_TWEET_TEXT) return { ok: false, error: `tweet.text exceeds ${MAX_TWEET_TEXT} characters` };
  const parsedTweet: Tweet = { text };
  for (const key of TWEET_FIELDS) {
    const value = tweet[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return { ok: false, error: `tweet.${key} must be a string` };
    if (value.length > MAX_TWEET_FIELD) return { ok: false, error: `tweet.${key} exceeds ${MAX_TWEET_FIELD} characters` };
    parsedTweet[key] = value;
  }
  return {
    ok: true,
    method: "claude.draft",
    params: { persona, tweet: parsedTweet, origin: originOf(senderUrl) },
  };
}

function originOf(url: string | undefined): string {
  try {
    return url ? new URL(url).origin : "unknown";
  } catch {
    return "unknown";
  }
}

/** A reply from the host to a request this extension started. */
export function isHostReply(message: unknown): message is HostReply {
  return isObject(message) && typeof message.id === "string" && message.id.startsWith(HOST_ID_PREFIX) && !("method" in message);
}

type HostReply = { id: string; result?: unknown; error?: { message?: unknown } };

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

  request(
    method: string,
    params: unknown,
    post: (message: unknown) => void,
    timeoutMs = this.timeoutMs,
  ): Promise<UserScriptReply> {
    const id = `${HOST_ID_PREFIX}${this.next++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `No reply from the host within ${timeoutMs / 1000}s` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        post({ id, method, params });
      } catch (error) {
        this.settle(id, { ok: false, error: errorMessage(error) });
      }
    });
  }

  /**
   * Settles the matching request. Unknown or late replies are dropped. A
   * string `text` in the result (claude.draft) is passed on to the mod.
   */
  handleReply(message: HostReply): void {
    if (message.error) {
      this.settle(message.id, { ok: false, error: String(message.error.message ?? "Unknown error") });
    } else if (isObject(message.result) && typeof message.result.text === "string") {
      this.settle(message.id, { ok: true, text: message.result.text });
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
