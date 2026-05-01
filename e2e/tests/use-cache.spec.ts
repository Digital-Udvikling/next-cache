import { expect, test } from "@playwright/test";
import { bases, invalidateTag, readSnapshot } from "./_helpers";

test.describe("'use cache' (default handler)", () => {
  test("repeated requests on the same instance return cached values", async ({ page }) => {
    const { A } = bases();
    const first = await readSnapshot(page, `${A}/cached`);
    const second = await readSnapshot(page, `${A}/cached`);
    expect(second.nonce).toBe(first.nonce);
    expect(second.ts).toBe(first.ts);
    expect(second.instance).toBe("A");
  });

  test("revalidateTag busts the local cache", async ({ page }) => {
    const { A } = bases();
    const before = await readSnapshot(page, `${A}/cached`);
    await invalidateTag(A, "cached-page");
    const after = await readSnapshot(page, `${A}/cached`);
    expect(after.nonce).not.toBe(before.nonce);
  });

  test("storage is per-instance — A and B can have independent cached values", async ({ page }) => {
    const { A, B } = bases();
    const onA = await readSnapshot(page, `${A}/cached`);
    const onB = await readSnapshot(page, `${B}/cached`);
    expect(onA.instance).toBe("A");
    expect(onB.instance).toBe("B");
    // Default handler stores entries in-memory per instance, so the two instances
    // produce independent cache entries with distinct nonces.
    expect(onB.nonce).not.toBe(onA.nonce);
  });
});
