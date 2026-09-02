import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDefaultHandler } from "../../src/handlers/default.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import type { CacheHandler } from "../../src/types.js";
import { startRedis, type RealRedis } from "../helpers/redis-real.js";

/**
 * TCP relay that can go down and come back on the same port — a rescheduled Redis pod,
 * which a container restart cannot reproduce (its mapped port changes).
 */
class Relay {
  private server: net.Server | undefined;
  private readonly sockets = new Set<net.Socket>();

  constructor(
    readonly port: number,
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  async up(): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      this.sockets.add(client).add(upstream);
      client.pipe(upstream).pipe(client);
      const drop = (): void => {
        client.destroy();
        upstream.destroy();
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on("error", drop).on("close", drop);
      upstream.on("error", drop).on("close", drop);
    });
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    this.server = server;
  }

  async down(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - started };
}

describe("redis outage resilience (integration)", () => {
  let redis: RealRedis;
  let relay: Relay;
  // Talks to Redis directly: the "other pod" whose invalidations must reach us.
  let peer: Runtime;
  let peerHandler: CacheHandler;
  // Talks through the relay: the pod that experiences the outages.
  let runtime: Runtime;
  let handler: CacheHandler;

  beforeAll(async () => {
    redis = await startRedis();
    const url = new URL(redis.url);
    relay = new Relay(await freePort(), url.hostname, Number(url.port));

    peer = createRuntime({ redis: redis.url, keyPrefix: "test-reconnect:" });
    peerHandler = buildDefaultHandler(peer);
    await peerHandler.refreshTags();

    runtime = createRuntime({
      redis: `redis://127.0.0.1:${relay.port}`,
      keyPrefix: "test-reconnect:",
    });
    handler = buildDefaultHandler(runtime);
  });

  afterAll(async () => {
    await runtime.close().catch(() => {});
    await peer.close();
    await relay.down();
    await redis.stop();
  });

  it("boots uncoordinated while Redis is down, then joins once it is back", async () => {
    const miss = await timed(() => handler.get("k", []));
    expect(miss.result).toBeUndefined();
    expect(miss.ms).toBeLessThan(1_500);

    // An invalidation published while we are down must not be lost to us.
    await peerHandler.updateTags(["boot-tag"]);

    await relay.up();
    // Backoff ≤ 2 s; the first call after reconnect completes the init that failed at boot.
    await until(() => (runtime.client.status as string) === "ready");
    await handler.refreshTags();
    expect(runtime.coordinator.manifest.get("boot-tag")).toBeDefined();
  });

  it("fails fast during a mid-life outage and re-syncs missed invalidations after", async () => {
    await relay.down();
    await until(() => (runtime.client.status as string) !== "ready");

    const miss = await timed(() => handler.get("k", []));
    expect(miss.result).toBeUndefined();
    expect(miss.ms).toBeLessThan(1_500);
    // Write path swallows the failure instead of throwing into Next.
    const write = await timed(() => handler.updateTags(["dropped-locally"]));
    expect(write.ms).toBeLessThan(1_500);

    await peerHandler.updateTags(["missed-tag"]);

    await relay.up();
    await until(() => (runtime.client.status as string) === "ready");
    // Either the subscriber's ready re-sync or the refreshTags fallback covers it.
    await until(() => {
      void handler.refreshTags();
      return runtime.coordinator.manifest.get("missed-tag") !== undefined;
    });

    await peerHandler.updateTags(["live-tag"]);
    await until(() => runtime.coordinator.manifest.get("live-tag") !== undefined);
  });
});
