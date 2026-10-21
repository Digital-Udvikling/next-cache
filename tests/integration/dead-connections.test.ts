import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { buildRemoteHandler } from "../../src/handlers/remote.js";
import { createClient } from "../../src/redis/client.js";
import { createKeyBuilder } from "../../src/redis/keys.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import { TagCoordinator } from "../../src/tags/coordinator.js";
import { Relay, until } from "../helpers/relay.js";
import { startRedis, type RealRedis } from "../helpers/redis-real.js";
import { toReadableStream } from "../helpers/streams.js";

// A blackholed connection still reports "ready": nothing errors, replies just never arrive.
describe("silently dead connections (integration)", () => {
  let redis: RealRedis;
  let relay: Relay;

  beforeAll(async () => {
    redis = await startRedis();
  });

  afterAll(async () => {
    await redis.stop();
  });

  beforeEach(async () => {
    relay = await Relay.create(redis.url);
    await relay.up();
  });

  afterEach(async () => {
    await relay.down();
  });

  it("detects a dead subscriber and catches up on the invalidations it missed", async () => {
    const keys = createKeyBuilder("test-dead-sub:", "test-dead-sub:__pubsub:tags");
    const clients: Redis[] = [
      createClient({ host: "127.0.0.1", port: relay.port, socketTimeout: 300 }),
      createClient(redis.url),
    ];
    const pod = new TagCoordinator({
      client: clients[0]!,
      keys,
      pubsubEnabled: true,
      subscriberHeartbeatMs: 200,
    });
    const peer = new TagCoordinator({ client: clients[1]!, keys, pubsubEnabled: true });
    try {
      await Promise.all([pod.init(), peer.init()]);

      relay.stall();
      await peer.updateTags(["missed"]);
      await until(() => {
        pod.refreshTags().catch(() => {});
        return pod.manifest.get("missed") !== undefined;
      }, 5_000);

      // Pub/sub delivers again once the subscriber is replaced.
      await peer.updateTags(["live"]);
      await until(() => pod.manifest.get("live") !== undefined, 5_000);
    } finally {
      await Promise.all([pod.close(), peer.close()]);
      for (const client of clients) client.disconnect();
    }
  }, 15_000);

  it("replaces a dead connection instead of missing on every read", async () => {
    const runtime: Runtime = createRuntime({ redis: relay.url, keyPrefix: "test-dead-conn:" });
    const handler = buildRemoteHandler(runtime);
    try {
      await handler.set(
        "k",
        Promise.resolve({
          value: toReadableStream("payload"),
          tags: [],
          stale: 30,
          timestamp: Date.now(),
          expire: 3600,
          revalidate: 60,
        }),
      );
      expect(await handler.get("k", [])).toBeDefined();

      relay.stall();
      expect(await handler.get("k", [])).toBeUndefined();

      const deadline = Date.now() + 10_000;
      let hit = false;
      while (!hit && Date.now() < deadline) {
        hit = (await handler.get("k", [])) !== undefined;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(hit).toBe(true);
    } finally {
      await runtime.close().catch(() => {});
    }
  }, 15_000);
});
