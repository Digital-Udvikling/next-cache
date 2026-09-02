import type { Redis } from "ioredis";
import { resolveConfig } from "./config.js";
import { createClient } from "./redis/client.js";
import { createKeyBuilder, type KeyBuilder } from "./redis/keys.js";
import { TagCoordinator } from "./tags/coordinator.js";
import type { NextCacheOptions, ResolvedConfig } from "./types.js";

export interface Runtime {
  config: ResolvedConfig;
  client: Redis;
  keys: KeyBuilder;
  coordinator: TagCoordinator;
  debug?: (...args: unknown[]) => void;
  close(): Promise<void>;
}

export function createRuntime(options: NextCacheOptions = {}): Runtime {
  const config = resolveConfig(options);
  const debug = config.debug
    ? (...args: unknown[]) => console.debug("[@aortl/next-cache]", ...args)
    : undefined;
  const client = createClient(config.redis, connectionErrorReporter(debug));
  const keys = createKeyBuilder(config.keyPrefix, config.pubsubChannel);
  const coordinator = new TagCoordinator({
    client,
    keys,
    pubsubEnabled: config.pubsubEnabled,
    debug,
  });

  return {
    config,
    client,
    keys,
    coordinator,
    debug,
    async close() {
      await coordinator.close();
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    },
  };
}

const ERROR_WARN_INTERVAL_MS = 60_000;

// Operators must see connection errors without debug on, but ioredis emits one per retry.
function connectionErrorReporter(debug?: (...args: unknown[]) => void): (err: Error) => void {
  let lastWarnedAt = 0;
  return (err) => {
    debug?.("redis error", err);
    const now = Date.now();
    if (now - lastWarnedAt < ERROR_WARN_INTERVAL_MS) return;
    lastWarnedAt = now;
    console.warn(
      `[@aortl/next-cache] redis error: ${err.message} (cache degraded until reconnected)`,
    );
  };
}

let defaultRuntime: Runtime | undefined;

export function getDefaultRuntime(options: NextCacheOptions = {}): Runtime {
  if (!defaultRuntime) {
    defaultRuntime = createRuntime(options);
  }
  return defaultRuntime;
}

export function resetDefaultRuntime(): void {
  defaultRuntime = undefined;
}
