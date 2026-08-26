import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheEntry, CacheHandler } from "../../src/types.js";
import { buildDefaultHandler } from "../../src/handlers/default.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import { createMockRedis, flushAll } from "../helpers/redis-mock.js";
import { collectStream, toReadableStream } from "../helpers/streams.js";

function entry(overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    value: toReadableStream("payload"),
    tags: [],
    stale: 30,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 60,
    ...overrides,
  };
}

describe("default handler", () => {
  let runtime: Runtime;
  let handler: CacheHandler;

  beforeEach(async () => {
    const redis = createMockRedis();
    await flushAll(redis);
    runtime = createRuntime({ redis });
    handler = buildDefaultHandler(runtime);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("returns undefined for missing keys", async () => {
    expect(await handler.get("missing", [])).toBeUndefined();
  });

  it("stores and returns entries", async () => {
    await handler.set("k", Promise.resolve(entry({ value: toReadableStream("hello") })));
    const got = await handler.get("k", []);
    expect(got).toBeDefined();
    if (!got) return;
    expect(await collectStream(got.value)).toEqual(Buffer.from("hello"));
  });

  it("returns the entry on subsequent gets (re-streamed from buffer)", async () => {
    await handler.set("k", Promise.resolve(entry({ value: toReadableStream("repeat") })));
    const a = await handler.get("k", []);
    const b = await handler.get("k", []);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    if (!a || !b) return;
    expect((await collectStream(a.value)).toString()).toBe("repeat");
    expect((await collectStream(b.value)).toString()).toBe("repeat");
  });

  it("returns undefined when entry has expired by revalidate time", async () => {
    const old = Date.now() - 120_000;
    await handler.set("k", Promise.resolve(entry({ timestamp: old, revalidate: 60 })));
    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("does not store dynamic entries (expire <= 0)", async () => {
    // revalidate > expire is unrealistic, but distinguishes "skipped on set"
    // from "dropped on get by the revalidate cutoff".
    await handler.set("k", Promise.resolve(entry({ expire: 0, revalidate: 60 })));
    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("in dev, retains entries past revalidate (minimum retention)", async () => {
    vi.stubEnv("__NEXT_DEV_SERVER", "1");
    try {
      const old = Date.now() - 120_000;
      await handler.set(
        "k",
        Promise.resolve(entry({ timestamp: old, revalidate: 60, expire: 3600 })),
      );
      const got = await handler.get("k", []);
      expect(got).toBeDefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns undefined after a tag is invalidated for an entry that predates it", async () => {
    await handler.set(
      "k",
      Promise.resolve(entry({ tags: ["foo"], timestamp: Date.now() - 1_000 })),
    );
    await handler.updateTags(["foo"]);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  it("a newer entry is not invalidated by an older tag invalidation", async () => {
    await handler.updateTags(["foo"]);
    await new Promise((r) => setTimeout(r, 5));
    await handler.set(
      "k",
      Promise.resolve(
        entry({ tags: ["foo"], timestamp: Date.now(), value: toReadableStream("fresh") }),
      ),
    );
    const got = await handler.get("k", []);
    expect(got).toBeDefined();
  });

  it("getExpiration returns the latest tag timestamp", async () => {
    await handler.updateTags(["a", "b"]);
    const ts = await handler.getExpiration(["a"]);
    expect(ts).toBeGreaterThan(0);
    expect(await handler.getExpiration(["unknown"])).toBe(0);
  });

  it("concurrent get during an in-flight set waits for completion", async () => {
    let resolveSet: (e: CacheEntry) => void = () => {};
    const pending = new Promise<CacheEntry>((resolve) => {
      resolveSet = resolve;
    });
    const setPromise = handler.set("k", pending);
    const getPromise = handler.get("k", []);
    resolveSet(entry({ value: toReadableStream("delayed") }));
    await setPromise;
    const result = await getPromise;
    expect(result).toBeDefined();
    if (!result) return;
    expect((await collectStream(result.value)).toString()).toBe("delayed");
  });
});
