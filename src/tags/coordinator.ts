import type { Redis } from "ioredis";
import type { TagDurations, TagManifestEntry } from "../types.js";
import { TagManifest } from "./manifest.js";
import { duplicateForPubsub, ensureConnected } from "../redis/client.js";
import type { KeyBuilder } from "../redis/keys.js";

interface PubsubMessage {
  tags: string[];
  entry: TagManifestEntry;
}

// Bounds the full re-read that stands in for pub/sub while the subscriber is down.
const DEGRADED_SYNC_INTERVAL_MS = 5_000;
const SCAN_BATCH_SIZE = 1_000;
const SUBSCRIBER_HEARTBEAT_MS = 5_000;

export interface CoordinatorOptions {
  client: Redis;
  keys: KeyBuilder;
  pubsubEnabled: boolean;
  /** Ping interval for the subscriber; a ping unanswered for as long replaces the connection. */
  subscriberHeartbeatMs?: number;
  debug?: (...args: unknown[]) => void;
  /** Reports a failed shared write, once per (possibly joined) `updateTags` write. */
  warn?: (...args: unknown[]) => void;
}

/** Milliseconds until expiry, or undefined to mark tags stale while keeping their expiry. */
function toExpireMs(durations?: TagDurations): number | undefined {
  if (!durations) return 0;
  const { expire } = durations;
  if (expire === undefined) return undefined;
  return Number.isFinite(expire) && expire > 0 ? expire * 1000 : 0;
}

/**
 * Keeps the in-memory tag manifest in step with the shared Redis hash (pub/sub, else full
 * re-read). Methods that read or write Redis throw while it is unreachable, though `updateTags`
 * applies its update locally first; nothing blocks on a reconnect.
 */
export class TagCoordinator {
  readonly manifest = new TagManifest();
  private readonly client: Redis;
  private readonly keys: KeyBuilder;
  private readonly pubsubEnabled: boolean;
  private readonly subscriberHeartbeatMs: number;
  private readonly debug?: (...args: unknown[]) => void;
  private readonly warn?: (...args: unknown[]) => void;
  private subscriber: Redis | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  // Pub/sub can't replay what a reconnecting subscriber missed: only a re-read that started after
  // the latest subscriber "ready" (generation) catches up.
  private subscriberGeneration = 0;
  private syncedGeneration = 0;
  private resyncing: { generation: number; done: Promise<void> } | undefined;
  private lastDegradedSyncAt = 0;
  private initialized = false;
  private initPromise: Promise<void> | undefined;
  private closed = false;
  private readonly pendingUpdates = new Map<string, Promise<void>>();

  constructor(opts: CoordinatorOptions) {
    this.client = opts.client;
    this.keys = opts.keys;
    this.pubsubEnabled = opts.pubsubEnabled;
    this.subscriberHeartbeatMs = opts.subscriberHeartbeatMs ?? SUBSCRIBER_HEARTBEAT_MS;
    this.debug = opts.debug;
    this.warn = opts.warn;
  }

  /**
   * Connect, subscribe (when enabled) and load the manifest. Concurrent callers share one
   * attempt; a failure is retried on the next call, never cached for the instance's lifetime.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.doInit()
        .then(() => {
          this.initialized = true;
        })
        .finally(() => {
          this.initPromise = undefined;
        });
    }
    return this.initPromise;
  }

  /** Start `init` without waiting for it, for callers that work without a loaded manifest. */
  start(): void {
    if (this.initialized) return;
    this.init().catch((err) => this.debug?.("init failed", err));
  }

  private async doInit(): Promise<void> {
    await ensureConnected(this.client);
    // Subscribe before reading, so nothing published during the read is missed.
    if (this.pubsubEnabled) {
      await this.startSubscriber();
    }
    await this.catchUp();
  }

