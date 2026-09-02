import { Redis, type RedisOptions } from "ioredis";
import type { RedisInput } from "../types.js";

/** Thrown when Redis is not reachable right now and ioredis is already reconnecting. */
export class RedisNotReadyError extends Error {
  constructor(status: string) {
    super(`Redis is not ready (status: ${status})`);
    this.name = "RedisNotReadyError";
  }
}

// No offline queue: a command issued while disconnected would otherwise block until
// ioredis reconnects or gives up (~20 retries), stalling the request.
const OWN_CLIENT_OPTIONS: RedisOptions = {
  enableOfflineQueue: false,
};

/**
 * Client for a URL or options, or the caller's instance untouched. Own clients are lazy,
 * fail fast while disconnected, and route errors to `onError` (ioredis logs each unhandled one).
 */
export function createClient(input: RedisInput, onError?: (err: Error) => void): Redis {
  if (isRedisInstance(input)) return input;
  const client =
    typeof input === "string"
      ? new Redis(input, { ...OWN_CLIENT_OPTIONS, lazyConnect: true })
      : new Redis({ ...OWN_CLIENT_OPTIONS, ...(input as RedisOptions), lazyConnect: true });
  client.on("error", (err: Error) => onError?.(err));
  return client;
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

/**
 * Resolve once `client` can take commands: connects a lazy or ended client, joins an attempt
 * in flight, rejects with `RedisNotReadyError` between ioredis's own retries. Never connect()
 * during that retry cycle — its timer does too, and each extra call opens a competing socket.
 */
export async function ensureConnected(client: Redis): Promise<void> {
  switch (client.status as string | undefined) {
    case "ready":
      return;
    case "connecting":
    case "connect":
      await waitForReady(client);
      return;
    case "close":
    case "reconnecting":
      // ioredis is retrying on its own; degrade now rather than wait out the delay.
      throw new RedisNotReadyError(client.status);
    default:
      // "wait", "end", or a duck-typed client without a status field.
      break;
  }
  try {
    await client.connect();
  } catch (err) {
    if (isReady(client)) return;
    if (err instanceof Error && /already (connect|connecting)/i.test(err.message)) {
      // A client that tracks no status (ioredis-mock) is always usable.
      if (client.status === undefined) return;
      // Lost the race to another connect(); join it.
      await waitForReady(client);
      return;
    }
    throw err;
  }
}

function waitForReady(client: Redis): Promise<void> {
  if (isReady(client)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      client.off("ready", onReady);
      client.off("close", onClose);
      client.off("end", onClose);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };
    // "close" precedes the retry, so a failed attempt rejects without waiting out the delay.
    const onClose = (): void => {
      cleanup();
      reject(new RedisNotReadyError(client.status));
    };
    client.once("ready", onReady);
    client.once("close", onClose);
    client.once("end", onClose);
  });
}

function isReady(client: Redis): boolean {
  return (client.status as string) === "ready";
}
