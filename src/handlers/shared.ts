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

export interface HandlerPolicy {
  label: string;
  dropAfter: DropAfter;
  /**
   * Whether reads wait for the tag manifest to load. Process-local entries were written after
   * boot, so they can be served before it has; shared ones may carry tags invalidated elsewhere.
   */
  readsAwaitManifest: boolean;
}

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
  { label, dropAfter, readsAwaitManifest }: HandlerPolicy,
): CacheHandler {
  const { coordinator, debug } = runtime;
  const pendingSets = new Map<string, Promise<void>>();

  return {
    async get(cacheKey, _softTags) {
      if (!readsAwaitManifest) {
        coordinator.start();
      } else {
        try {
          await coordinator.init();
        } catch (err) {
          debug?.(label, "init failed", err);
          return undefined;
        }
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

      return { ...entry, revalidate };
    },

    async set(cacheKey, pendingEntry) {
      let resolvePending = (): void => {};
      const tracker = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
      pendingSets.set(cacheKey, tracker);

      // Writing needs no manifest, so don't hold the write (and reads waiting on it) for init.
      coordinator.start();
      try {
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
        await coordinator.init();
        await coordinator.refreshTags();
      } catch (err) {
        debug?.(label, "refreshTags failed", err);
      }
    },

    async getExpiration(tags) {
      try {
        await coordinator.init();
        return await coordinator.getExpiration(tags);
      } catch (err) {
        debug?.(label, "getExpiration failed", err);
        return 0;
      }
    },

    async updateTags(tags, durations) {
      // The coordinator warns about a failed shared write; Next must not see it.
      await coordinator.updateTags(tags, durations).catch(() => {});
    },
  };
}
