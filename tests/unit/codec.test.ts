import { describe, expect, it } from "vitest";
import { bufferToStream, decodeEntry, encodeEntry, readStream } from "../../src/redis/codec.js";
import type { CacheEntry } from "../../src/types.js";
import { collectStream, toReadableStream } from "../helpers/streams.js";

describe("codec", () => {
  it("round-trips a buffer through bufferToStream + readStream", async () => {
    const original = Buffer.from("hello world", "utf8");
    const stream = bufferToStream(original);
    const collected = await readStream(stream);
    expect(collected.equals(original)).toBe(true);
  });

  it("collects multi-chunk streams correctly", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("foo"));
        controller.enqueue(Buffer.from("bar"));
        controller.enqueue(Buffer.from("baz"));
        controller.close();
      },
    });
    const collected = await readStream(stream);
    expect(collected.toString("utf8")).toBe("foobarbaz");
  });

  it("encodeEntry + decodeEntry preserve all CacheEntry fields", async () => {
    const body = Buffer.from("payload-content");
    const entry: CacheEntry = {
      value: toReadableStream(body),
      tags: ["t1", "t2"],
      stale: 30,
      timestamp: 1_700_000_000_000,
      expire: 3600,
      revalidate: 60,
    };
    const raw = encodeEntry(entry, body);
    const decoded = decodeEntry(raw);
    expect(decoded.tags).toEqual(["t1", "t2"]);
    expect(decoded.stale).toBe(30);
    expect(decoded.timestamp).toBe(1_700_000_000_000);
    expect(decoded.expire).toBe(3600);
    expect(decoded.revalidate).toBe(60);
    const decodedBody = await collectStream(decoded.value);
    expect(decodedBody.equals(body)).toBe(true);
  });

  it("handles binary payloads (not just utf8)", async () => {
    const body = Buffer.from([0x00, 0xff, 0x10, 0x80, 0xab, 0xcd]);
    const entry: CacheEntry = {
      value: toReadableStream(body),
      tags: [],
      stale: 0,
      timestamp: 0,
      expire: 0,
      revalidate: 0,
    };
    const decoded = decodeEntry(encodeEntry(entry, body));
    const out = await collectStream(decoded.value);
    expect(out.equals(body)).toBe(true);
  });
});
