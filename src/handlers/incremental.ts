import { createRequire } from "node:module";

import { isBuildPhase } from "../config.js";
import { getDefaultRuntime, type Runtime } from "../runtime.js";
import type { NextCacheOptions } from "../types.js";

// The incremental (ISR) cache is Next's *singular* `cacheHandler` — a separate
// system from the `cacheHandlers` (plural) that back `'use cache'`. It stores
// finished responses: the saved fully-static pages (HTML + RSC payload) that
// Cache Components produce after the first visit to an unlisted URL, plus the
// fetch cache. Next's built-in FileSystemCache tracks tag invalidations in an
// in-process map with no cross-instance propagation, so `revalidateTag()` only
// drops saved pages on the instance that executed it — every other instance
// keeps serving its saved copy until the route's `revalidate` window elapses.
//
// `createIncrementalHandler()` returns a class that extends FileSystemCache:
// storage stays on the local filesystem (build output stays readable), but
// reads are additionally checked against the shared Redis tag manifest that
// the default/remote handlers maintain. A tag invalidation received by any
// instance therefore invalidates the saved pages on all of them.

/** Response-header key Next uses to persist a page entry's cache tags. */
const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";

const FILE_SYSTEM_CACHE_PATH = "next/dist/server/lib/incremental-cache/file-system-cache.js";

export interface IncrementalCacheEntry {
  lastModified: number;
  value?: {
    kind?: string;
    headers?: Record<string, string | string[] | undefined>;
  } | null;
}

export interface IncrementalGetContext {
  kind?: string;
  tags?: string[];
  softTags?: string[];
}

export interface IncrementalCacheHandler {
  get(
    cacheKey: string,
    ctx: IncrementalGetContext,
  ): Promise<IncrementalCacheEntry | null | undefined>;
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
}

/**
 * Next instantiates the configured `cacheHandler` class itself (once per
 * request), so the factories below return a class rather than an object.
 */
export type IncrementalCacheHandlerClass = new (ctx: unknown) => IncrementalCacheHandler;

// Mirrors FileSystemCache's own tag extraction: page/route entries carry their
// tags in the x-next-cache-tags response header; fetch entries get them from
// the lookup context.
function entryTags(entry: IncrementalCacheEntry, ctx: IncrementalGetContext): string[] {
  if (entry.value?.kind === "FETCH") {
    return [...(ctx.tags ?? []), ...(ctx.softTags ?? [])];
  }
  const header = entry.value?.headers?.[NEXT_CACHE_TAGS_HEADER];
  return typeof header === "string" && header.length > 0 ? header.split(",") : [];
}

export function buildIncrementalHandler(
  runtime: Runtime,
  Base: IncrementalCacheHandlerClass,
): IncrementalCacheHandlerClass {
  const { coordinator, debug } = runtime;

  // coordinator.init() dedupes and retries; memoizing here would pin a boot-time failure.
  const sharedManifest = async (): Promise<typeof coordinator.manifest> => {
    await coordinator.init();
    return coordinator.manifest;
  };

  return class CoordinatedIncrementalCache extends Base {
    override async get(
      cacheKey: string,
      ctx: IncrementalGetContext,
    ): Promise<IncrementalCacheEntry | null | undefined> {
      const entry = await super.get(cacheKey, ctx);
      if (!entry) return entry;

      const tags = entryTags(entry, ctx ?? {});
      if (tags.length === 0) return entry;

      try {
        const manifest = await sharedManifest();
        if (manifest.areTagsExpired(tags, entry.lastModified)) {
          debug?.("incremental", "tag-expired", cacheKey, tags);
          return null;
        }
      } catch (err) {
        // Redis being unavailable degrades to the base handler's per-instance
        // invalidation (availability over consistency) — never fail the read.
        debug?.("incremental", "manifest check failed", err);
      }
      return entry;
    }

    override async revalidateTag(
      tags: string | string[],
      durations?: { expire?: number },
    ): Promise<void> {
      await super.revalidateTag(tags, durations);

      // Publish to the shared manifest as well, so the handler works even
      // when the default/remote handlers aren't registered. When they are,
      // Next calls their updateTags with the same tags; the double write is
      // idempotent.
      const tagList = typeof tags === "string" ? [tags] : tags;
      if (tagList.length === 0) return;
      try {
        await sharedManifest();
        await coordinator.updateTags(tagList, durations);
      } catch (err) {
        debug?.("incremental", "updateTags failed", err);
      }
    }
  };
}

function loadFileSystemCache(): IncrementalCacheHandlerClass {
  // `typeof __filename` (not `typeof require`) distinguishes the CJS build:
  // esbuild rewrites bare `require` to a shim that exists in ESM output too,
  // but throws when called from an ES module.
  const requireModule =
    typeof __filename === "string" ? createRequire(__filename) : createRequire(import.meta.url);
  let mod: { default?: unknown };
  try {
    mod = requireModule(FILE_SYSTEM_CACHE_PATH) as { default?: unknown };
  } catch (err) {
    throw new Error(
      `@aortl/next-cache: could not load ${FILE_SYSTEM_CACHE_PATH}. ` +
        "createIncrementalHandler() requires next (>= 16) to be installed " +
        "alongside this package.",
      { cause: err },
    );
  }
  if (typeof mod.default !== "function") {
    throw new Error(
      `@aortl/next-cache: ${FILE_SYSTEM_CACHE_PATH} did not export a class. ` +
        "This is an internal Next.js API — the installed Next version is not supported yet.",
    );
  }
  return mod.default as IncrementalCacheHandlerClass;
}

/**
 * Create a class for Next's `cacheHandler` (singular, the incremental/ISR
 * cache) that behaves exactly like the built-in FileSystemCache but checks
 * reads against the shared Redis tag manifest, making `revalidateTag()`
 * effective across all instances.
 *
 * During `next build` the unmodified FileSystemCache is returned (unless
 * `disableDuringBuild: false`), so builds never touch Redis.
 */
export function createIncrementalHandler(
  options: NextCacheOptions = {},
): IncrementalCacheHandlerClass {
  const Base = loadFileSystemCache();
  if ((options.disableDuringBuild ?? true) && isBuildPhase()) {
    return Base;
  }
  return buildIncrementalHandler(getDefaultRuntime(options), Base);
}
