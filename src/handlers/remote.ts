import type { CacheHandler, NextCacheOptions } from "../types.js";
import { isBuildPhase } from "../config.js";
import { getDefaultRuntime, type Runtime } from "../runtime.js";
import { decodeEntry, encodeEntry, readStream } from "../redis/codec.js";
import { ensureConnected } from "../redis/client.js";
import { buildHandler, noopHandler, type Storage } from "./shared.js";

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
      const ttl =
        Number.isFinite(entry.expire) && entry.expire > 0
          ? Math.max(1, Math.floor(entry.expire))
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
  return buildHandler(runtime, createRedisStorage(runtime), "remote");
}

export function createRemoteHandler(options: NextCacheOptions = {}): CacheHandler {
  if ((options.disableDuringBuild ?? true) && isBuildPhase()) {
    return noopHandler();
  }
  return buildRemoteHandler(getDefaultRuntime(options));
}
