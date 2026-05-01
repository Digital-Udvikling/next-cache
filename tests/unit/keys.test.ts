import { describe, expect, it } from "vitest";
import { createKeyBuilder } from "../../src/redis/keys.js";

describe("createKeyBuilder", () => {
  const keys = createKeyBuilder("nc:", "nc:__pubsub:tags");

  it("namespaces entry keys", () => {
    expect(keys.entry("abc")).toBe("nc:entry:abc");
  });

  it("namespaces kv keys", () => {
    expect(keys.kv("user:42")).toBe("nc:kv:user:42");
  });

  it("returns the tags hash key", () => {
    expect(keys.tagsHash()).toBe("nc:tags");
  });

  it("exposes the pubsub channel", () => {
    expect(keys.pubsubChannel).toBe("nc:__pubsub:tags");
  });
});
