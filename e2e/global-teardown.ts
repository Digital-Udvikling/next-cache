import { setTimeout as sleep } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";

async function killProc(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  for (let i = 0; i < 20; i++) {
    if (proc.exitCode !== null) return;
    await sleep(100);
  }
  proc.kill("SIGKILL");
}

export default async function globalTeardown(): Promise<void> {
  const state = globalThis.__E2E__;
  if (!state) return;
  console.log("[e2e] tearing down next instances…");
  await Promise.all(state.servers.map((s) => killProc(s.proc)));
  console.log("[e2e] stopping redis container…");
  await state.redis.stop();
  globalThis.__E2E__ = undefined;
}
