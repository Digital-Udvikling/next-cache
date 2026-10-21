# @aortl/next-cache

Redis cache handlers and a programmatic cache API for self-hosted Next.js 16.

- **`default` handler** for `'use cache'` — keeps cached output in-memory for fast reads, but coordinates tag invalidation through Redis (pub/sub) so `revalidateTag()` propagates across instances.
- **`remote` handler** for `'use cache: remote'` — stores entries in Redis, shared across every instance of your app.
- **`incremental` handler** for Next's ISR/page cache (`cacheHandler`, singular) — extends the built-in FileSystemCache so saved static pages are invalidated on _every_ instance when `revalidateTag()` runs on any of them.
- **Programmatic cache** (`createCache`) — `get` / `set` / `delete` / `getOrSet` / `invalidateTag` over Redis, sharing the same tag manifest as the cache handlers.
- TypeScript, ESM + CJS, peer-deps `ioredis` (≥ 5) and, for the incremental handler only, `next` (≥ 16.1).

## Installation

```bash
pnpm add @aortl/next-cache ioredis
# or: npm i @aortl/next-cache ioredis
# or: yarn add @aortl/next-cache ioredis
```

## Setup

`@aortl/next-cache` needs Cache Components enabled and two cache handler files referenced from `next.config.ts`. The handler files are tiny shims around the factories.

```ts
// next.config.ts
import type { NextConfig } from "next";

const config: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve("./cache-handlers/default.js"),
    remote: require.resolve("./cache-handlers/remote.js"),
  },
  // Optional: coordinate the ISR/page cache too (see "The incremental handler").
  cacheHandler: require.resolve("./cache-handlers/incremental.js"),
};

export default config;
```

```js
// cache-handlers/default.js
module.exports = require("@aortl/next-cache").createDefaultHandler();
```

```js
// cache-handlers/remote.js
module.exports = require("@aortl/next-cache").createRemoteHandler();
```

```js
// cache-handlers/incremental.js
module.exports = require("@aortl/next-cache").createIncrementalHandler();
```

Set `REDIS_URL` in your environment and you're done. With no options, the factories pull `REDIS_URL` (defaulting to `redis://localhost:6379`) and use sensible defaults.

### How it works

- **`'use cache'`** entries live in each instance's in-memory LRU. Reads stay local — no Redis round-trip for cache hits. When `revalidateTag()` runs on any instance, that instance writes the new tag timestamp to a Redis hash and publishes on a channel; every other instance picks the change up over pub/sub and discards the affected entries on their next read.
- **`'use cache: remote'`** entries are stored in Redis as raw bytes behind a small metadata header, with a TTL matching `expire`. Entries in the older JSON format read as misses, so the remote cache starts cold after upgrading. Any instance can serve the cache. Entries past their `revalidate` time are still served (stale-while-revalidate) — Next.js refreshes them in the background — and are only dropped once past `expire`. Dynamic entries (`expire: 0`) are never written. Tag invalidation uses the same Redis-backed manifest.
- The programmatic `createCache` API uses the same manifest, so `cache.invalidateTag("foo")` also flushes any `'use cache'` / `'use cache: remote'` entries tagged `foo`.
- The **incremental** handler keeps page storage on the local filesystem but checks every read against the shared manifest, and publishes its own `revalidateTag()` calls to it. It also mirrors the shared manifest into Next's in-process tag map, which Next consults to serve saved pages stale-while-revalidate, so a soft `revalidateTag(tag, profile)` reaches every instance.

### The incremental handler

Next's `cacheHandler` (singular) is a separate system from `cacheHandlers` (plural): it stores finished responses — the saved fully-static pages (HTML + RSC payload) that Cache Components produce after the first visit to a URL not listed in `generateStaticParams`, plus the fetch cache. The built-in FileSystemCache tracks tag invalidations in an in-process map with no propagation, so behind a load balancer `revalidateTag()` only drops the saved pages on the instance that executed it; every other instance keeps serving its saved copy until the route's `revalidate` window elapses — even when the `'use cache'` data underneath was correctly invalidated everywhere (a saved-page hit skips rendering entirely, so the invalidated data is never consulted).

`createIncrementalHandler()` returns a class extending FileSystemCache. Storage stays on each instance's filesystem (build output remains readable, no page payloads in Redis), but reads are additionally checked against the shared tag manifest: a tag expired after a page was saved turns the read into a miss, forcing a re-render that picks up fresh data.

Caveats:

