import { afterEach, describe, expect, it, vi } from "vitest";
import { HostRequests, isHostReply, parseUserScriptMessage, UNSUPPORTED } from "../src/userScriptMessages";

const url = "https://outlook.office.com/mail/inbox/id/abc";

describe("parseUserScriptMessage", () => {
  it("accepts claude.spawn and records the sender origin", () => {
    expect(parseUserScriptMessage({ type: "claude.spawn", prompt: "Reply" }, url)).toEqual({
      ok: true,
      method: "claude.spawn",
      params: { prompt: "Reply", email: null, origin: "https://outlook.office.com" },
    });
    const parsed = parseUserScriptMessage(
      { type: "claude.spawn", prompt: "Reply", email: { subject: "s", body: "b", extra: 1 } },
      undefined,
    );
    expect(parsed).toEqual({
      ok: true,
      method: "claude.spawn",
      params: { prompt: "Reply", email: { subject: "s", body: "b" }, origin: "unknown" },
    });
  });

  it("rejects anything else as unsupported", () => {
    for (const message of [null, "claude.spawn", [], { type: "tabs.list" }, { prompt: "x" }]) {
      expect(parseUserScriptMessage(message, url)).toEqual({ ok: false, error: UNSUPPORTED });
    }
  });

  it("validates types and caps sizes", () => {
    const spawn = (extra: object) => parseUserScriptMessage({ type: "claude.spawn", prompt: "x", ...extra }, url);
    expect(spawn({ prompt: "  " })).toMatchObject({ ok: false });
    expect(spawn({ prompt: 1 })).toMatchObject({ ok: false });
    expect(spawn({ prompt: "x".repeat(10_001) })).toMatchObject({ ok: false, error: expect.stringMatching(/exceeds/) });
    expect(spawn({ email: "text" })).toMatchObject({ ok: false });
    expect(spawn({ email: { from: 5 } })).toMatchObject({ ok: false, error: "email.from must be a string" });
    expect(spawn({ email: { subject: "s".repeat(2_001) } })).toMatchObject({ ok: false });
    expect(spawn({ prompt: "x".repeat(10_000), email: { subject: "s".repeat(2_000) } })).toMatchObject({ ok: true });
  });

  it("truncates a long body with a marker instead of rejecting", () => {
    const parsed = parseUserScriptMessage({ type: "claude.spawn", prompt: "x", email: { body: "b".repeat(250_000) } }, url);
    expect(parsed.ok).toBe(true);
    const body = parsed.ok && parsed.method === "claude.spawn" ? parsed.params.email!.body! : "";
    expect(body.startsWith("b".repeat(200_000))).toBe(true);
    expect(body.endsWith("\n[truncated]")).toBe(true);
    expect(body.length).toBe(200_000 + "\n[truncated]".length);
  });
});

describe("parseUserScriptMessage for claude.draft", () => {
  const xUrl = "https://x.com/home";
  const tweet = { author: "Jamie Placeholder", handle: "@jamie", text: "Hello", url: "https://x.com/jamie/status/1" };
  const draft = (extra: object) => parseUserScriptMessage({ type: "claude.draft", persona: "example", tweet, ...extra }, xUrl);

  it("accepts a draft request and records the sender origin", () => {
    expect(draft({})).toEqual({
      ok: true,
      method: "claude.draft",
      params: { persona: "example", tweet, origin: "https://x.com" },
    });
    expect(draft({ tweet: { text: "Only text", extra: 1 } })).toEqual({
      ok: true,
      method: "claude.draft",
      params: { persona: "example", tweet: { text: "Only text" }, origin: "https://x.com" },
    });
  });

  it("accepts any lowercase persona name, leaving which ones exist to the host", () => {
    for (const persona of ["a", "someone", "my-voice-2", `a${"b".repeat(31)}`]) {
      expect(draft({ persona })).toMatchObject({ ok: true, params: { persona } });
    }
  });

  it("rejects persona names that are not lowercase keys", () => {
    const error = "persona must be a lowercase name: a-z, 0-9 and -, at most 32 characters, starting with a letter";
    for (const persona of ["", "Example", "1abc", "-abc", "my_voice", "__proto__", "a b", `a${"b".repeat(32)}`, 5, ["example"], undefined]) {
      expect(draft({ persona })).toEqual({ ok: false, error });
    }
  });

  it("validates types and caps sizes", () => {
    expect(draft({ tweet: null })).toEqual({ ok: false, error: "tweet must be an object" });
    expect(draft({ tweet: { text: "  " } })).toMatchObject({ ok: false, error: "tweet.text must be a non-empty string" });
    expect(draft({ tweet: { text: 5 } })).toMatchObject({ ok: false });
    expect(draft({ tweet: { text: "t".repeat(4_001) } })).toMatchObject({ ok: false, error: expect.stringMatching(/exceeds 4000/) });
    expect(draft({ tweet: { text: "t".repeat(4_000) } })).toMatchObject({ ok: true });
    expect(draft({ tweet: { text: "t", author: 1 } })).toMatchObject({ ok: false, error: "tweet.author must be a string" });
    expect(draft({ tweet: { text: "t", url: "u".repeat(501) } })).toMatchObject({ ok: false, error: expect.stringMatching(/exceeds 500/) });
    expect(draft({ tweet: { text: "t", handle: "h".repeat(500) } })).toMatchObject({ ok: true });
  });
});

