// Chrome native messaging framing: a 4-byte little-endian length prefix
// followed by that many bytes of UTF-8 JSON.

/** Chrome rejects host -> extension messages larger than this. */
export const MAX_OUTGOING_BYTES = 1024 * 1024;

/** Chrome allows extension -> host messages up to this size. */
export const MAX_INCOMING_BYTES = 64 * 1024 * 1024;

export class MessageTooLargeError extends Error {
  readonly size: number;

  constructor(size: number, limit: number) {
    super(`Message of ${size} bytes exceeds the ${limit} byte limit`);
    this.name = "MessageTooLargeError";
    this.size = size;
  }
}

/** Encodes one message. Throws MessageTooLargeError above 1 MiB. */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  if (body.length > MAX_OUTGOING_BYTES) {
    throw new MessageTooLargeError(body.length, MAX_OUTGOING_BYTES);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Streaming decoder. Feed it chunks as they arrive from stdin; it returns
 * every message completed by that chunk and keeps any partial remainder.
 * Throws on oversized or non-JSON frames, after which the stream is
 * desynchronised and the caller should give up on it.
 */
export class MessageDecoder {
  // Chunks are only concatenated once a frame is complete, so a large
  // screenshot arriving in many small chunks is not copied over and over.
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): unknown[] {
    this.chunks.push(chunk);
    this.size += chunk.length;
    const messages: unknown[] = [];
    while (this.size >= 4) {
      if (this.chunks[0]!.length < 4) this.chunks = [Buffer.concat(this.chunks, this.size)];
      const length = this.chunks[0]!.readUInt32LE(0);
      if (length > MAX_INCOMING_BYTES) {
        throw new MessageTooLargeError(length, MAX_INCOMING_BYTES);
      }
      if (this.size < 4 + length) break;
      const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.size);
      const rest = all.subarray(4 + length);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.size = rest.length;
      messages.push(JSON.parse(all.subarray(4, 4 + length).toString("utf8")));
    }
    return messages;
  }
}
