import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  areTagsStale,
  tagsManifest,
} from "next/dist/server/lib/incremental-cache/tags-manifest.external.js";
import { buildIncrementalHandler } from "../../src/handlers/incremental.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import { NoopIncrementalBase } from "../helpers/incremental.js";
import { startRedis, type RealRedis } from "../helpers/redis-real.js";

describe("incremental handler (integration)", () => {
  let redis: RealRedis;
  let podA: Runtime;
  let podB: Runtime;

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
    tagsManifest.clear();

    podA = createRuntime({ redis: redis.url, keyPrefix: "test-incremental:" });
    podB = createRuntime({ redis: redis.url, keyPrefix: "test-incremental:" });
    await Promise.all([podA.coordinator.init(), podB.coordinator.init()]);
  });

  afterEach(async () => {
    await podA.close();
    await podB.close();
  });

  it("a soft revalidate on one pod marks saved pages stale on another", async () => {
    buildIncrementalHandler(podB, NoopIncrementalBase);

    // Pods share this process's tags manifest: a runtime without an incremental handler must not write it.
    const bystander = createRuntime({ redis: redis.url, keyPrefix: "test-bystander:" });
    await bystander.coordinator.updateTags(["control"], { expire: 3600 });
    await bystander.close();
    expect(tagsManifest.has("control")).toBe(false);

    const savedAt = Date.now() - 1;
    await podA.coordinator.updateTags(["product:1"], { expire: 3600 });

    await vi.waitFor(() => expect(areTagsStale(["product:1"], savedAt)).toBe(true), {
      timeout: 1_000,
    });
  });
});
