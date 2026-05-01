import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CacheEntry, CacheHandler } from "../../src/types.js";
import { buildRemoteHandler } from "../../src/handlers/remote.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import { createMockRedis, flushAll } from "../helpers/redis-mock.js";
import { collectStream, toReadableStream } from "../helpers/streams.js";

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    value: toReadableStream("payload"),
    tags: [],
    stale: 30,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 60,
    ...overrides,
  };
}

describe("remote handler", () => {
  let runtime: Runtime;
  let handler: CacheHandler;

  beforeEach(async () => {
    const redis = createMockRedis();
    await flushAll(redis);
    runtime = createRuntime({ redis });
    handler = buildRemoteHandler(runtime);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("returns undefined for missing keys", async () => {
    expect(await handler.get("missing", [])).toBeUndefined();
  });

  it("round-trips an entry through Redis", async () => {
    await handler.set("k", Promise.resolve(entry({ value: toReadableStream("body-content") })));
    const got = await handler.get("k", []);
    expect(got).toBeDefined();
    if (!got) return;
    expect(got.tags).toEqual([]);
    expect(got.revalidate).toBe(60);
    expect(await collectStream(got.value)).toEqual(Buffer.from("body-content"));
  });

  it("returns undefined after tag invalidation", async () => {
    await handler.set(
      "k",
      Promise.resolve(entry({ tags: ["bar"], timestamp: Date.now() - 1_000 })),
    );
    await handler.updateTags(["bar"]);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("preserves binary payloads", async () => {
    const body = Buffer.from([0x00, 0xff, 0x10, 0x80, 0xab, 0xcd, 0x01]);
    await handler.set("k", Promise.resolve(entry({ value: toReadableStream(body) })));
    const got = await handler.get("k", []);
    expect(got).toBeDefined();
    if (!got) return;
    const out = await collectStream(got.value);
    expect(out.equals(body)).toBe(true);
  });

  it("getExpiration returns updated timestamps", async () => {
    expect(await handler.getExpiration(["x"])).toBe(0);
    await handler.updateTags(["x"]);
    const t = await handler.getExpiration(["x"]);
    expect(t).toBeGreaterThan(0);
  });
});
