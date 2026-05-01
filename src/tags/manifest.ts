import type { TagManifestEntry } from "../types.js";

export class TagManifest {
  private readonly map = new Map<string, TagManifestEntry>();

  get(tag: string): TagManifestEntry | undefined {
    return this.map.get(tag);
  }

  set(tag: string, entry: TagManifestEntry): void {
    const existing = this.map.get(tag);
    if (existing && existing.stale >= entry.stale && existing.expired >= entry.expired) {
      return;
    }
    this.map.set(tag, {
      stale: Math.max(existing?.stale ?? 0, entry.stale),
      expired: Math.max(existing?.expired ?? 0, entry.expired),
    });
  }

  replace(entries: Iterable<[string, TagManifestEntry]>): void {
    this.map.clear();
    for (const [tag, entry] of entries) {
      this.map.set(tag, entry);
    }
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
