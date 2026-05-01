export interface KeyBuilder {
  entry(key: string): string;
  kv(key: string): string;
  tagsHash(): string;
  pubsubChannel: string;
}

export function createKeyBuilder(prefix: string, pubsubChannel: string): KeyBuilder {
  return {
    entry: (key) => `${prefix}entry:${key}`,
    kv: (key) => `${prefix}kv:${key}`,
    tagsHash: () => `${prefix}tags`,
    pubsubChannel,
  };
}
