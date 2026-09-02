import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Redis } from "ioredis";
import { RedisNotReadyError, ensureConnected } from "../../src/redis/client.js";

/** Just enough of ioredis's surface for ensureConnected: a status and a connect(). */
class FakeClient extends EventEmitter {
  status: string;
  connect = vi.fn(async (): Promise<void> => {
    this.status = "ready";
  });

  constructor(status: string) {
    super();
    this.status = status;
  }
}

const asRedis = (c: FakeClient): Redis => c as unknown as Redis;

describe("ensureConnected", () => {
  it("is a no-op when already ready", async () => {
    const client = new FakeClient("ready");
    await ensureConnected(asRedis(client));
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("connects a lazy (never connected) client", async () => {
    const client = new FakeClient("wait");
    await ensureConnected(asRedis(client));
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it("reconnects a client ioredis has given up on", async () => {
    const client = new FakeClient("end");
    await ensureConnected(asRedis(client));
    expect(client.connect).toHaveBeenCalledTimes(1);
  });

  it.each(["reconnecting", "close"])(
    "fails fast without calling connect() while ioredis is retrying (%s)",
    async (status) => {
      const client = new FakeClient(status);
      const started = Date.now();
      await expect(ensureConnected(asRedis(client))).rejects.toBeInstanceOf(RedisNotReadyError);
      expect(Date.now() - started).toBeLessThan(100);
      expect(client.connect).not.toHaveBeenCalled();
    },
  );

  it("joins an in-flight connection attempt and resolves on ready", async () => {
    const client = new FakeClient("connecting");
    const pending = ensureConnected(asRedis(client));
    client.status = "ready";
    client.emit("ready");
    await expect(pending).resolves.toBeUndefined();
    expect(client.connect).not.toHaveBeenCalled();
  });

  it("rejects when the in-flight attempt closes before becoming ready", async () => {
    const client = new FakeClient("connecting");
    const pending = ensureConnected(asRedis(client));
    client.status = "close";
    client.emit("close");
    await expect(pending).rejects.toBeInstanceOf(RedisNotReadyError);
  });

  it("waits for ready when connect() reports another caller got there first", async () => {
    const client = new FakeClient("wait");
    client.connect = vi.fn(async () => {
      client.status = "connecting";
      throw new Error("Redis is already connecting/connected");
    });
    const pending = ensureConnected(asRedis(client));
    await Promise.resolve();
    client.status = "ready";
    client.emit("ready");
    await expect(pending).resolves.toBeUndefined();
  });

  it("propagates a genuine connect() failure", async () => {
    const client = new FakeClient("wait");
    client.connect = vi.fn(async () => {
      client.status = "reconnecting";
      throw new Error("Connection is closed.");
    });
    await expect(ensureConnected(asRedis(client))).rejects.toThrow("Connection is closed.");
  });
});
