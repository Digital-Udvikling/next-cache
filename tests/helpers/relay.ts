import net from "node:net";

/**
 * TCP relay to Redis that can go down and come back on the same port — a rescheduled Redis pod,
 * which a container restart cannot reproduce (its mapped port changes) — or stall: open
 * connections stay up but silently drop traffic, like a blackholed peer.
 */
export class Relay {
  private server: net.Server | undefined;
  private readonly pairs = new Set<[net.Socket, net.Socket]>();
  private readonly stalled = new WeakSet<net.Socket>();

  constructor(
    readonly port: number,
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  static async create(redisUrl: string): Promise<Relay> {
    const url = new URL(redisUrl);
    return new Relay(await freePort(), url.hostname, Number(url.port));
  }

  get url(): string {
    return `redis://127.0.0.1:${this.port}`;
  }

  async up(): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.connect(this.targetPort, this.targetHost);
      const pair: [net.Socket, net.Socket] = [client, upstream];
      this.pairs.add(pair);
      client.pipe(upstream).pipe(client);
      const drop = (): void => {
        client.destroy();
        upstream.destroy();
        this.pairs.delete(pair);
      };
      client.on("error", drop).on("close", drop);
      upstream.on("error", drop).on("close", drop);
    });
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    this.server = server;
  }

  /** Blackhole every open connection; new connections are relayed normally. */
  stall(): void {
    for (const [client, upstream] of this.pairs) {
      if (this.stalled.has(client)) continue;
      this.stalled.add(client);
      client.unpipe(upstream);
      upstream.unpipe(client);
      // Keep reading so data is discarded rather than buffered for later delivery.
      client.on("data", () => {});
      upstream.on("data", () => {});
    }
  }

  async down(): Promise<void> {
    for (const [client, upstream] of this.pairs) {
      client.destroy();
      upstream.destroy();
    }
    this.pairs.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
