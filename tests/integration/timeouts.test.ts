import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { buildRemoteHandler } from "../../src/handlers/remote.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import type { CacheEntry, NextCacheOptions } from "../../src/types.js";
import { startRedis, type RealRedis } from "../helpers/redis-real.js";
import { toReadableStream } from "../helpers/streams.js";

function entry(): CacheEntry {
  return {
    value: toReadableStream("payload"),
    tags: [],
    stale: 30,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 60,
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - started };
}

describe("redis command timeouts (integration)", () => {
  let redis: RealRedis;
  let admin: Redis;
  let runtime: Runtime | undefined;
  let pausedUntil = 0;

  // Blackholes every client's commands while their sockets stay "ready": a hung Redis.
  async function pause(ms: number): Promise<void> {
    await admin.call("CLIENT", "PAUSE", String(ms), "ALL");
    pausedUntil = Date.now() + ms;
  }

  beforeAll(async () => {
    redis = await startRedis();
    admin = redis.newClient();
  });

  afterAll(async () => {
    await redis.stop();
  });

  afterEach(async () => {
    const remaining = pausedUntil - Date.now();
    if (remaining > 0) await new Promise((r) => setTimeout(r, remaining + 100));
    await runtime?.close();
    runtime = undefined;
  });

  async function warmHandler(options: NextCacheOptions) {
    runtime = createRuntime({ keyPrefix: "test-timeouts:", ...options });
    const handler = buildRemoteHandler(runtime);
    await handler.set("k", Promise.resolve(entry()));
    expect(await handler.get("k", [])).toBeDefined();
    return handler;
  }

  it("a read against an unresponsive Redis resolves to a miss quickly", async () => {
    const handler = await warmHandler({ redis: redis.url });

    await pause(3_000);
    const read = await timed(() => handler.get("k", []));
    expect(read.ms).toBeLessThan(1_500);
    expect(read.result).toBeUndefined();
  }, 10_000);

  it("a caller-supplied commandTimeout overrides the default", async () => {
    const { hostname, port } = new URL(redis.url);
    const handler = await warmHandler({
      redis: { host: hostname, port: Number(port), commandTimeout: 5_000 },
    });

    await pause(1_000);
    expect(await handler.get("k", [])).toBeDefined();
  }, 10_000);
});
