import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { Redis } from "ioredis";

export interface RealRedis {
  container: StartedRedisContainer;
  url: string;
  newClient(): Redis;
  stop(): Promise<void>;
}

export async function startRedis(): Promise<RealRedis> {
  const container = await new RedisContainer("redis:7-alpine").start();
  const url = container.getConnectionUrl();

  const clients: Redis[] = [];
  return {
    container,
    url,
    newClient() {
      const client = new Redis(url, { lazyConnect: true });
      clients.push(client);
      return client;
    },
    async stop() {
      await Promise.all(
        clients.map(async (c) => {
          try {
            await c.quit();
          } catch {
            c.disconnect();
          }
        }),
      );
      await container.stop();
    },
  };
}
