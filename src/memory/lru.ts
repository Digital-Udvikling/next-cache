export interface LruOptions<V> {
  maxItems: number;
  maxBytes: number;
  sizeOf?: (value: V) => number;
}

export class LruCache<V> {
  private readonly map = new Map<string, V>();
  private readonly sizes = new Map<string, number>();
  private totalBytes = 0;

  constructor(private readonly opts: LruOptions<V>) {}

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    const prevSize = this.sizes.get(key);
    if (prevSize !== undefined) {
      this.totalBytes -= prevSize;
      this.map.delete(key);
      this.sizes.delete(key);
    }

    const size = this.opts.sizeOf?.(value) ?? 0;
    this.map.set(key, value);
    this.sizes.set(key, size);
    this.totalBytes += size;

    this.evict();
  }

  delete(key: string): void {
    const size = this.sizes.get(key);
    if (size !== undefined) this.totalBytes -= size;
    this.map.delete(key);
    this.sizes.delete(key);
  }

  clear(): void {
    this.map.clear();
    this.sizes.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  *entries(): IterableIterator<[string, V]> {
    yield* this.map.entries();
  }

  private evict(): void {
    while (
      this.map.size > 0 &&
      (this.map.size > this.opts.maxItems || this.totalBytes > this.opts.maxBytes)
    ) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }
}
