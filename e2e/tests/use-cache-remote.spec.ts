import { expect, test } from "@playwright/test";
import { bases, invalidateTag, readSnapshot } from "./_helpers";

test.describe("'use cache: remote' (remote handler)", () => {
  test("repeated requests on the same instance return cached values", async ({ page }) => {
    const { A } = bases();
    const first = await readSnapshot(page, `${A}/cached-remote`);
    const second = await readSnapshot(page, `${A}/cached-remote`);
    expect(second.nonce).toBe(first.nonce);
    expect(second.ts).toBe(first.ts);
  });

  test("the remote cache is shared between instances", async ({ page }) => {
    const { A, B } = bases();
    const onA = await readSnapshot(page, `${A}/cached-remote`);
    const onB = await readSnapshot(page, `${B}/cached-remote`);
    expect(onA.instance).toBe("A");
    expect(onB.instance).toBe("B");
    // Remote cache is in Redis, so both instances must see the same payload.
    expect(onB.nonce).toBe(onA.nonce);
    expect(onB.ts).toBe(onA.ts);
  });

  test("revalidateTag invalidates the shared remote cache", async ({ page }) => {
    const { A, B } = bases();
    const before = await readSnapshot(page, `${A}/cached-remote`);
    await readSnapshot(page, `${B}/cached-remote`); // warm B too
    await invalidateTag(A, "cached-remote-page");
    const afterA = await readSnapshot(page, `${A}/cached-remote`);
    const afterB = await readSnapshot(page, `${B}/cached-remote`);
    expect(afterA.nonce).not.toBe(before.nonce);
    expect(afterB.nonce).toBe(afterA.nonce);
  });
});
