import type { TagManifestEntry } from "../types.js";

/** Receives each entry the manifest stores. */
export type TagManifestListener = (tag: string, entry: TagManifestEntry) => void;

export class TagManifest {
  private readonly map = new Map<string, TagManifestEntry>();
  private readonly listeners = new Set<TagManifestListener>();

  get(tag: string): TagManifestEntry | undefined {
    return this.map.get(tag);
  }

  /**
   * Store `entry` unless the tag holds a newer one. `stale` is the write time, so the latest
   * invalidation wins whole: a hard update after a soft one pulls `expired` back in. On a tie
   * the incoming entry wins.
   */
  set(tag: string, entry: TagManifestEntry): void {
    const existing = this.map.get(tag);
    if (existing && existing.stale > entry.stale) return;
    if (existing && existing.stale === entry.stale && existing.expired === entry.expired) return;
    this.map.set(tag, entry);
    for (const listener of this.listeners) listener(tag, entry);
  }

  /**
   * Call `listener` with every stored entry now and with each one `set` stores later.
   * Adding a listener that is already subscribed does nothing.
   */
  addListener(listener: TagManifestListener): void {
    if (this.listeners.has(listener)) return;
    this.listeners.add(listener);
    for (const [tag, entry] of this.map) listener(tag, entry);
  }

  entries(): IterableIterator<[string, TagManifestEntry]> {
    return this.map.entries();
  }

  size(): number {
    return this.map.size;
  }

  // Mirrors Next.js's `areTagsExpired` semantics: a tag is "expired" only
  // once its scheduled expiration has passed (expired <= now) AND the entry
  // predates that scheduled expiration (expired > timestamp). This means
  // `updateTags(tags, { expire: N })` schedules invalidation N seconds in
  // the future — entries created before that future moment are invalidated
  // once we cross it. For immediate invalidation, callers pass
  // `{ expire: 0 }` (or no durations).
  areTagsExpired(tags: string[], timestamp: number, now: number = Date.now()): boolean {
    for (const tag of tags) {
      const entry = this.map.get(tag);
      if (entry && entry.expired <= now && entry.expired > timestamp) return true;
    }
    return false;
  }

  areTagsStale(tags: string[], timestamp: number, now: number = Date.now()): boolean {
    for (const tag of tags) {
      const entry = this.map.get(tag);
      if (entry && entry.stale <= now && entry.stale > timestamp) return true;
    }
    return false;
  }

  maxExpired(tags: string[]): number {
    let max = 0;
    for (const tag of tags) {
      const entry = this.map.get(tag);
      if (entry && entry.expired > max) max = entry.expired;
    }
    return max;
  }
}