- It extends `next/dist/server/lib/incremental-cache/file-system-cache`, an **internal** Next API — pin your Next version and re-verify on upgrades. The factory fails loudly if the module shape changes.
- `next` must be installed alongside this package (declared as an optional peer dependency).
- Only invalidation is coordinated. Each instance still warms its saved pages independently, and a Redis outage degrades to the built-in per-instance behavior rather than failing requests.
- Redis outages are survivable at any point: handler calls fail fast while Redis is unreachable or hung and resume once ioredis reconnects; a failed initial sync is retried on the next call, and the subscriber re-reads the tag manifest on reconnect so invalidations published meanwhile are not missed. Meanwhile the `default` handler keeps caching in its in-memory LRU, expiring entries by time only since tag invalidations from other instances cannot reach it, and the `remote` handler misses. Connection errors are `console.warn`ed at most once a minute, and every `revalidateTag()` that fails to reach Redis is `console.warn`ed.
- During `next build` the unmodified FileSystemCache is returned (no Redis in the build environment needed), following `disableDuringBuild`.

## Programmatic cache API

```ts
import { createCache } from "@aortl/next-cache";

const cache = createCache(); // reads REDIS_URL

await cache.set("user:42", { name: "Ada" }, { ttl: 60, tags: ["user:42"] });

const user = await cache.get<{ name: string }>("user:42");

const product = await cache.getOrSet("product:7", async () => fetchProductFromDb(7), {
  ttl: 300,
  tags: ["product:7"],
});

// invalidate every entry (including any 'use cache' / 'use cache: remote' entries)
// with the matching tag.
await cache.invalidateTag("product:7");

await cache.close(); // tear down Redis connection on shutdown
```

The cache stores values as JSON, so values must be JSON-serializable (`Date` objects become strings; `undefined` is dropped from objects; class instances lose their prototype). If you need richer serialization, encode the value yourself before `set`.

## Invalidation

### `revalidateTag` semantics

Next.js 16's `revalidateTag(tag, profile)` passes the cacheLife profile's `expire` to the cache handlers' `updateTags(tags, { expire })`. Tagged entries become stale immediately on every instance, so Next.js regenerates them, but are only dropped outright once `expire` seconds have passed (Next.js's `areTagsExpired`: `expired <= now AND expired > entry.timestamp`). To drop entries immediately, use `updateTag(tag)` from a Server Action or `revalidateTag(tag, { expire: 0 })` from a route handler.

### Confirmed invalidation

The cache handlers never fail a request over Redis: if `revalidateTag()` cannot write the invalidation to Redis, they warn and carry on, and other instances keep serving the old entries. When a route handler needs to know, call `updateTags` instead. It takes the same durations as Next's `updateTags` (omit them to expire immediately, pass `{ expire }` for a `revalidateTag(tag, profile)`-style soft invalidation), runs on the runtime the handlers share, and rejects when the shared write fails:

```ts
import { updateTags } from "@aortl/next-cache";

export async function POST(request: Request) {
  const tag = new URL(request.url).searchParams.get("tag")!;
  try {
    await updateTags([tag]);
  } catch {
    return new Response("invalidation failed", { status: 503 });
  }
  return new Response(null, { status: 204 });
}
```

## Configuration

Both factories and `createCache` accept the same options:

```ts
import { createDefaultHandler, createCache } from "@aortl/next-cache";

createDefaultHandler({
  redis: process.env.REDIS_URL, // string | RedisOptions | Redis instance
  keyPrefix: "myapp:", // default: "next-cache:"
  pubsub: { enabled: true, channel: "tags" },
  defaultHandler: { maxItems: 5000, maxBytes: 100 * 1024 * 1024 },
  disableDuringBuild: true, // skip Redis during `next build`
  debug: true, // log via console.debug
});
```

| Option                    | Type                              | Default                                              | Notes                                                                      |
| ------------------------- | --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `redis`                   | `string \| RedisOptions \| Redis` | `process.env.REDIS_URL ?? "redis://localhost:6379"`  | URL string, ioredis options, or a pre-built `Redis` instance (see below)   |
| `keyPrefix`               | `string`                          | `process.env.NEXT_CACHE_PREFIX ?? "next-cache:"`     | Prefix for every key + pub/sub channel                                     |
| `pubsub.enabled`          | `boolean`                         | `true`                                               | Disable to fall back to re-reading the tag hash on every request           |
| `pubsub.channel`          | `string`                          | `"tags"`                                             | Suffix for the pub/sub channel (full channel: `<prefix>__pubsub:<suffix>`) |
| `defaultHandler.maxItems` | `number`                          | `1000`                                               | LRU item cap for the default handler                                       |
| `defaultHandler.maxBytes` | `number`                          | `52_428_800` (50 MiB)                                | LRU byte cap for the default handler                                       |
| `disableDuringBuild`      | `boolean`                         | `true`                                               | Returns a no-op handler when `NEXT_PHASE === "phase-production-build"`     |
| `debug`                   | `boolean`                         | `process.env.NEXT_PRIVATE_DEBUG_CACHE !== undefined` | Verbose logging                                                            |

