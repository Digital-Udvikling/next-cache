import type { CacheEntry, CacheHandler, NextCacheOptions } from "../types.js";
import { isBuildPhase } from "../config.js";
import { getDefaultRuntime, type Runtime } from "../runtime.js";
import { LruCache } from "../memory/lru.js";
import { bufferToStream, readStream } from "../redis/codec.js";
import { buildHandler, noopHandler, type Storage } from "./shared.js";

interface MemoryEntry {
  meta: Omit<CacheEntry, "value">;
  body: Buffer;
}

export function createMemoryStorage(runtime: Runtime): Storage {
  const lru = new LruCache<MemoryEntry>({
    maxItems: runtime.config.defaultMaxItems,
    maxBytes: runtime.config.defaultMaxBytes,
    sizeOf: (e) => e.body.byteLength,
  });

  return {
    async get(cacheKey) {
      const stored = lru.get(cacheKey);
      if (!stored) return undefined;
      return {
        ...stored.meta,
        value: bufferToStream(stored.body),
      };
    },

    async set(cacheKey, entry) {
      const body = await readStream(entry.value);
      const { value: _value, ...meta } = entry;
      lru.set(cacheKey, { meta, body });
    },
  };
}

export function buildDefaultHandler(runtime: Runtime): CacheHandler {
  if (runtime.config.defaultMaxItems === 0 || runtime.config.defaultMaxBytes === 0) {
    return noopHandler();
  }
  return buildHandler(runtime, createMemoryStorage(runtime), "default", "revalidate");
}

export function createDefaultHandler(options: NextCacheOptions = {}): CacheHandler {
  if ((options.disableDuringBuild ?? true) && isBuildPhase()) {
    return noopHandler();
  }
  return buildDefaultHandler(getDefaultRuntime(options));
}
