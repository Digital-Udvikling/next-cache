import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { createKeyBuilder } from "../../src/redis/keys.js";
import { TagCoordinator } from "../../src/tags/coordinator.js";
import { createMockRedis } from "../helpers/redis-mock.js";

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

  /** Test hook: the connection dropped and ioredis started retrying. */
  dropConnection(): void {
    this.status = "reconnecting";
    this.emit("close");
    this.emit("reconnecting", 100);
  }

  /** Test hook: ioredis's background retry has succeeded. */
  backgroundReconnect(): void {
    this.status = "ready";
    this.emit("ready");
  }

  async hscan(): Promise<[string, string[]]> {
    return ["0", []];
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

/** FlakyClient that counts full reads of the tag hash, can hold one open, and keeps its PUBLISHes. */
class ScriptedClient extends FlakyClient {
  fullReads = 0;
  published: string[] = [];
  private held: ((reply: [string, string[]]) => void) | undefined;
  private holdNext = false;

  constructor() {
    super(0);
  }

  /** The next full read stays in flight until the returned function resolves it with `hash`. */
  holdNextSync(): (hash: Record<string, string>) => void {
    this.holdNext = true;
    return (hash) => this.held?.(["0", Object.entries(hash).flat()]);
  }

  override async hscan(_key?: string, cursor?: string): Promise<[string, string[]]> {
    if (cursor === "0") this.fullReads += 1;
    if (!this.holdNext) return ["0", []];
    this.holdNext = false;
    return new Promise((resolve) => {
      this.held = resolve;
    });
  }

  override pipeline() {
    const pipeline = {
      hset: () => pipeline,
      publish: (_channel: string, message: string) => {
        this.published.push(message);
        return pipeline;
      },
      exec: async () => [],
    };
    return pipeline as unknown as ReturnType<FlakyClient["pipeline"]>;
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

describe("TagCoordinator.updateTags", () => {
  it("a hard update after a soft one expires the tag immediately", async () => {
    const coordinator = new TagCoordinator({
      client: asRedis(new FlakyClient(0)),
      keys,
      pubsubEnabled: false,
    });
    await coordinator.init();
    const savedAt = Date.now() - 1;

    await coordinator.updateTags(["t"], { expire: 31_536_000 });
    await coordinator.updateTags(["t"]);

    expect(coordinator.manifest.areTagsExpired(["t"], savedAt)).toBe(true);
  });

  it("rejects when a command in the write pipeline fails", async () => {
    const client = new FlakyClient(0);
    // ioredis resolves exec() with per-command errors rather than rejecting.
    client.pipeline = () => ({
      hset: () => client,
      publish: () => client,
      exec: async () => [
        [new Error("READONLY You can't write against a read only replica."), null],
      ],
    });
    const coordinator = new TagCoordinator({ client: asRedis(client), keys, pubsubEnabled: true });

    await expect(coordinator.updateTags(["t"])).rejects.toThrow();
  });

  it("applies the update locally when Redis is unreachable, before init has succeeded", async () => {
    const coordinator = new TagCoordinator({
      client: asRedis(new FlakyClient(1)),
      keys,
      pubsubEnabled: true,
    });
    const savedAt = Date.now() - 1;

    await expect(coordinator.updateTags(["t"])).rejects.toThrow("Connection is closed.");
    expect(coordinator.manifest.areTagsExpired(["t"], savedAt)).toBe(true);
  });
});

describe("TagCoordinator full sync", () => {
  it("loads a hash larger than one read batch and drops invalid entries", async () => {
    const redis = createMockRedis();
    await redis.flushall();
    const entry = JSON.stringify({ stale: 1, expired: 1 });
    const fields = Array.from({ length: 2_500 }, (_, i) => [`product:${i}`, entry]).flat();
    await redis.hset(keys.tagsHash(), ...fields, "broken", "{not json", "partial", "{}");
    const coordinator = new TagCoordinator({ client: redis, keys, pubsubEnabled: false });

    await coordinator.init();

    expect(coordinator.manifest.get("product:0")).toEqual({ stale: 1, expired: 1 });
    expect(coordinator.manifest.get("product:2499")).toEqual({ stale: 1, expired: 1 });
    expect(coordinator.manifest.get("broken")).toBeUndefined();
    expect(coordinator.manifest.get("partial")).toBeUndefined();
  });

  it("keeps a pub/sub update that arrived while the hash read was in flight", async () => {
    const client = new ScriptedClient();
    const coordinator = new TagCoordinator({ client: asRedis(client), keys, pubsubEnabled: true });
    await coordinator.init();
    const subscriber = client.duplicates[0]!;
    const peerClient = new ScriptedClient();
    const peer = new TagCoordinator({ client: asRedis(peerClient), keys, pubsubEnabled: true });

    // The subscriber's reconnect starts a re-sync; hold its read open.
    const releaseSync = client.holdNextSync();
    subscriber.dropConnection();
    subscriber.backgroundReconnect();
    await vi.waitFor(() => expect(client.fullReads).toBe(2));

    const savedAt = Date.now() - 1;
    await peer.updateTags(["t"]);
    subscriber.emit("message", keys.pubsubChannel, peerClient.published[0]);
    // The snapshot predates the peer's write.
    releaseSync({ t: JSON.stringify({ stale: 1, expired: 1 }) });
    await new Promise((resolve) => setImmediate(resolve));

    expect(coordinator.manifest.areTagsExpired(["t"], savedAt)).toBe(true);
  });
});

async function burstOfRefreshes(coordinator: TagCoordinator): Promise<void> {
  await Promise.all(Array.from({ length: 10 }, () => coordinator.refreshTags()));
  await coordinator.refreshTags();
  await coordinator.refreshTags();
}

describe("TagCoordinator.refreshTags", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-reads the manifest at most every 5 seconds while the subscriber is down", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = new ScriptedClient();
    const coordinator = new TagCoordinator({ client: asRedis(client), keys, pubsubEnabled: true });
    await coordinator.init();
    client.duplicates[0]!.dropConnection();

    let before = client.fullReads;
    await burstOfRefreshes(coordinator);
    expect(client.fullReads - before).toBeLessThanOrEqual(1);

    vi.setSystemTime(Date.now() + 5_001);
    before = client.fullReads;
    await burstOfRefreshes(coordinator);
    expect(client.fullReads - before).toBe(1);
  });

  it("re-reads the manifest on every call when pub/sub is disabled", async () => {
    const client = new ScriptedClient();
    const coordinator = new TagCoordinator({ client: asRedis(client), keys, pubsubEnabled: false });
    await coordinator.init();

    const before = client.fullReads;
    await coordinator.refreshTags();
    await coordinator.refreshTags();
    expect(client.fullReads - before).toBe(2);
  });
});
