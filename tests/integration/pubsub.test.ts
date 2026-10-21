import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { buildDefaultHandler } from "../../src/handlers/default.js";
import {
  buildIncrementalHandler,
  type IncrementalCacheHandler,
} from "../../src/handlers/incremental.js";
import { buildRemoteHandler } from "../../src/handlers/remote.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import type { CacheHandler } from "../../src/types.js";
import { startRedis, type RealRedis } from "../helpers/redis-real.js";
import { toReadableStream } from "../helpers/streams.js";

describe("tag coordinator (integration)", () => {
  let redis: RealRedis;

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterAll(async () => {
    await redis.stop();
  });

  describe("pubsub-disabled fallback", () => {
    let runtimeA: Runtime;
    let runtimeB: Runtime;
    let handlerA: CacheHandler;
    let handlerB: CacheHandler;

    beforeEach(async () => {
      const flush = redis.newClient();
      await flush.flushall();
      await flush.quit();

      runtimeA = createRuntime({
        redis: redis.url,
        keyPrefix: "test-fallback:",
        pubsub: { enabled: true },
      });
      runtimeB = createRuntime({
        redis: redis.url,
        keyPrefix: "test-fallback:",
        pubsub: { enabled: false },
      });
      handlerA = buildDefaultHandler(runtimeA);
      handlerB = buildDefaultHandler(runtimeB);
      await Promise.all([handlerA.refreshTags(), handlerB.refreshTags()]);
    });

    afterEach(async () => {
      await runtimeA.close();
      await runtimeB.close();
    });

    it("instance with pubsub disabled picks up invalidations on refreshTags()", async () => {
      await handlerB.set(
        "k",
        Promise.resolve({
          value: toReadableStream("payload"),
          tags: ["x"],
          stale: 30,
          timestamp: Date.now() - 1_000,
          expire: 3600,
          revalidate: 60,
        }),
      );

      expect(await handlerB.get("k", [])).toBeDefined();

      // A invalidates via pub/sub + Redis hash.
      await handlerA.updateTags(["x"]);

      // B has not refreshed yet; it should still see its in-memory entry as
      // valid (no local manifest update).
      // refreshTags() should re-read the tag hash and pick up the invalidation.
      await handlerB.refreshTags();

      expect(await handlerB.get("k", [])).toBeUndefined();
    });
  });

  describe("pubsub propagation latency", () => {
    let runtimeA: Runtime;
    let runtimeB: Runtime;
    let handlerA: CacheHandler;
    let handlerB: CacheHandler;

    beforeEach(async () => {
      const flush = redis.newClient();
      await flush.flushall();
      await flush.quit();

      runtimeA = createRuntime({
        redis: redis.url,
        keyPrefix: "test-pubsub:",
      });
      runtimeB = createRuntime({
        redis: redis.url,
        keyPrefix: "test-pubsub:",
      });
      handlerA = buildDefaultHandler(runtimeA);
      handlerB = buildDefaultHandler(runtimeB);

      // Trigger init so subscribers connect.
      await Promise.all([handlerA.refreshTags(), handlerB.refreshTags()]);
    });

    afterEach(async () => {
      await runtimeA.close();
      await runtimeB.close();
    });

    it("invalidation reaches a remote instance within 500ms", async () => {
      await handlerB.set(
        "k",
        Promise.resolve({
          value: toReadableStream("payload"),
          tags: ["fast"],
          stale: 30,
          timestamp: Date.now() - 1_000,
          expire: 3600,
          revalidate: 60,
        }),
      );
      expect(await handlerB.get("k", [])).toBeDefined();

      const startedAt = Date.now();
      await handlerA.updateTags(["fast"]);

      let observedAt: number | undefined;
      while (Date.now() - startedAt < 500) {
        const got = await handlerB.get("k", []);
        if (got === undefined) {
          observedAt = Date.now();
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(observedAt).toBeDefined();
    });
  });

  describe("invalidation fan-out", () => {
    let runtime: Runtime;
    let listener: Redis;
    let messages: string[];

    class NoopBase implements IncrementalCacheHandler {
      async get() {
        return null;
      }

      async revalidateTag() {}
    }

    beforeEach(async () => {
      const flush = redis.newClient();
      await flush.flushall();
      await flush.quit();

      runtime = createRuntime({ redis: redis.url, keyPrefix: "test-fanout:" });
      messages = [];
      listener = redis.newClient();
      listener.on("message", (_channel: string, message: string) => messages.push(message));
      await listener.subscribe(runtime.keys.pubsubChannel);
    });

    afterEach(async () => {
      await listener.quit();
      await runtime.close();
    });

    it("publishes one message for the handlers' concurrent calls of one invalidation", async () => {
      const handlers = [buildDefaultHandler(runtime), buildRemoteHandler(runtime)];
      const IncrementalHandler = buildIncrementalHandler(runtime, NoopBase);
      const incremental = new IncrementalHandler({});
      await handlers[0]!.refreshTags();

      // Mirrors Next's revalidateTags: every cache handler plus the incremental cache, in one Promise.all.
      const invalidate = () =>
        Promise.all([
          ...handlers.map((h) => h.updateTags(["product:1"], { expire: 3600 })),
          incremental.revalidateTag(["product:1"], { expire: 3600 }),
        ]);

      await invalidate();
      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(messages).toHaveLength(1);

      await invalidate();
      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(messages).toHaveLength(2);
    });
  });

  describe("large tag hash", () => {
    it("loads a hash whose single-reply read would outlast the command timeout", async () => {
      const seed = redis.newClient();
      await seed.flushall();
      const entry = JSON.stringify({ stale: Date.now(), expired: Date.now() });
      const pipeline = seed.pipeline();
      for (let i = 0; i < 200_000; i++) pipeline.hset("test-large:tags", `product:${i}`, entry);
      await pipeline.exec();
      await seed.quit();

      // Scaled down from production: HGETALL of this hash takes well over 100 ms, one HSCAN batch far less.
      const runtime = createRuntime({
        redis: {
          host: redis.container.getHost(),
          port: redis.container.getPort(),
          commandTimeout: 100,
        },
        keyPrefix: "test-large:",
        pubsub: { enabled: false },
      });
      try {
        await runtime.coordinator.init();
        expect(runtime.coordinator.manifest.get("product:199999")).toBeDefined();
      } finally {
        await runtime.close();
      }
    });
  });
});
