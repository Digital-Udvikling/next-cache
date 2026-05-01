import { type Page, expect } from "@playwright/test";

export function bases(): { A: string; B: string } {
  const A = process.env.E2E_BASE_URL_A;
  const B = process.env.E2E_BASE_URL_B;
  if (!A || !B) throw new Error("E2E_BASE_URL_A/B not set");
  return { A, B };
}

export interface PageSnapshot {
  ts: string;
  nonce: string;
  instance: string;
}

export async function readSnapshot(page: Page, url: string): Promise<PageSnapshot> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const ts = await page.getByTestId("ts").textContent();
  const nonce = await page.getByTestId("nonce").textContent();
  const instance = await page.getByTestId("instance").textContent();
  expect(ts, `ts on ${url}`).toBeTruthy();
  expect(nonce, `nonce on ${url}`).toBeTruthy();
  expect(instance, `instance on ${url}`).toBeTruthy();
  return { ts: ts!, nonce: nonce!, instance: instance! };
}

export async function invalidateTag(baseUrl: string, tag: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/invalidate?tag=${encodeURIComponent(tag)}`, {
    method: "POST",
  });
  expect(res.ok, `invalidate POST returned ${res.status}`).toBeTruthy();
}

export async function eventually<T>(
  fn: () => Promise<T>,
  predicate: (val: T) => boolean,
  timeoutMs = 5_000,
  intervalMs = 100,
): Promise<T> {
  const start = Date.now();
  let last: T;
  // run at least once
  do {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() - start < timeoutMs);
  throw new Error(
    `eventually() timed out after ${timeoutMs}ms; last value: ${JSON.stringify(last!)}`,
  );
}
