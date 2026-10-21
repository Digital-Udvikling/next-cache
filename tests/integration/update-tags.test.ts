import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRemoteHandler,
  createRuntime,
  getDefaultRuntime,
  resetDefaultRuntime,
  updateTags,
  type NextCacheOptions,
} from "../../src/index.js";
import { startRedis, type RealRedis } from "../helpers/redis-real.js";
import { freePort } from "../helpers/relay.js";
import { toReadableStream } from "../helpers/streams.js";

describe("updateTags (integration)", () => {
  let redis: RealRedis;
  let options: NextCacheOptions;

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

    resetDefaultRuntime();
    options = { redis: redis.url, keyPrefix: "test-update-tags:" };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getDefaultRuntime(options).close();
    resetDefaultRuntime();
  });

  it("resolves once the invalidation is visible to other instances", async () => {
    const writer = createRuntime(options);
    await buildRemoteHandler(writer).set(
      "k",
      Promise.resolve({
        value: toReadableStream("payload"),
        tags: ["product"],
        stale: 30,
        timestamp: Date.now() - 1_000,
        expire: 3600,
        revalidate: 60,
      }),
    );
    await writer.close();

    await updateTags(["product"], undefined, options);

    const reader = createRuntime(options);
    try {
      expect(await buildRemoteHandler(reader).get("k", [])).toBeUndefined();
    } finally {
      await reader.close();
    }
  });

  it("rejects when Redis is unreachable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    options = { ...options, redis: `redis://127.0.0.1:${await freePort()}` };

    await expect(updateTags(["product"], undefined, options)).rejects.toThrow();
  }, 10_000);

  it("rejects when Redis refuses the write", async () => {
    const admin = redis.newClient();
    // A replica of an unreachable primary: connected and readable, but every write is READONLY.
    await admin.call("REPLICAOF", "127.0.0.1", "1");
    try {
      await expect(updateTags(["product"], undefined, options)).rejects.toThrow();
    } finally {
      await admin.call("REPLICAOF", "NO", "ONE");
    }
  });
});
