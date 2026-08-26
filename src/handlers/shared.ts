import type { CacheEntry, CacheHandler } from "../types.js";
import type { Runtime } from "../runtime.js";
import { isDevServer } from "../config.js";

export interface Storage {
  get(cacheKey: string): Promise<CacheEntry | undefined>;
  set(cacheKey: string, entry: CacheEntry): Promise<void>;
}

// Mirrors Next.js's MIN_PRERENDERABLE_EXPIRE: in dev, the built-in handlers
// retain entries for at least this long so short-`expire` entries survive
// reloads. We match it so the dev tiered front (which fronts custom handlers)
// doesn't evict entries we've dropped that the built-in would have kept.
export const MIN_DEV_RETENTION_SECONDS = 300;

/**
 * When a stored entry stops being served. "revalidate" mirrors Next.js's
 * built-in in-memory handler (a stale entry likely gets evicted before a
 * background refresh pays off). "expire" serves stale entries until their hard
 * expiry, letting the 'use cache' wrapper revalidate in the background instead
 * of blocking — the right trade-off for persistent shared storage.
 */
export type DropAfter = "revalidate" | "expire";

export function noopHandler(): CacheHandler {
  return {
    get: async () => undefined,
    set: async () => {},
    refreshTags: async () => {},
    getExpiration: async () => 0,
    updateTags: async () => {},
  };
}

export function buildHandler(
  runtime: Runtime,
  storage: Storage,
  label: string,
  dropAfter: DropAfter,
): CacheHandler {
  const { coordinator, debug } = runtime;
  const pendingSets = new Map<string, Promise<void>>();
  let initPromise: Promise<void> | undefined;

  const ensureInit = async (): Promise<void> => {
    if (!initPromise) initPromise = coordinator.init();
    await initPromise;
  };

  return {
    async get(cacheKey, _softTags) {
      try {
        await ensureInit();
      } catch (err) {
        debug?.(label, "init failed", err);
        return undefined;
      }

      const pending = pendingSets.get(cacheKey);
      if (pending) {
        debug?.(label, "get pending", cacheKey);
        await pending;
      }

      let entry: CacheEntry | undefined;
      try {
        entry = await storage.get(cacheKey);
      } catch (err) {
        debug?.(label, "storage.get failed", cacheKey, err);
        return undefined;
      }
      if (!entry) {
        debug?.(label, "miss", cacheKey);
        return undefined;
      }

      const now = Date.now();
      // In dev, mirror the built-in handlers' minimum retention (see
      // MIN_DEV_RETENTION_SECONDS) so reloads keep hitting the cache.
      const maxAgeSeconds = isDevServer()
        ? Math.max(entry.expire, MIN_DEV_RETENTION_SECONDS)
        : dropAfter === "expire"
          ? entry.expire
          : entry.revalidate;
      if (now > entry.timestamp + maxAgeSeconds * 1000) {
        debug?.(label, "expired", cacheKey);
        return undefined;
      }

      if (coordinator.manifest.areTagsExpired(entry.tags, entry.timestamp)) {
        debug?.(label, "tag-expired", cacheKey);
        return undefined;
      }

      let revalidate = entry.revalidate;
      if (coordinator.manifest.areTagsStale(entry.tags, entry.timestamp)) {
        revalidate = -1;
      }

      const [returnStream, keepStream] = entry.value.tee();
      entry.value = keepStream;

      return { ...entry, value: returnStream, revalidate };
    },

    async set(cacheKey, pendingEntry) {
      let resolvePending = (): void => {};
      const tracker = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
      pendingSets.set(cacheKey, tracker);

      try {
        await ensureInit();
        const entry = await pendingEntry;
        // An `expire: 0` entry is dynamic: the 'use cache' wrapper regenerates
        // it on every read, so storing it is a wasted write (and, for Redis,
        // a key with no TTL that lingers forever). Dev keeps it so the minimum
        // retention in `get` can serve it across reloads.
        if (!isDevServer() && entry.expire <= 0) {
          debug?.(label, "skipped dynamic entry", cacheKey);
          return;
        }
        await storage.set(cacheKey, entry);
        debug?.(label, "set", cacheKey);
      } catch (err) {
        debug?.(label, "set failed", cacheKey, err);
      } finally {
        resolvePending();
        pendingSets.delete(cacheKey);
      }
    },

    async refreshTags() {
      try {
        await ensureInit();
        await coordinator.refreshTags();
      } catch (err) {
        debug?.(label, "refreshTags failed", err);
      }
    },

    async getExpiration(tags) {
      try {
        await ensureInit();
        return await coordinator.getExpiration(tags);
      } catch (err) {
        debug?.(label, "getExpiration failed", err);
        return 0;
      }
    },

    async updateTags(tags, durations) {
      try {
        await ensureInit();
        await coordinator.updateTags(tags, durations);
      } catch (err) {
        debug?.(label, "updateTags failed", err);
      }
    },
  };
}
