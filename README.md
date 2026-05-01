# @aortl/next-cache

Redis cache handlers and a programmatic cache API for self-hosted Next.js 16.

- **`default` handler** for `'use cache'` — keeps cached output in-memory for fast reads, but coordinates tag invalidation through Redis (pub/sub) so `revalidateTag()` propagates across instances.
- **`remote` handler** for `'use cache: remote'` — stores entries in Redis, shared across every instance of your app.
- **Programmatic cache** (`createCache`) — `get` / `set` / `delete` / `getOrSet` / `invalidateTag` over Redis, sharing the same tag manifest as the cache handlers.
- TypeScript, ESM + CJS, peer-deps `ioredis` (≥ 5).

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

Set `REDIS_URL` in your environment and you're done. With no options, the factories pull `REDIS_URL` (defaulting to `redis://localhost:6379`) and use sensible defaults.

### How it works

- **`'use cache'`** entries live in each instance's in-memory LRU. Reads stay local — no Redis round-trip for cache hits. When `revalidateTag()` runs on any instance, that instance writes the new tag timestamp to a Redis hash and publishes on a channel; every other instance picks the change up over pub/sub and discards the affected entries on their next read.
- **`'use cache: remote'`** entries are JSON-encoded and stored in Redis with a TTL matching `expire`. Any instance can serve the cache. Tag invalidation uses the same Redis-backed manifest.
- The programmatic `createCache` API uses the same manifest, so `cache.invalidateTag("foo")` also flushes any `'use cache'` / `'use cache: remote'` entries tagged `foo`.

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
| `redis`                   | `string \| RedisOptions \| Redis` | `process.env.REDIS_URL ?? "redis://localhost:6379"`  | URL string, ioredis options, or a pre-built `Redis` instance               |
| `keyPrefix`               | `string`                          | `process.env.NEXT_CACHE_PREFIX ?? "next-cache:"`     | Prefix for every key + pub/sub channel                                     |
| `pubsub.enabled`          | `boolean`                         | `true`                                               | Disable to fall back to per-request `HGETALL` polling                      |
| `pubsub.channel`          | `string`                          | `"tags"`                                             | Suffix for the pub/sub channel (full channel: `<prefix>__pubsub:<suffix>`) |
| `defaultHandler.maxItems` | `number`                          | `1000`                                               | LRU item cap for the default handler                                       |
| `defaultHandler.maxBytes` | `number`                          | `52_428_800` (50 MiB)                                | LRU byte cap for the default handler                                       |
| `disableDuringBuild`      | `boolean`                         | `true`                                               | Returns a no-op handler when `NEXT_PHASE === "phase-production-build"`     |
| `debug`                   | `boolean`                         | `process.env.NEXT_PRIVATE_DEBUG_CACHE !== undefined` | Verbose logging                                                            |

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

### A note on `revalidateTag` semantics

Next.js 16's `revalidateTag(tag, profile)` passes the cacheLife profile's `expire` to the cache handler's `updateTags(tags, { expire })`. Per Next.js's `areTagsExpired` semantics (`expired <= now AND expired > entry.timestamp`), the invalidation only takes effect once we cross the `expired` timestamp. Profile names like `"default"` or `"max"` carry an `expire` of ~136 years — so they _schedule_ an invalidation rather than _fire_ one. To invalidate immediately from a route handler, pass an explicit `{ expire: 0 }`. From a Server Action, use `updateTag(tag)` (which Next.js routes to immediate invalidation internally).

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
