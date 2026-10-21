import type { Redis, RedisOptions } from "ioredis";

export type Timestamp = number;

export interface CacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: Timestamp;
  expire: number;
  revalidate: number;
}

/**
 * How an invalidation applies, as in Next's `updateTags`. Omitted, tagged entries expire now.
 * Given, they go stale now and expire after `expire` seconds, keeping their current expiry when
 * `expire` is absent.
 */
export interface TagDurations {
  expire?: number;
}

export interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<Timestamp>;
  updateTags(tags: string[], durations?: TagDurations): Promise<void>;
}

export type RedisInput = Redis | RedisOptions | string;

export interface NextCacheOptions {
  redis?: RedisInput;
  keyPrefix?: string;
  pubsub?: {
    channel?: string;
    enabled?: boolean;
  };
  defaultHandler?: {
    maxItems?: number;
    maxBytes?: number;
  };
  disableDuringBuild?: boolean;
  debug?: boolean;
}

export interface ResolvedConfig {
  redis: RedisInput;
  keyPrefix: string;
  pubsubChannel: string;
  pubsubEnabled: boolean;
  defaultMaxItems: number;
  defaultMaxBytes: number;
  disableDuringBuild: boolean;
  debug: boolean;
}

export interface TagManifestEntry {
  stale: number;
  expired: number;
}

export interface CacheOptions {
  ttl?: number;
  tags?: string[];
}

export interface ProgrammaticCache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set<T = unknown>(key: string, value: T, options?: CacheOptions): Promise<void>;
  delete(key: string): Promise<void>;
  getOrSet<T = unknown>(
    key: string,
    factory: () => Promise<T> | T,
    options?: CacheOptions,
  ): Promise<T>;
  /** Invalidate `tag` on every instance (see `TagDurations`); rejects when the shared write fails. */
  invalidateTag(tag: string | string[], durations?: TagDurations): Promise<void>;
  close(): Promise<void>;
}
