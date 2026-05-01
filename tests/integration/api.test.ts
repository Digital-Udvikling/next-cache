import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { attachCache, createCache } from "../../src/cache/api.js";
import { buildDefaultHandler } from "../../src/handlers/default.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import type { ProgrammaticCache } from "../../src/types.js";
import { startRedis, type RealRedis } from "../helpers/redis-real.js";
import { toReadableStream } from "../helpers/streams.js";

describe("programmatic cache (integration)", () => {
  let redis: RealRedis;

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterAll(async () => {
    await redis.stop();
  });

  describe("end-to-end", () => {
    let cache: ProgrammaticCache;

    beforeEach(async () => {
      const flush = redis.newClient();
      await flush.flushall();
      await flush.quit();

      cache = createCache({ redis: redis.url, keyPrefix: "test-api:" });
    });

    afterEach(async () => {
      await cache.close();
    });

    it("round-trips a value", async () => {
      await cache.set("k", { hello: "world" });
      expect(await cache.get<{ hello: string }>("k")).toEqual({ hello: "world" });
    });

    it("respects ttl", async () => {
      await cache.set("k", "v", { ttl: 1 });
      await new Promise((r) => setTimeout(r, 1_500));
      expect(await cache.get("k")).toBeUndefined();
    });

    it("invalidateTag voids tagged entries", async () => {
      await cache.set("k", "v", { tags: ["foo"] });
      expect(await cache.get("k")).toBe("v");
      await new Promise((r) => setTimeout(r, 5));
      await cache.invalidateTag("foo");
      expect(await cache.get("k")).toBeUndefined();
    });

    it("getOrSet de-duplicates concurrent factory invocations", async () => {
      let calls = 0;
      const factory = async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 25));
        return "computed";
      };
      const results = await Promise.all([
        cache.getOrSet("k", factory),
        cache.getOrSet("k", factory),
        cache.getOrSet("k", factory),
      ]);
      expect(results).toEqual(["computed", "computed", "computed"]);
      expect(calls).toBe(1);
    });
  });

  describe("cross-API tag coordination", () => {
    let runtime: Runtime;
    let cache: ProgrammaticCache;

    beforeEach(async () => {
      const flush = redis.newClient();
      await flush.flushall();
      await flush.quit();

      runtime = createRuntime({
        redis: redis.url,
        keyPrefix: "test-cross:",
      });
      cache = attachCache(runtime);
    });

    afterEach(async () => {
      await runtime.close();
    });

    it("programmatic invalidate also voids cache-handler entries", async () => {
      const handler = buildDefaultHandler(runtime);
      await handler.set(
        "k",
        Promise.resolve({
          value: toReadableStream("from-handler"),
          tags: ["mixed"],
          stale: 30,
          timestamp: Date.now() - 1_000,
          expire: 3600,
          revalidate: 60,
        }),
      );
      await cache.invalidateTag("mixed");

      expect(await handler.get("k", [])).toBeUndefined();
    });

    it("cache-handler updateTags also voids programmatic entries", async () => {
      const handler = buildDefaultHandler(runtime);
      await cache.set("k", "value", { tags: ["mixed"] });
      await new Promise((r) => setTimeout(r, 5));
      await handler.updateTags(["mixed"]);

      expect(await cache.get("k")).toBeUndefined();
    });
  });
});
