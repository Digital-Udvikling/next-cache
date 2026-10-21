import type { Redis } from "ioredis";

const refuse = async (): Promise<never> => {
  throw new Error("connection refused");
};

/** A caller-supplied client that never emits "error", so the connection-error reporter stays silent. */
function fakeClient(connect: () => Promise<never>, commands: Record<string, unknown> = {}): Redis {
  const client = {
    status: "wait",
    connect,
    ...commands,
    pipeline: () => ({ hset: () => {}, publish: () => {}, exec: refuse }),
    duplicate: () => client,
    on: () => client,
    once: () => client,
    off: () => client,
    quit: async () => "OK",
    disconnect: () => {},
  };
  return client as unknown as Redis;
}

/** A client whose every command fails, as if Redis were down. */
export function createUnreachableRedis(): Redis {
  return fakeClient(refuse, {
    get: refuse,
    getBuffer: refuse,
    set: refuse,
    hscan: refuse,
    subscribe: refuse,
  });
}

/** A client whose connection attempt never settles, as with a blackholed Redis. */
export function createHangingRedis(): Redis {
  const client = fakeClient(() => {
    (client as unknown as { status: string }).status = "connecting";
    return new Promise<never>(() => {});
  });
  return client;
}
