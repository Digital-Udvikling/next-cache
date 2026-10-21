import type { CacheEntry } from "../types.js";

// Layout: FORMAT_VERSION byte, uint32BE header length, JSON header, raw body bytes.
const FORMAT_VERSION = 1;
const PREFIX_BYTES = 5;

interface EntryHeader {
  t: string[];
  s: number;
  ts: number;
  e: number;
  r: number;
}

export async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

/** Stream a copy of `buf`, so readers can't alter the stored original. */
export function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return streamOf(new Uint8Array(buf));
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Serialize `entry`'s metadata and `body` (its already-read value) into one binary payload. */
export function encodeEntry(entry: CacheEntry, body: Buffer): Buffer {
  const header: EntryHeader = {
    t: entry.tags,
    s: entry.stale,
    ts: entry.timestamp,
    e: entry.expire,
    r: entry.revalidate,
  };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(PREFIX_BYTES);
  prefix.writeUInt8(FORMAT_VERSION, 0);
  prefix.writeUInt32BE(headerBytes.byteLength, 1);
  return Buffer.concat([prefix, headerBytes, body]);
}

/**
 * Parse a payload written by `encodeEntry`. Returns undefined, never throws, for anything else
 * (an older format, another version, truncated or corrupt bytes), so callers can treat it as a miss.
 */
export function decodeEntry(raw: Buffer): CacheEntry | undefined {
  if (raw.byteLength < PREFIX_BYTES || raw.readUInt8(0) !== FORMAT_VERSION) return undefined;
  const headerEnd = PREFIX_BYTES + raw.readUInt32BE(1);
  if (headerEnd > raw.byteLength) return undefined;
  let header: unknown;
  try {
    header = JSON.parse(raw.toString("utf8", PREFIX_BYTES, headerEnd));
  } catch {
    return undefined;
  }
  if (!isEntryHeader(header)) return undefined;
  return {
    // The reply buffer belongs to this read alone, so stream it without copying.
    value: streamOf(raw.subarray(headerEnd)),
    tags: header.t,
    stale: header.s,
    timestamp: header.ts,
    expire: header.e,
    revalidate: header.r,
  };
}

function isEntryHeader(value: unknown): value is EntryHeader {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return (
    Array.isArray(h.t) &&
    h.t.every((tag) => typeof tag === "string") &&
    typeof h.s === "number" &&
    typeof h.ts === "number" &&
    typeof h.e === "number" &&
    typeof h.r === "number"
  );
}
