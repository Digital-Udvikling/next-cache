import type { CacheEntry } from "../types.js";

export interface SerializedEntry {
  v: string;
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
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

export function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}

export function encodeEntry(entry: CacheEntry, body: Buffer): string {
  const payload: SerializedEntry = {
    v: body.toString("base64"),
    t: entry.tags,
    s: entry.stale,
    ts: entry.timestamp,
    e: entry.expire,
    r: entry.revalidate,
  };
  return JSON.stringify(payload);
}

export function decodeEntry(raw: string): CacheEntry {
  const payload = JSON.parse(raw) as SerializedEntry;
  const buf = Buffer.from(payload.v, "base64");
  return {
    value: bufferToStream(buf),
    tags: payload.t,
    stale: payload.s,
    timestamp: payload.ts,
    expire: payload.e,
    revalidate: payload.r,
  };
}
