import { describe, expect, it } from "vitest";
import { encodeMessage, MAX_OUTGOING_BYTES, MessageDecoder, MessageTooLargeError } from "./framing";

describe("encodeMessage", () => {
  it("prefixes the UTF-8 JSON with its little-endian byte length", () => {
    const frame = encodeMessage({ text: "hé" });
    const body = Buffer.from('{"text":"hé"}', "utf8");
    expect(frame.readUInt32LE(0)).toBe(body.length);
    expect(frame.subarray(4).equals(body)).toBe(true);
  });

  it("accepts a message of exactly 1 MiB", () => {
    // {"a":"..."} has 8 bytes of overhead.
    const frame = encodeMessage({ a: "x".repeat(MAX_OUTGOING_BYTES - 8) });
    expect(frame.readUInt32LE(0)).toBe(MAX_OUTGOING_BYTES);
  });

  it("rejects messages over 1 MiB, counting bytes rather than characters", () => {
    expect(() => encodeMessage({ a: "x".repeat(MAX_OUTGOING_BYTES - 7) })).toThrow(MessageTooLargeError);
    // 600k characters but 1.2 MB of UTF-8.
    expect(() => encodeMessage({ a: "é".repeat(600_000) })).toThrow(MessageTooLargeError);
  });
});

describe("MessageDecoder", () => {
  it("reassembles a message split across chunks, even inside the header", () => {
    const frame = encodeMessage({ id: "1", result: { ok: true } });
    const decoder = new MessageDecoder();
    expect(decoder.push(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.push(frame.subarray(2, 9))).toEqual([]);
    expect(decoder.push(frame.subarray(9))).toEqual([{ id: "1", result: { ok: true } }]);
  });

  it("returns every message in a chunk and keeps the remainder", () => {
    const first = encodeMessage({ n: 1 });
    const second = encodeMessage({ n: 2 });
    const third = encodeMessage({ n: 3 });
    const decoder = new MessageDecoder();
    const chunk = Buffer.concat([first, second, third.subarray(0, 5)]);
    expect(decoder.push(chunk)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(decoder.push(third.subarray(5))).toEqual([{ n: 3 }]);
  });

  it("decodes one byte at a time", () => {
    const frame = encodeMessage({ event: "hello", version: "0.1.0" });
    const decoder = new MessageDecoder();
    const messages = [...frame].flatMap((byte) => decoder.push(Buffer.from([byte])));
    expect(messages).toEqual([{ event: "hello", version: "0.1.0" }]);
  });

  it("accepts incoming messages larger than the outgoing limit", () => {
    const body = Buffer.from(JSON.stringify({ data: "x".repeat(2 * MAX_OUTGOING_BYTES) }), "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    const [message] = new MessageDecoder().push(Buffer.concat([header, body]));
    expect((message as { data: string }).data).toHaveLength(2 * MAX_OUTGOING_BYTES);
  });

  it("rejects a frame claiming more than 64 MiB", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(64 * 1024 * 1024 + 1, 0);
    expect(() => new MessageDecoder().push(header)).toThrow(MessageTooLargeError);
  });
});
