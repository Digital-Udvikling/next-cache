import type { Redis } from "ioredis";
import type { TagManifestEntry } from "../types.js";
import { TagManifest } from "./manifest.js";
import { duplicateForPubsub, ensureConnected } from "../redis/client.js";
import type { KeyBuilder } from "../redis/keys.js";

interface PubsubMessage {
  tags: string[];
  entry: TagManifestEntry;
}

export interface CoordinatorOptions {
  client: Redis;
  keys: KeyBuilder;
  pubsubEnabled: boolean;
  debug?: (...args: unknown[]) => void;
}

export class TagCoordinator {
  readonly manifest = new TagManifest();
  private readonly client: Redis;
  private readonly keys: KeyBuilder;
  private readonly pubsubEnabled: boolean;
  private readonly debug?: (...args: unknown[]) => void;
  private subscriber: Redis | undefined;
  private initPromise: Promise<void> | undefined;
  private closed = false;

  constructor(opts: CoordinatorOptions) {
    this.client = opts.client;
    this.keys = opts.keys;
    this.pubsubEnabled = opts.pubsubEnabled;
    this.debug = opts.debug;
  }

  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
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
    this.subscriber = duplicateForPubsub(this.client);
    this.subscriber.on("message", (_channel, raw) => {
      this.handleMessage(raw);
    });
    this.subscriber.on("ready", () => {
      this.fullSync().catch((err) => this.debug?.("re-sync failed", err));
    });
    this.subscriber.on("error", (err) => {
      this.debug?.("subscriber error", err);
    });
    await this.subscriber.connect();
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

  async refreshTags(): Promise<void> {
    if (this.closed) return;
    if (this.pubsubEnabled && this.subscriber?.status === "ready") {
      return;
    }
    await this.fullSync();
  }

  private async fullSync(): Promise<void> {
    const raw = await this.client.hgetall(this.keys.tagsHash());
    const next = new Map<string, TagManifestEntry>();
    for (const [tag, value] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(value) as TagManifestEntry;
        if (typeof parsed.stale === "number" && typeof parsed.expired === "number") {
          next.set(tag, parsed);
        }
      } catch (err) {
        this.debug?.("dropping invalid tag entry", tag, err);
      }
    }
    this.manifest.replace(next);
  }

  async updateTags(tags: string[], durations?: { expire?: number }): Promise<void> {
    if (tags.length === 0) return;
    await ensureConnected(this.client);
    const now = Date.now();
    const expire = durations?.expire;
    const expired =
      typeof expire === "number" && Number.isFinite(expire) && expire > 0
        ? now + expire * 1000
        : now;
    const entry: TagManifestEntry = { stale: now, expired };
    this.debug?.("updateTags", { tags, durations, entry });

    const pipeline = this.client.pipeline();
    for (const tag of tags) {
      pipeline.hset(this.keys.tagsHash(), tag, JSON.stringify(entry));
    }
    if (this.pubsubEnabled) {
      const message: PubsubMessage = { tags, entry };
      pipeline.publish(this.keys.pubsubChannel, JSON.stringify(message));
    }
    await pipeline.exec();

    for (const tag of tags) {
      this.manifest.set(tag, entry);
    }
  }

  async getExpiration(tags: string[]): Promise<number> {
    return this.manifest.maxExpired(tags);
  }

  async close(): Promise<void> {
    this.closed = true;
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
