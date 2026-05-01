import { expect, test } from "@playwright/test";
import { bases, eventually, invalidateTag, readSnapshot } from "./_helpers";

test.describe("cross-instance tag invalidation (pub/sub)", () => {
  test("invalidating on A flushes 'use cache' entries on B", async ({ page }) => {
    const { A, B } = bases();

    // Warm both instances' local caches.
    const beforeA = await readSnapshot(page, `${A}/cached`);
    const beforeB = await readSnapshot(page, `${B}/cached`);

    // Invalidate via instance A's API. Pub/sub should propagate to B.
    await invalidateTag(A, "cached-page");

    // B picks the invalidation up on its next request (the framework calls
    // refreshTags() before each request, but pub/sub usually beats the
    // poll, so this should resolve well under the eventually() timeout).
    const afterB = await eventually(
      () => readSnapshot(page, `${B}/cached`),
      (snap) => snap.nonce !== beforeB.nonce,
      5_000,
    );
    expect(afterB.nonce).not.toBe(beforeB.nonce);

    const afterA = await readSnapshot(page, `${A}/cached`);
    expect(afterA.nonce).not.toBe(beforeA.nonce);
  });
});
