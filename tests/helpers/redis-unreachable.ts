import type { Redis } from "ioredis";

const refuse = async (): Promise<never> => {
  throw new Error("connection refused");
};

/**
 * A caller-supplied client whose every command fails, as if Redis were down. It never emits
 * "error", so the runtime's connection-error reporter stays silent.
 */
export function createUnreachableRedis(): Redis {
  const client = {
    status: "wait",
    connect: refuse,
    get: refuse,
    getBuffer: refuse,
    set: refuse,
    setBuffer: refuse,
    hscan: refuse,
    pipeline: () => ({ hset: () => {}, publish: () => {}, exec: refuse }),
    duplicate: () => client,
    on: () => client,
    once: () => client,
    off: () => client,
    subscribe: refuse,
    quit: async () => "OK",
    disconnect: () => {},
  };
  return client as unknown as Redis;
}
