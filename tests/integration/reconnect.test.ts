import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDefaultHandler } from "../../src/handlers/default.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import type { CacheHandler } from "../../src/types.js";
import { Relay } from "../helpers/relay.js";
import { startRedis, type RealRedis } from "../helpers/redis-real.js";
import { timed, until } from "../helpers/timing.js";

describe("redis outage resilience (integration)", () => {
  let redis: RealRedis;
  let relay: Relay;
  // Talks to Redis directly: the "other pod" whose invalidations must reach us.
  let peer: Runtime;
  let peerHandler: CacheHandler;
  // Talks through the relay: the pod that experiences the outages.
  let runtime: Runtime;
  let handler: CacheHandler;

  beforeAll(async () => {
    redis = await startRedis();
    relay = await Relay.create(redis.url);

    peer = createRuntime({ redis: redis.url, keyPrefix: "test-reconnect:" });
    peerHandler = buildDefaultHandler(peer);
    await peerHandler.refreshTags();

    runtime = createRuntime({
      redis: relay.url,
      keyPrefix: "test-reconnect:",
    });
    handler = buildDefaultHandler(runtime);
  });

  afterAll(async () => {
    await runtime.close().catch(() => {});
    await peer.close();
    await relay.down();
    await redis.stop();
  });

  it("boots uncoordinated while Redis is down, then joins once it is back", async () => {
    const miss = await timed(() => handler.get("k", []));
    expect(miss.result).toBeUndefined();
    expect(miss.ms).toBeLessThan(1_500);

    // An invalidation published while we are down must not be lost to us.
    await peerHandler.updateTags(["boot-tag"]);

    await relay.up();
    // Backoff ≤ 2 s; the first call after reconnect completes the init that failed at boot.
    await until(() => (runtime.client.status as string) === "ready");
    await handler.refreshTags();
    expect(runtime.coordinator.manifest.get("boot-tag")).toBeDefined();
  });

  it("fails fast during a mid-life outage and re-syncs missed invalidations after", async () => {
    await relay.down();
    await until(() => (runtime.client.status as string) !== "ready");

    const miss = await timed(() => handler.get("k", []));
    expect(miss.result).toBeUndefined();
    expect(miss.ms).toBeLessThan(1_500);
    // Write path swallows the failure instead of throwing into Next.
    const write = await timed(() => handler.updateTags(["dropped-locally"]));
    expect(write.ms).toBeLessThan(1_500);

    await peerHandler.updateTags(["missed-tag"]);

    await relay.up();
    await until(() => (runtime.client.status as string) === "ready");
    // Either the subscriber's ready re-sync or the refreshTags fallback covers it.
    await until(() => {
      void handler.refreshTags();
      return runtime.coordinator.manifest.get("missed-tag") !== undefined;
    });

    await peerHandler.updateTags(["live-tag"]);
    await until(() => runtime.coordinator.manifest.get("live-tag") !== undefined);
  });
});
