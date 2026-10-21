export async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - started };
}
