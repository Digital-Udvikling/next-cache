import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { createKeyBuilder } from "../../src/redis/keys.js";
import { TagCoordinator } from "../../src/tags/coordinator.js";

/** connect() fails `failures` times, then succeeds: an instance booting while Redis is down. */
class FlakyClient extends EventEmitter {
  status = "wait";
  connectAttempts = 0;
  duplicates: FlakyClient[] = [];

  constructor(private failures: number) {
    super();
  }

  async connect(): Promise<void> {
    this.connectAttempts += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      // Mirrors ioredis: a refused attempt settles into its own retry cycle.
      this.status = "reconnecting";
      throw new Error("Connection is closed.");
    }
    this.status = "ready";
  }

  /** Test hook: ioredis's background retry has succeeded. */
  backgroundReconnect(): void {
    this.status = "ready";
    this.emit("ready");
  }

  async hgetall(): Promise<Record<string, string>> {
    return {};
  }

  async subscribe(): Promise<void> {}

  duplicate(): FlakyClient {
    const dup = new FlakyClient(0);
    this.duplicates.push(dup);
    return dup;
  }

  pipeline() {
    return { hset: () => this, publish: () => this, exec: async () => [] };
  }
}

const keys = createKeyBuilder("t:", "t:__pubsub:tags");
const asRedis = (c: FlakyClient): Redis => c as unknown as Redis;

describe("TagCoordinator.init", () => {
  it("does not cache a failed init: the next call retries and succeeds", async () => {
    const client = new FlakyClient(1);
    const coordinator = new TagCoordinator({ client: asRedis(client), keys, pubsubEnabled: false });

    await expect(coordinator.init()).rejects.toThrow("Connection is closed.");
    // ioredis would keep retrying in the background; simulate it coming back.
    client.status = "end";
    await expect(coordinator.init()).resolves.toBeUndefined();
    expect(client.connectAttempts).toBe(2);

    await coordinator.init();
    expect(client.connectAttempts).toBe(2);
  });

  it("dedupes concurrent callers onto one attempt", async () => {
    const client = new FlakyClient(0);
    const coordinator = new TagCoordinator({ client: asRedis(client), keys, pubsubEnabled: false });
    await Promise.all([coordinator.init(), coordinator.init(), coordinator.init()]);
    expect(client.connectAttempts).toBe(1);
  });

  it("reuses the pub/sub subscriber across init retries", async () => {
    const client = new FlakyClient(0);
    const coordinator = new TagCoordinator({ client: asRedis(client), keys, pubsubEnabled: true });

    // First attempt: main client connects, the subscriber's connect fails.
    const originalDuplicate = client.duplicate.bind(client);
    client.duplicate = () => {
      const dup = originalDuplicate();
      dup.connect = vi.fn(async () => {
        dup.status = "reconnecting";
        throw new Error("Connection is closed.");
      });
      return dup;
    };
    await expect(coordinator.init()).rejects.toThrow("Connection is closed.");
    expect(client.duplicates).toHaveLength(1);

    // The retry must reuse the same duplicate rather than leak a second connection.
    const subscriber = client.duplicates[0]!;
    const subscribe = vi.spyOn(subscriber, "subscribe");
    subscriber.backgroundReconnect();
    await expect(coordinator.init()).resolves.toBeUndefined();
    expect(client.duplicates).toHaveLength(1);
    expect(subscribe).toHaveBeenCalledWith(keys.pubsubChannel);
  });
});
