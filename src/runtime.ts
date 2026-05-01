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
  const client = createClient(config.redis);
  const keys = createKeyBuilder(config.keyPrefix, config.pubsubChannel);
  const debug = config.debug
    ? (...args: unknown[]) => console.debug("[@aortl/next-cache]", ...args)
    : undefined;
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
