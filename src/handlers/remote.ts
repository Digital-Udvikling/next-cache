import type { CacheHandler, NextCacheOptions } from "../types.js";
import { isBuildPhase, isDevServer } from "../config.js";
import { getDefaultRuntime, type Runtime } from "../runtime.js";
import { decodeEntry, encodeEntry, readStream } from "../redis/codec.js";
import { ensureConnected } from "../redis/client.js";
import { MIN_DEV_RETENTION_SECONDS, buildHandler, noopHandler, type Storage } from "./shared.js";

export function createRedisStorage(runtime: Runtime): Storage {
  const { client, keys } = runtime;

  return {
    async get(cacheKey) {
      await ensureConnected(client);
      const raw = await client.get(keys.entry(cacheKey));
      if (!raw) return undefined;
      try {
        return decodeEntry(raw);
      } catch (err) {
        runtime.debug?.("remote decode failed", cacheKey, err);
        return undefined;
      }
    },

    async set(cacheKey, entry) {
      await ensureConnected(client);
      const body = await readStream(entry.value);
      const payload = encodeEntry(entry, body);
      // In dev the handler stores short-`expire` entries (see buildHandler's
      // set); pad the TTL to the dev retention window so they don't vanish
      // from Redis while `get` would still serve them.
      const effectiveExpire = isDevServer()
        ? Math.max(entry.expire, MIN_DEV_RETENTION_SECONDS)
        : entry.expire;
      const ttl =
        Number.isFinite(effectiveExpire) && effectiveExpire > 0
          ? Math.max(1, Math.floor(effectiveExpire))
          : undefined;
      if (ttl !== undefined) {
        await client.set(keys.entry(cacheKey), payload, "EX", ttl);
      } else {
        await client.set(keys.entry(cacheKey), payload);
      }
    },
  };
}

export function buildRemoteHandler(runtime: Runtime): CacheHandler {
  // "expire": Redis-backed entries are served stale past `revalidate` so the
  // 'use cache' wrapper can refresh them in the background instead of blocking.
  return buildHandler(runtime, createRedisStorage(runtime), "remote", "expire");
}

export function createRemoteHandler(options: NextCacheOptions = {}): CacheHandler {
  if ((options.disableDuringBuild ?? true) && isBuildPhase()) {
    return noopHandler();
  }
  return buildRemoteHandler(getDefaultRuntime(options));
}
