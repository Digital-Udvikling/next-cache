import type { NextCacheOptions, ResolvedConfig } from "./types.js";

const DEFAULTS = {
  keyPrefix: "next-cache:",
  pubsubChannel: "tags",
  defaultMaxItems: 1000,
  defaultMaxBytes: 50 * 1024 * 1024,
} as const;

export function resolveConfig(options: NextCacheOptions = {}): ResolvedConfig {
  const keyPrefix = options.keyPrefix ?? process.env.NEXT_CACHE_PREFIX ?? DEFAULTS.keyPrefix;
  const channelSuffix = options.pubsub?.channel ?? DEFAULTS.pubsubChannel;
  const debug = options.debug ?? process.env.NEXT_PRIVATE_DEBUG_CACHE !== undefined;

  return {
    redis: options.redis ?? process.env.REDIS_URL ?? "redis://localhost:6379",
    keyPrefix,
    pubsubChannel: `${keyPrefix}__pubsub:${channelSuffix}`,
    pubsubEnabled: options.pubsub?.enabled ?? true,
    defaultMaxItems: options.defaultHandler?.maxItems ?? DEFAULTS.defaultMaxItems,
    defaultMaxBytes: options.defaultHandler?.maxBytes ?? DEFAULTS.defaultMaxBytes,
    disableDuringBuild: options.disableDuringBuild ?? true,
    debug,
  };
}

export function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}
