import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CacheEntry, CacheHandler } from "../../src/types.js";
import { buildDefaultHandler } from "../../src/handlers/default.js";
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

describe("default handler (integration)", () => {
  let redis: RealRedis;
  let runtimeA: Runtime;
  let runtimeB: Runtime;
  let handlerA: CacheHandler;
  let handlerB: CacheHandler;

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

    runtimeA = createRuntime({
      redis: redis.url,
      keyPrefix: "test-default:",
    });
    runtimeB = createRuntime({
      redis: redis.url,
      keyPrefix: "test-default:",
    });
    handlerA = buildDefaultHandler(runtimeA);
    handlerB = buildDefaultHandler(runtimeB);

    // Force init so subscribers are connected before we depend on pub/sub.
    await Promise.all([handlerA.refreshTags(), handlerB.refreshTags()]);
  });

  afterEach(async () => {
    await Promise.all([runtimeA.close(), runtimeB.close()]);
  });

  it("each instance maintains its own in-memory storage", async () => {
    await handlerA.set("k", Promise.resolve(entry({ value: toReadableStream("from-A") })));
    expect(await handlerA.get("k", [])).toBeDefined();
    expect(await handlerB.get("k", [])).toBeUndefined();
  });

  it("propagates tag invalidation across instances via pub/sub", async () => {
    await handlerA.set(
      "k",
      Promise.resolve(entry({ tags: ["shared"], timestamp: Date.now() - 1_000 })),
    );
    await handlerB.set(
      "k",
      Promise.resolve(entry({ tags: ["shared"], timestamp: Date.now() - 1_000 })),
    );

    expect(await handlerA.get("k", [])).toBeDefined();
    expect(await handlerB.get("k", [])).toBeDefined();

    await handlerA.updateTags(["shared"]);
    await waitFor(async () => {
      const got = await handlerB.get("k", []);
      return got === undefined;
    }, 2_000);

    expect(await handlerB.get("k", [])).toBeUndefined();
  });

  it("getExpiration returns matching timestamps across instances", async () => {
    expect(await handlerA.getExpiration(["x"])).toBe(0);
    expect(await handlerB.getExpiration(["x"])).toBe(0);

    await handlerA.updateTags(["x"]);
    await waitFor(async () => (await handlerB.getExpiration(["x"])) > 0, 2_000);

    expect(await handlerA.getExpiration(["x"])).toBeGreaterThan(0);
    expect(await handlerB.getExpiration(["x"])).toBeGreaterThan(0);
  });

  it("round-trips body content correctly", async () => {
    const body = Buffer.from("integration-content");
    await handlerA.set("k", Promise.resolve(entry({ value: toReadableStream(body) })));
    const got = await handlerA.get("k", []);
    expect(got).toBeDefined();
    if (!got) return;
    expect(await collectStream(got.value)).toEqual(body);
  });
});

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
