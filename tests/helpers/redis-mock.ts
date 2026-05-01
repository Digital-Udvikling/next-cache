import IORedisMock from "ioredis-mock";
import type { Redis } from "ioredis";

export function createMockRedis(): Redis {
  const client = new IORedisMock({ data: {} }) as unknown as Redis;
  return client;
}

export async function flushAll(client: Redis): Promise<void> {
  await client.flushall();
}
