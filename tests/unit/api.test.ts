import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachCache } from "../../src/cache/api.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import type { ProgrammaticCache } from "../../src/types.js";
import { createMockRedis, flushAll } from "../helpers/redis-mock.js";

describe("programmatic cache", () => {
  let runtime: Runtime;
  let cache: ProgrammaticCache;

  beforeEach(async () => {
    const redis = createMockRedis();
    await flushAll(redis);
    runtime = createRuntime({ redis });
    cache = attachCache(runtime);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("get returns undefined for missing keys", async () => {
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("round-trips a value", async () => {
    await cache.set("k", { hello: "world" });
    expect(await cache.get<{ hello: string }>("k")).toEqual({ hello: "world" });
  });

  it("delete removes a value", async () => {
    await cache.set("k", 1);
    await cache.delete("k");
    expect(await cache.get("k")).toBeUndefined();
  });

  it("getOrSet only invokes the factory once when value is missing", async () => {
    let calls = 0;
    const factory = async () => {
      calls++;
      return "value";
    };
    expect(await cache.getOrSet("k", factory)).toBe("value");
    expect(await cache.getOrSet("k", factory)).toBe("value");
    expect(calls).toBe(1);
  });

  it("getOrSet de-duplicates concurrent factory invocations", async () => {
    let calls = 0;
    const factory = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return "value";
    };
    const [a, b, c] = await Promise.all([
      cache.getOrSet("k", factory),
      cache.getOrSet("k", factory),
      cache.getOrSet("k", factory),
    ]);
    expect([a, b, c]).toEqual(["value", "value", "value"]);
    expect(calls).toBe(1);
  });

  it("invalidateTag voids tagged entries on next get", async () => {
    await cache.set("k", "v", { tags: ["foo"] });
    expect(await cache.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 5));
    await cache.invalidateTag("foo");
    expect(await cache.get("k")).toBeUndefined();
  });

  it("invalidateTag accepts an array", async () => {
    await cache.set("k1", 1, { tags: ["a"] });
    await cache.set("k2", 2, { tags: ["b"] });
    await new Promise((r) => setTimeout(r, 5));
    await cache.invalidateTag(["a", "b"]);
    expect(await cache.get("k1")).toBeUndefined();
    expect(await cache.get("k2")).toBeUndefined();
  });

  it("untagged entries are not affected by tag invalidation", async () => {
    await cache.set("plain", 42);
    await cache.invalidateTag("any-tag");
    expect(await cache.get("plain")).toBe(42);
  });
});
