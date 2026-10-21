import type { Redis } from "ioredis";
import type { TagManifestEntry } from "../types.js";
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
  private subscriber: Redis | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  // Set while a reconnected subscriber's re-read has yet to succeed: pub/sub alone can't catch up.
  private resyncPending = false;
  private initialized = false;
  private initPromise: Promise<void> | undefined;
  private closed = false;
  private degradedSyncInFlight: Promise<void> | undefined;
  private lastDegradedSyncAt = 0;
  private readonly pendingUpdates = new Map<string, Promise<void>>();

  constructor(opts: CoordinatorOptions) {
    this.client = opts.client;
    this.keys = opts.keys;
    this.pubsubEnabled = opts.pubsubEnabled;
    this.subscriberHeartbeatMs = opts.subscriberHeartbeatMs ?? SUBSCRIBER_HEARTBEAT_MS;
    this.debug = opts.debug;
  }

  /**
   * Connect, load the manifest and (when enabled) subscribe. Concurrent callers share one
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

  private async doInit(): Promise<void> {
    await ensureConnected(this.client);
    await this.fullSync();
    if (this.pubsubEnabled) {
      await this.startSubscriber();
    }
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
        this.resyncPending = true;
        this.fullSync().then(
          () => {
            this.resyncPending = false;
          },
          (err) => this.debug?.("re-sync failed", err),
        );
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
   * the hash; while the subscriber is down, re-reads run at most once per
   * `DEGRADED_SYNC_INTERVAL_MS` and concurrent callers share one.
   */
  async refreshTags(): Promise<void> {
    if (this.closed) return;
    if (!this.pubsubEnabled) {
      await this.fullSync();
      return;
    }
    if (this.subscriber?.status === "ready" && !this.resyncPending) return;
    await this.degradedSync();
  }

  private degradedSync(): Promise<void> {
    if (this.degradedSyncInFlight) return this.degradedSyncInFlight;
    if (Date.now() - this.lastDegradedSyncAt < DEGRADED_SYNC_INTERVAL_MS) return Promise.resolve();
    this.degradedSyncInFlight = (async () => {
      await ensureConnected(this.client);
      // Only a re-read that reaches Redis spends the interval; failing fast costs Redis nothing.
      this.lastDegradedSyncAt = Date.now();
      await this.fullSync();
      this.resyncPending = false;
    })().finally(() => {
      this.degradedSyncInFlight = undefined;
    });
    return this.degradedSyncInFlight;
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
   * Invalidate `tags`: apply the update to the local manifest, then write it to the Redis hash
   * and publish it. Rejects when Redis is unreachable or any write fails; the local update stays.
   * Identical calls (same tags in any order, same expiry) in one macrotask share one write.
   */
  async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
    if (tags.length === 0) return;
    const expire = durations?.expire;
    const expireMs =
      typeof expire === "number" && Number.isFinite(expire) && expire > 0 ? expire * 1000 : 0;
    const key = JSON.stringify([[...new Set(tags)].sort(), expireMs]);
    const pending = this.pendingUpdates.get(key);
    if (pending) return pending;

    const update = this.writeTags(tags, expireMs);
    this.pendingUpdates.set(key, update);
    // Per macrotask, not while in flight: a later identical invalidation needs a fresh timestamp.
    setImmediate(() => {
      if (this.pendingUpdates.get(key) === update) this.pendingUpdates.delete(key);
    });
    return update;
  }

  private async writeTags(tags: string[], expireMs: number): Promise<void> {
    const now = Date.now();
    const entry: TagManifestEntry = { stale: now, expired: now + expireMs };
    this.debug?.("updateTags", { tags, entry });
    for (const tag of tags) {
      this.manifest.set(tag, entry);
    }

    await ensureConnected(this.client);
    const pipeline = this.client.pipeline();
    for (const tag of tags) {
      pipeline.hset(this.keys.tagsHash(), tag, JSON.stringify(entry));
    }
    if (this.pubsubEnabled) {
      const message: PubsubMessage = { tags, entry };
      pipeline.publish(this.keys.pubsubChannel, JSON.stringify(message));
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
