import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import {
  buildIncrementalHandler,
  type IncrementalCacheEntry,
  type IncrementalCacheHandler,
  type IncrementalGetContext,
} from "../../src/handlers/incremental.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import { createMockRedis, flushAll } from "../helpers/redis-mock.js";

const TAGS_HEADER = "x-next-cache-tags";

function pageEntry(tags: string[], lastModified = Date.now()): IncrementalCacheEntry {
  return {
    lastModified,
    value: {
      kind: "APP_PAGE",
      headers: tags.length > 0 ? { [TAGS_HEADER]: tags.join(",") } : {},
    },
  };
}

function fetchEntry(lastModified = Date.now()): IncrementalCacheEntry {
  return { lastModified, value: { kind: "FETCH" } };
}

/**
 * Stands in for Next's FileSystemCache: serves entries from a map and records
 * revalidateTag calls. The wrapper must delegate to it for both.
 */
class FakeBase implements IncrementalCacheHandler {
  static entries = new Map<string, IncrementalCacheEntry>();
  static revalidated: Array<{ tags: string | string[]; durations?: { expire?: number } }> = [];

  static reset(): void {
    FakeBase.entries.clear();
    FakeBase.revalidated = [];
  }

  async get(cacheKey: string, _ctx: IncrementalGetContext) {
    return FakeBase.entries.get(cacheKey) ?? null;
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }) {
    FakeBase.revalidated.push({ tags, durations });
  }
}

describe("incremental handler", () => {
  let runtime: Runtime;
  let handler: IncrementalCacheHandler;

  beforeEach(async () => {
    const redis = createMockRedis();
    await flushAll(redis);
    runtime = createRuntime({ redis });
    FakeBase.reset();
    const Handler = buildIncrementalHandler(runtime, FakeBase);
    handler = new Handler({});
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("passes through misses", async () => {
    expect(await handler.get("missing", {})).toBeNull();
  });

  it("returns entries whose tags are not expired", async () => {
    FakeBase.entries.set("k", pageEntry(["product:1"]));
    expect(await handler.get("k", {})).not.toBeNull();
  });

  it("returns entries without tags untouched", async () => {
    FakeBase.entries.set("k", pageEntry([]));
    expect(await handler.get("k", {})).not.toBeNull();
  });

  it("drops page entries when a tag was expired after the entry was saved", async () => {
    FakeBase.entries.set("k", pageEntry(["product:1"], Date.now() - 1000));
    await runtime.coordinator.updateTags(["product:1"], { expire: 0 });
    expect(await handler.get("k", {})).toBeNull();
  });

  it("keeps page entries saved after the tag expiration", async () => {
    await runtime.coordinator.updateTags(["product:1"], { expire: 0 });
    FakeBase.entries.set("k", pageEntry(["product:1"], Date.now() + 1000));
    expect(await handler.get("k", {})).not.toBeNull();
  });

  it("checks fetch entries against ctx tags and softTags", async () => {
    FakeBase.entries.set("k", fetchEntry(Date.now() - 1000));
    await runtime.coordinator.updateTags(["fetched"], { expire: 0 });
    expect(await handler.get("k", { kind: "FETCH", tags: ["fetched"] })).toBeNull();
    FakeBase.entries.set("s", fetchEntry(Date.now() - 1000));
    expect(await handler.get("s", { kind: "FETCH", softTags: ["fetched"] })).toBeNull();
    FakeBase.entries.set("other", fetchEntry(Date.now() - 1000));
    expect(await handler.get("other", { kind: "FETCH", tags: ["untouched"] })).not.toBeNull();
  });

  it("delegates revalidateTag to the base handler and publishes to the shared manifest", async () => {
    await handler.revalidateTag(["product:1"], { expire: 0 });
    expect(FakeBase.revalidated).toEqual([{ tags: ["product:1"], durations: { expire: 0 } }]);
    expect(runtime.coordinator.manifest.maxExpired(["product:1"])).toBeGreaterThan(0);
  });

  it("normalizes a single-string tag when publishing", async () => {
    await handler.revalidateTag("product:2");
    expect(FakeBase.revalidated).toEqual([{ tags: "product:2", durations: undefined }]);
    expect(runtime.coordinator.manifest.maxExpired(["product:2"])).toBeGreaterThan(0);
  });

  it("degrades to base behavior when Redis is unavailable", async () => {
    const failing = {
      status: "wait",
      connect: async () => {
        throw new Error("connection refused");
      },
      pipeline: () => ({ hset: () => {}, publish: () => {}, exec: async () => [] }),
      duplicate: () => failing,
      hgetall: async () => {
        throw new Error("connection refused");
      },
      quit: async () => "OK",
      disconnect: () => {},
    } as unknown as Redis;

    const failingRuntime = createRuntime({ redis: failing });
    FakeBase.reset();
    const Handler = buildIncrementalHandler(failingRuntime, FakeBase);
    const failingHandler = new Handler({});

    FakeBase.entries.set("k", pageEntry(["product:1"], Date.now() - 1000));
    // The shared check can't run, so the entry is served (per-instance behavior).
    expect(await failingHandler.get("k", {})).not.toBeNull();
    // revalidateTag still reaches the base handler.
    await failingHandler.revalidateTag(["product:1"]);
    expect(FakeBase.revalidated).toHaveLength(1);
  });
});
