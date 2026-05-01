import { expect, test } from "@playwright/test";
import { bases } from "./_helpers";

async function kvGet(baseUrl: string, key: string): Promise<unknown> {
  const res = await fetch(`${baseUrl}/api/kv?key=${encodeURIComponent(key)}`);
  expect(res.ok).toBeTruthy();
  const body = (await res.json()) as { value: unknown };
  return body.value;
}

async function kvSet(
  baseUrl: string,
  key: string,
  value: unknown,
  opts: { tags?: string[]; ttl?: number } = {},
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/kv?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value, ...opts }),
  });
  expect(res.ok).toBeTruthy();
}

async function kvDelete(baseUrl: string, key: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/kv?key=${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
  expect(res.ok).toBeTruthy();
}

async function kvInvalidateTag(baseUrl: string, tag: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/kv/invalidate?tag=${encodeURIComponent(tag)}`, {
    method: "POST",
  });
  expect(res.ok).toBeTruthy();
}

test.describe("programmatic cache API", () => {
  test("set + get round-trips a value across instances (shared Redis)", async () => {
    const { A, B } = bases();
    const key = `e2e-kv-${Date.now()}`;
    await kvSet(A, key, { hello: "world" });
    expect(await kvGet(A, key)).toEqual({ hello: "world" });
    expect(await kvGet(B, key)).toEqual({ hello: "world" });
  });

  test("delete removes the value", async () => {
    const { A } = bases();
    const key = `e2e-kv-del-${Date.now()}`;
    await kvSet(A, key, "v");
    expect(await kvGet(A, key)).toBe("v");
    await kvDelete(A, key);
    expect(await kvGet(A, key)).toBeNull();
  });

  test("invalidateTag voids tagged entries", async () => {
    const { A, B } = bases();
    const key = `e2e-kv-tag-${Date.now()}`;
    await kvSet(A, key, "tagged-value", { tags: ["e2e-tag"] });
    expect(await kvGet(A, key)).toBe("tagged-value");
    await kvInvalidateTag(B, "e2e-tag");
    expect(await kvGet(A, key)).toBeNull();
  });
});
