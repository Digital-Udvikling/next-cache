import { Redis, type RedisOptions } from "ioredis";
import type { RedisInput } from "../types.js";

export function createClient(input: RedisInput): Redis {
  if (isRedisInstance(input)) return input;
  if (typeof input === "string") return new Redis(input, { lazyConnect: true });
  return new Redis({ ...(input as RedisOptions), lazyConnect: true });
}

export function duplicateForPubsub(client: Redis): Redis {
  return client.duplicate({ lazyConnect: true });
}

function isRedisInstance(input: RedisInput): input is Redis {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as Redis).pipeline === "function" &&
    typeof (input as Redis).duplicate === "function"
  );
}

export async function ensureConnected(client: Redis): Promise<void> {
  if (isReady(client)) return;
  try {
    await client.connect();
  } catch (err) {
    if (isReady(client)) return;
    if (err instanceof Error && /already (connect|connecting)/i.test(err.message)) {
      return;
    }
    throw err;
  }
}

function isReady(client: Redis): boolean {
  return (client.status as string) === "ready";
}