describe("isHostReply", () => {
  it("tells replies to our requests from host requests", () => {
    expect(isHostReply({ id: "x-1", result: {} })).toBe(true);
    expect(isHostReply({ id: "x-1", error: { code: "internal", message: "m" } })).toBe(true);
    expect(isHostReply({ id: "x-1", method: "claude.spawn" })).toBe(false);
    expect(isHostReply({ id: "1:4", result: {} })).toBe(false);
    expect(isHostReply({ id: 7, result: {} })).toBe(false);
  });
});

describe("HostRequests", () => {
  afterEach(() => vi.useRealTimers());

  it("correlates replies by id, in any order", async () => {
    const requests = new HostRequests();
    const posted: any[] = [];
    const a = requests.request("claude.spawn", { prompt: "a" }, (m) => posted.push(m));
    const b = requests.request("claude.spawn", { prompt: "b" }, (m) => posted.push(m));
    expect(posted).toEqual([
      { id: "x-1", method: "claude.spawn", params: { prompt: "a" } },
      { id: "x-2", method: "claude.spawn", params: { prompt: "b" } },
    ]);
    requests.handleReply({ id: "x-2", error: { message: "osascript failed" } });
    requests.handleReply({ id: "x-1", result: {} });
    requests.handleReply({ id: "x-99", result: {} }); // unknown: dropped
    expect(await a).toEqual({ ok: true });
    expect(await b).toEqual({ ok: false, error: "osascript failed" });
  });

  it("passes a draft's text on", async () => {
    const requests = new HostRequests();
    const a = requests.request("claude.draft", {}, () => {});
    const b = requests.request("claude.draft", {}, () => {});
    requests.handleReply({ id: "x-1", result: { text: "Ship it." } });
    requests.handleReply({ id: "x-2", result: { text: 7 } });
    expect(await a).toEqual({ ok: true, text: "Ship it." });
    expect(await b).toEqual({ ok: true });
  });

  it("takes a per-request timeout", async () => {
    vi.useFakeTimers();
    const requests = new HostRequests(15_000);
    const pending = requests.request("claude.draft", {}, () => {}, 120_000);
    vi.advanceTimersByTime(15_000);
    requests.handleReply({ id: "x-1", result: { text: "late but fine" } });
    expect(await pending).toEqual({ ok: true, text: "late but fine" });
    const slow = requests.request("claude.draft", {}, () => {}, 120_000);
    vi.advanceTimersByTime(120_000);
    expect(await slow).toEqual({ ok: false, error: "No reply from the host within 120s" });
  });

  it("times out, and ignores a late reply", async () => {
    vi.useFakeTimers();
    const requests = new HostRequests(15_000);
    const pending = requests.request("claude.spawn", {}, () => {});
    vi.advanceTimersByTime(15_000);
    expect(await pending).toEqual({ ok: false, error: "No reply from the host within 15s" });
    requests.handleReply({ id: "x-1", result: {} });
  });

  it("fails everything at once, and survives a post that throws", async () => {
    const requests = new HostRequests();
    const pending = requests.request("claude.spawn", {}, () => {});
    requests.failAll("Chromefile is not connected");
    expect(await pending).toEqual({ ok: false, error: "Chromefile is not connected" });
    const thrown = requests.request("claude.spawn", {}, () => {
      throw new Error("Attempting to use a disconnected port object");
    });
    expect(await thrown).toEqual({ ok: false, error: "Attempting to use a disconnected port object" });
  });
});
