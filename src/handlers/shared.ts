import type { CacheEntry, CacheHandler } from "../types.js";
import type { Runtime } from "../runtime.js";

export interface Storage {
  get(cacheKey: string): Promise<CacheEntry | undefined>;
  set(cacheKey: string, entry: CacheEntry): Promise<void>;
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

export function buildHandler(runtime: Runtime, storage: Storage, label: string): CacheHandler {
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
      if (now > entry.timestamp + entry.revalidate * 1000) {
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
