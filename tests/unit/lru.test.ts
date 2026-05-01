import { describe, expect, it } from "vitest";
import { LruCache } from "../../src/memory/lru.js";

describe("LruCache", () => {
  it("evicts when item count exceeds maxItems", () => {
    const lru = new LruCache<number>({
      maxItems: 2,
      maxBytes: Number.POSITIVE_INFINITY,
      sizeOf: () => 0,
    });
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
  });

  it("evicts when total bytes exceed maxBytes", () => {
    const lru = new LruCache<{ size: number }>({
      maxItems: Number.POSITIVE_INFINITY,
      maxBytes: 10,
      sizeOf: (v) => v.size,
    });
    lru.set("a", { size: 5 });
    lru.set("b", { size: 5 });
    expect(lru.bytes).toBe(10);
    lru.set("c", { size: 5 });
    expect(lru.bytes).toBe(10);
    expect(lru.get("a")).toBeUndefined();
  });

  it("recently used entries are kept on access", () => {
    const lru = new LruCache<number>({
      maxItems: 2,
      maxBytes: Number.POSITIVE_INFINITY,
      sizeOf: () => 0,
    });
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    lru.set("c", 3);
    expect(lru.get("a")).toBe(1);
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("c")).toBe(3);
  });

  it("delete removes the entry and updates byte count", () => {
    const lru = new LruCache<{ size: number }>({
      maxItems: 10,
      maxBytes: 100,
      sizeOf: (v) => v.size,
    });
    lru.set("a", { size: 30 });
    expect(lru.bytes).toBe(30);
    lru.delete("a");
    expect(lru.bytes).toBe(0);
    expect(lru.get("a")).toBeUndefined();
  });

  it("re-set updates size correctly", () => {
    const lru = new LruCache<{ size: number }>({
      maxItems: 10,
      maxBytes: 100,
      sizeOf: (v) => v.size,
    });
    lru.set("a", { size: 10 });
    lru.set("a", { size: 30 });
    expect(lru.bytes).toBe(30);
  });
});
