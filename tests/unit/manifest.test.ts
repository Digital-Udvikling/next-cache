import { describe, expect, it } from "vitest";
import { TagManifest } from "../../src/tags/manifest.js";

describe("TagManifest", () => {
  it("stores and retrieves entries", () => {
    const m = new TagManifest();
    m.set("a", { stale: 10, expired: 20 });
    expect(m.get("a")).toEqual({ stale: 10, expired: 20 });
  });

  it("merges entries by taking the max timestamps", () => {
    const m = new TagManifest();
    m.set("a", { stale: 10, expired: 20 });
    m.set("a", { stale: 5, expired: 25 });
    expect(m.get("a")).toEqual({ stale: 10, expired: 25 });
  });

  it("areTagsExpired requires expired <= now AND expired > timestamp (Next.js parity)", () => {
    const m = new TagManifest();
    m.set("a", { stale: 0, expired: 100 });
    // expired=100 has already passed (now=200) and entry was created earlier
    expect(m.areTagsExpired(["a"], 50, 200)).toBe(true);
    // entry created at the moment of expiration: not expired
    expect(m.areTagsExpired(["a"], 100, 200)).toBe(false);
    // entry created after expiration: not expired
    expect(m.areTagsExpired(["a"], 150, 200)).toBe(false);
    // expiration is scheduled in the future: not yet active
    expect(m.areTagsExpired(["a"], 50, 50)).toBe(false);
  });

  it("areTagsStale requires stale <= now AND stale > timestamp", () => {
    const m = new TagManifest();
    m.set("a", { stale: 100, expired: 0 });
    expect(m.areTagsStale(["a"], 50, 200)).toBe(true);
    expect(m.areTagsStale(["a"], 100, 200)).toBe(false);
    expect(m.areTagsStale(["a"], 50, 50)).toBe(false);
  });

  it("returns false for unknown tags", () => {
    const m = new TagManifest();
    expect(m.areTagsExpired(["unknown"], 0)).toBe(false);
    expect(m.areTagsStale(["unknown"], 0)).toBe(false);
  });

  it("maxExpired returns the largest expired timestamp", () => {
    const m = new TagManifest();
    m.set("a", { stale: 0, expired: 50 });
    m.set("b", { stale: 0, expired: 200 });
    m.set("c", { stale: 0, expired: 100 });
    expect(m.maxExpired(["a", "b", "c"])).toBe(200);
    expect(m.maxExpired(["unknown"])).toBe(0);
    expect(m.maxExpired([])).toBe(0);
  });

  it("replace clears prior state", () => {
    const m = new TagManifest();
    m.set("a", { stale: 10, expired: 20 });
    m.replace([["b", { stale: 5, expired: 5 }]]);
    expect(m.get("a")).toBeUndefined();
    expect(m.get("b")).toEqual({ stale: 5, expired: 5 });
  });
});
