import type { IncrementalCacheHandler } from "../../src/handlers/incremental.js";

/** Stands in for FileSystemCache without touching Next's process-global tags manifest. */
export class NoopIncrementalBase implements IncrementalCacheHandler {
  async get() {
    return null;
  }

  async revalidateTag() {}
}
