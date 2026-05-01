import type { CacheOptions, NextCacheOptions, ProgrammaticCache } from "../types.js";
import { ensureConnected } from "../redis/client.js";
import { createRuntime, type Runtime } from "../runtime.js";

interface KvEnvelope<T> {
  v: T;
  t: string[];
  ts: number;
}

export function createCache(options: NextCacheOptions = {}): ProgrammaticCache {
  const runtime = createRuntime(options);
  return wrapRuntime(runtime, true);
}

export function attachCache(runtime: Runtime): ProgrammaticCache {
  return wrapRuntime(runtime, false);
}

function wrapRuntime(runtime: Runtime, ownsRuntime: boolean): ProgrammaticCache {
  const { client, keys, coordinator, debug } = runtime;
  let initPromise: Promise<void> | undefined;
  const ensureInit = async (): Promise<void> => {
    if (!initPromise) initPromise = coordinator.init();
    await initPromise;
  };

  const inflight = new Map<string, Promise<unknown>>();

  const cache: ProgrammaticCache = {
    async get<T>(key: string): Promise<T | undefined> {
      try {
        await ensureInit();
        await ensureConnected(client);
        const raw = await client.get(keys.kv(key));
        if (!raw) return undefined;
        const env = JSON.parse(raw) as KvEnvelope<T>;
        if (
          coordinator.manifest.areTagsExpired(env.t, env.ts) ||
          coordinator.manifest.areTagsStale(env.t, env.ts)
        ) {
          return undefined;
        }
        return env.v;
      } catch (err) {
        debug?.("cache.get failed", key, err);
        return undefined;
      }
    },

    async set<T>(key: string, value: T, opts: CacheOptions = {}): Promise<void> {
      await ensureInit();
      await ensureConnected(client);
      const env: KvEnvelope<T> = {
        v: value,
        t: opts.tags ?? [],
        ts: Date.now(),
      };
      const payload = JSON.stringify(env);
      const ttl =
        opts.ttl !== undefined && Number.isFinite(opts.ttl) && opts.ttl > 0
          ? Math.max(1, Math.floor(opts.ttl))
          : undefined;
      if (ttl !== undefined) {
        await client.set(keys.kv(key), payload, "EX", ttl);
      } else {
        await client.set(keys.kv(key), payload);
      }
    },

    async delete(key: string): Promise<void> {
      await ensureConnected(client);
      await client.del(keys.kv(key));
    },

    async getOrSet<T>(
      key: string,
      factory: () => Promise<T> | T,
      opts: CacheOptions = {},
    ): Promise<T> {
      const existing = await cache.get<T>(key);
      if (existing !== undefined) return existing;

      const pending = inflight.get(key) as Promise<T> | undefined;
      if (pending) return pending;

      const promise = (async () => {
        try {
          const value = await factory();
          await cache.set(key, value, opts);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, promise);
      return promise;
    },

    async invalidateTag(tag: string | string[]): Promise<void> {
      const tags = Array.isArray(tag) ? tag : [tag];
      if (tags.length === 0) return;
      await ensureInit();
      await coordinator.updateTags(tags);
    },

    async close(): Promise<void> {
      if (ownsRuntime) {
        await runtime.close();
      }
    },
  };

  return cache;
}
