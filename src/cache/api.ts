import type { CacheOptions, NextCacheOptions, ProgrammaticCache } from "../types.js";
import { ensureConnected } from "../redis/client.js";
import { createRuntime, getDefaultRuntime, type Runtime } from "../runtime.js";

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

/**
 * Invalidate `tags` on every instance, with the semantics of Next's `updateTags`/`revalidateTag`
 * durations: without `durations` tagged entries expire now; with them they go stale now and expire
 * after `durations.expire` seconds, keeping their current expiry when `expire` is absent. Runs on
 * the default runtime, which the factory-built cache handlers share, and rejects when the shared
 * write fails, so use it where a lost invalidation must be reported, e.g. a route handler
 * returning 503. `options` only matter for the call that creates the default runtime; with a
 * runtime built by `createRuntime`, use `attachCache(runtime).invalidateTag(tags, durations)`.
 */
export async function updateTags(
  tags: string[],
  durations?: { expire?: number },
  options?: NextCacheOptions,
): Promise<void> {
  const { coordinator, debug } = getDefaultRuntime(options);
  // Writing needs no manifest; init only starts this instance listening for invalidations.
  coordinator.init().catch((err) => debug?.("updateTags: init failed", err));
  await coordinator.updateTags(tags, durations);
}

function wrapRuntime(runtime: Runtime, ownsRuntime: boolean): ProgrammaticCache {
  const { client, keys, coordinator, debug } = runtime;
  // coordinator.init() dedupes and retries; memoizing here would pin a boot-time failure.
  const ensureInit = (): Promise<void> => coordinator.init();

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

    async invalidateTag(tag: string | string[], durations?: { expire?: number }): Promise<void> {
      const tags = Array.isArray(tag) ? tag : [tag];
      if (tags.length === 0) return;
      // Writing needs no manifest; init only starts this instance listening for invalidations.
      ensureInit().catch((err) => debug?.("cache.invalidateTag: init failed", err));
      await coordinator.updateTags(tags, durations);
    },

    async close(): Promise<void> {
      if (ownsRuntime) {
        await runtime.close();
      }
    },
  };

  return cache;
}
