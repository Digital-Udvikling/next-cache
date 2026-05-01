import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildDefaultHandler } from "../../src/handlers/default.js";
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
      // refreshTags() should HGETALL and pick up the invalidation.
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
});