### Timeouts

A cache lookup should never be slower than a miss, so clients built from a URL or `RedisOptions` default to `connectTimeout: 1000`, `commandTimeout: 500` and `maxRetriesPerRequest: 1`, with the offline queue disabled. A command that times out counts as a miss. Pass your own values in `RedisOptions` to override them; a pre-built `Redis` instance is used as is.

### Sharing a runtime

By default, repeated calls to `createDefaultHandler` / `createRemoteHandler` / `createCache` (without explicit options) share a single process-wide runtime — one Redis connection, one tag manifest. To get an isolated runtime (e.g. multiple Redis backends in one process), build a runtime explicitly:

```ts
import {
  createRuntime,
  buildDefaultHandler,
  buildRemoteHandler,
  attachCache,
} from "@aortl/next-cache";

const runtime = createRuntime({ redis: "redis://other-host:6379" });
const defaultHandler = buildDefaultHandler(runtime);
const remoteHandler = buildRemoteHandler(runtime);
const cache = attachCache(runtime);
// runtime.close() shuts everything down.
```

## Local development

A bundled `docker-compose.yml` brings up a Redis 7 instance on `localhost:6379`:

```bash
docker compose up -d
```

## Example app

A minimal Next.js 16 app exercising both directives + the programmatic API lives in [`examples/basic`](./examples/basic). It declares cache handler shims under `cache-handlers/`, wires them in `next.config.ts`, and exposes:

- `/cached` — page rendered through `'use cache'`
- `/cached-remote` — page rendered through `'use cache: remote'`
- `POST /api/invalidate?tag=X` — calls `revalidateTag(tag, { expire: 0 })`
- `GET/POST/DELETE /api/kv?key=X` — programmatic cache surface
- `POST /api/kv/invalidate?tag=X` — programmatic `cache.invalidateTag`

Run it locally:

```bash
docker compose up -d                      # bring up Redis
pnpm example:dev                          # Next.js dev mode
# or:
pnpm example:start                        # production build + start
```

## Testing

This is a pnpm workspace; scripts live on the root package and need the `-w` (workspace-root) flag to run from the repo root:

- **Unit** (`pnpm -w test:unit`) — runs against `ioredis-mock`, no daemon needed.
- **Integration** (`pnpm -w test:integration`) — uses [Testcontainers](https://node.testcontainers.org/) to spin up a real Redis container per test file. Requires Docker.
- **End-to-end** (`pnpm -w test:e2e`) — Playwright-driven tests that build the example app, start two `next start` instances backed by a Testcontainers Redis, and exercise `'use cache'`, `'use cache: remote'`, cross-instance pub/sub invalidation, and the programmatic API. See [`e2e/`](./e2e). On NixOS-style systems, the suite auto-detects a system `chromium`/`google-chrome` binary because Playwright's bundled headless-shell isn't dynamically linked to the FHS layout.
- `pnpm -w test` runs unit + integration. `pnpm -w test:all` adds e2e.
- `pnpm -w typecheck` runs `tsc --noEmit`.
- `pnpm -w build` produces ESM + CJS + `.d.ts` in `dist/`.

## Releasing

A GitHub Actions workflow at [`.github/workflows/release.yml`](./.github/workflows/release.yml) publishes `@aortl/next-cache` to npm when you push a `v<version>` tag. Auth uses **npm Trusted Publishing via OIDC** — there's no long-lived `NPM_TOKEN` secret, and every published version carries a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) linking back to the exact GitHub Actions run.

To cut a release, use `pnpm version` to bump `package.json`, commit, and tag in one step, then push branch + tag together:

```bash
pnpm version patch          # 0.1.0 → 0.1.1: bumps package.json, commits, tags v0.1.1
                            # use `minor` or `major` for non-patch bumps
git push --follow-tags      # push HEAD + the new tag — triggers the workflow
```

The workflow runs typecheck → unit + integration tests → build → `npm publish --access public --provenance`. It refuses to publish if the tag's version doesn't match `package.json`.

Trusted publisher configuration on npm (one-time, on the package's Settings → Trusted Publishers page):

| Field             | Value               |
| ----------------- | ------------------- |
| Repository owner  | `Digital-Udvikling` |
| Repository        | `next-cache`        |
| Workflow filename | `release.yml`       |
| Environment       | _(empty)_           |

## License

MIT