  private async startSubscriber(): Promise<void> {
    // Reused across init retries; ioredis re-subscribes after a reconnect and "ready" re-reads.
    if (!this.subscriber) {
      const subscriber = duplicateForPubsub(this.client, this.subscriberHeartbeatMs);
      this.subscriber = subscriber;
      subscriber.on("message", (_channel, raw) => {
        this.handleMessage(raw);
      });
      subscriber.on("ready", () => {
        this.subscriberGeneration += 1;
        this.catchUp().catch((err) => this.debug?.("re-sync failed", err));
      });
      subscriber.on("error", (err) => {
        this.debug?.("subscriber error", err);
      });
      // A blackholed subscriber stays "ready" and silently misses messages; the ping's socket
      // timeout turns that into a reconnect, which re-subscribes and re-reads.
      this.heartbeat = setInterval(() => {
        if (subscriber.status !== "ready") return;
        subscriber.ping().catch((err) => this.debug?.("subscriber ping failed", err));
      }, this.subscriberHeartbeatMs);
      this.heartbeat.unref();
    }
    await ensureConnected(this.subscriber);
    await this.subscriber.subscribe(this.keys.pubsubChannel);
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as PubsubMessage;
      for (const tag of msg.tags) {
        this.manifest.set(tag, msg.entry);
      }
    } catch (err) {
      this.debug?.("invalid pubsub payload", err);
    }
  }

  /**
   * Catch up on invalidations pub/sub cannot deliver. With pub/sub disabled every call re-reads
   * the hash; while the subscriber is down or behind, re-reads run at most once per
   * `DEGRADED_SYNC_INTERVAL_MS` and concurrent callers share one.
   */
  async refreshTags(): Promise<void> {
    if (this.closed) return;
    if (!this.pubsubEnabled) {
      await this.fullSync();
      return;
    }
    const caughtUp = this.syncedGeneration === this.subscriberGeneration;
    if (this.subscriber?.status === "ready" && caughtUp) return;
    if (Date.now() - this.lastDegradedSyncAt < DEGRADED_SYNC_INTERVAL_MS) return;
    await ensureConnected(this.client);
    // Only a re-read that reaches Redis spends the interval; failing fast costs Redis nothing.
    this.lastDegradedSyncAt = Date.now();
    await this.catchUp();
  }

  /** Re-read the hash for the current subscriber generation, joining a re-read already for it. */
  private catchUp(): Promise<void> {
    const generation = this.subscriberGeneration;
    if (this.resyncing?.generation === generation) return this.resyncing.done;
    const done: Promise<void> = this.fullSync()
      .then(() => {
        this.syncedGeneration = Math.max(this.syncedGeneration, generation);
      })
      .finally(() => {
        if (this.resyncing?.done === done) this.resyncing = undefined;
      });
    this.resyncing = { generation, done };
    return done;
  }

  // HSCAN, not HGETALL: one reply for a large hash can outlast the command timeout. The merge
  // keeps updates pub/sub applied mid-scan, and makes fields the scan repeats harmless.
  private async fullSync(): Promise<void> {
    await ensureConnected(this.client);
    let cursor = "0";
    do {
      const [next, fields] = await this.client.hscan(
        this.keys.tagsHash(),
        cursor,
        "COUNT",
        SCAN_BATCH_SIZE,
      );
      cursor = next;
      for (let i = 0; i + 1 < fields.length; i += 2) {
        this.mergeStored(fields[i]!, fields[i + 1]!);
      }
    } while (cursor !== "0");
  }

  private mergeStored(tag: string, value: string): void {
    try {
      const parsed = JSON.parse(value) as TagManifestEntry;
      if (typeof parsed.stale === "number" && typeof parsed.expired === "number") {
        this.manifest.set(tag, parsed);
      }
    } catch (err) {
      this.debug?.("dropping invalid tag entry", tag, err);
    }
  }

  /**
   * Invalidate `tags` (see `TagDurations`): apply the update to the local manifest, then write it
   * to the Redis hash and publish it. Rejects, and warns, when Redis is unreachable or any write
   * fails; the local update stays. Identical calls (same tags in any order, same durations) in one
   * macrotask share one write.
   */
  async updateTags(tags: string[], durations?: TagDurations): Promise<void> {
    const unique = [...new Set(tags)];
    if (unique.length === 0) return;
    this.start();
    const expireMs = toExpireMs(durations);
    const key = JSON.stringify([[...unique].sort(), expireMs ?? null]);
    const pending = this.pendingUpdates.get(key);
    if (pending) return pending;

    const update = this.writeTags(unique, expireMs);
    update.catch((err) =>
      this.warn?.("invalidating tags failed; other instances may serve stale entries", tags, err),
    );
    this.pendingUpdates.set(key, update);
    // Per macrotask, not while in flight: a later identical invalidation needs a fresh timestamp.
    setImmediate(() => this.pendingUpdates.delete(key));
    return update;
  }

  private async writeTags(tags: string[], expireMs: number | undefined): Promise<void> {
    const now = Date.now();
    // Tags that end up with the same entry share one HSET and one pub/sub message.
    const groups = new Map<number, PubsubMessage>();
    for (const tag of tags) {
      const expired =
        expireMs === undefined ? (this.manifest.get(tag)?.expired ?? 0) : now + expireMs;
      let group = groups.get(expired);
      if (!group) {
        group = { tags: [], entry: { stale: now, expired } };
        groups.set(expired, group);
      }
      group.tags.push(tag);
      this.manifest.set(tag, group.entry);
    }
    this.debug?.("updateTags", [...groups.values()]);

    await ensureConnected(this.client);
    const pipeline = this.client.pipeline();
    for (const message of groups.values()) {
      const value = JSON.stringify(message.entry);
      pipeline.hset(this.keys.tagsHash(), Object.fromEntries(message.tags.map((t) => [t, value])));
      if (this.pubsubEnabled) {
        pipeline.publish(this.keys.pubsubChannel, JSON.stringify(message));
      }
    }
    // exec() resolves with per-command errors (READONLY after a failover, OOM) instead of rejecting.
    const results = await pipeline.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
  }

  async getExpiration(tags: string[]): Promise<number> {
    return this.manifest.maxExpired(tags);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeat);
    if (this.subscriber) {
      try {
        await this.subscriber.quit();
      } catch {
        this.subscriber.disconnect();
      }
      this.subscriber = undefined;
    }
  }
}
