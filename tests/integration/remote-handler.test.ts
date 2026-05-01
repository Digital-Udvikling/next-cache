import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CacheEntry, CacheHandler } from "../../src/types.js";
import { buildRemoteHandler } from "../../src/handlers/remote.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import { startRedis, type RealRedis } from "../helpers/redis-real.js";
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

describe("remote handler (integration)", () => {
  let redis: RealRedis;
  let runtime: Runtime;
  let handler: CacheHandler;

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterAll(async () => {
    await redis.stop();
  });

  beforeEach(async () => {
    const flush = redis.newClient();
    await flush.flushall();
    await flush.quit();

    runtime = createRuntime({
      redis: redis.url,
      keyPrefix: "test-remote:",
    });
    handler = buildRemoteHandler(runtime);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("round-trips entries through real Redis", async () => {
    const body = Buffer.from("real-redis-payload");
    await handler.set("k", Promise.resolve(entry({ tags: ["t1"], value: toReadableStream(body) })));

    const got = await handler.get("k", []);
    expect(got).toBeDefined();
    if (!got) return;
    expect(got.tags).toEqual(["t1"]);
    expect(await collectStream(got.value)).toEqual(body);
  });

  it("respects Redis TTL via expire", async () => {
    await handler.set("k", Promise.resolve(entry({ expire: 1, revalidate: 1 })));
    await new Promise((r) => setTimeout(r, 1_500));
    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("preserves binary payloads end-to-end", async () => {
    const body = Buffer.from([0x00, 0xff, 0x10, 0x80, 0xab, 0xcd, 0x01, 0x02]);
    await handler.set("k", Promise.resolve(entry({ value: toReadableStream(body) })));
    const got = await handler.get("k", []);
    expect(got).toBeDefined();
    if (!got) return;
    expect((await collectStream(got.value)).equals(body)).toBe(true);
  });

  it("a second runtime sees entries written by the first", async () => {
    await handler.set("k", Promise.resolve(entry({ value: toReadableStream("shared-content") })));

    const runtimeB = createRuntime({
      redis: redis.url,
      keyPrefix: "test-remote:",
    });
    const handlerB = buildRemoteHandler(runtimeB);

    try {
      const got = await handlerB.get("k", []);
      expect(got).toBeDefined();
      if (!got) return;
      expect((await collectStream(got.value)).toString()).toBe("shared-content");
    } finally {
      await runtimeB.close();
    }
  });
});
