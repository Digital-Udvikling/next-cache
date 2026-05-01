import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const exampleDir = path.join(repoRoot, "examples", "basic");

export interface E2EState {
  redis: StartedRedisContainer;
  redisUrl: string;
  servers: { port: number; instanceId: string; proc: ChildProcess }[];
  baseUrls: { A: string; B: string };
  logDir: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __E2E__: E2EState | undefined;
}

async function waitForUrl(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status === 404 || res.status === 405) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(
    `Timed out waiting for ${url} after ${timeoutMs}ms (last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
  );
}

function startNext(opts: {
  port: number;
  instanceId: string;
  redisUrl: string;
  logFile: string;
}): ChildProcess {
  const nextBin = path.join(exampleDir, "node_modules", "next", "dist", "bin", "next");
  const proc = spawn(process.execPath, [nextBin, "start", "-p", String(opts.port)], {
    cwd: exampleDir,
    env: {
      ...process.env,
      REDIS_URL: opts.redisUrl,
      INSTANCE_ID: opts.instanceId,
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PRIVATE_DEBUG_CACHE: "1",
      PORT: String(opts.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  void import("node:fs").then(({ createWriteStream }) => {
    const stream = createWriteStream(opts.logFile, { flags: "a" });
    proc.stdout?.pipe(stream);
    proc.stderr?.pipe(stream);
  });
  return proc;
}

export default async function globalSetup(): Promise<void> {
  const logDir = await mkdtemp(path.join(tmpdir(), "next-cache-e2e-"));
  console.log(`[e2e] logs at ${logDir}`);

  console.log("[e2e] starting redis container…");
  const redis = await new RedisContainer("redis:7-alpine").start();
  const redisUrl = redis.getConnectionUrl();
  console.log(`[e2e] redis ready at ${redisUrl}`);

  const portA = 3091;
  const portB = 3092;

  console.log("[e2e] starting next instance A…");
  const procA = startNext({
    port: portA,
    instanceId: "A",
    redisUrl,
    logFile: path.join(logDir, "next-A.log"),
  });
  console.log("[e2e] starting next instance B…");
  const procB = startNext({
    port: portB,
    instanceId: "B",
    redisUrl,
    logFile: path.join(logDir, "next-B.log"),
  });

  try {
    await Promise.all([
      waitForUrl(`http://localhost:${portA}/api/instance`),
      waitForUrl(`http://localhost:${portB}/api/instance`),
    ]);
  } catch (err) {
    procA.kill("SIGTERM");
    procB.kill("SIGTERM");
    await redis.stop();
    throw err;
  }
  console.log("[e2e] both next instances ready");

  const state: E2EState = {
    redis,
    redisUrl,
    servers: [
      { port: portA, instanceId: "A", proc: procA },
      { port: portB, instanceId: "B", proc: procB },
    ],
    baseUrls: {
      A: `http://localhost:${portA}`,
      B: `http://localhost:${portB}`,
    },
    logDir,
  };
  globalThis.__E2E__ = state;

  await writeFile(
    path.join(logDir, "state.json"),
    JSON.stringify({ redisUrl, baseUrls: state.baseUrls, logDir }, null, 2),
  );

  // Persist for tests via env so other workers (if any) see them too.
  process.env.E2E_BASE_URL_A = state.baseUrls.A;
  process.env.E2E_BASE_URL_B = state.baseUrls.B;
  process.env.E2E_REDIS_URL = redisUrl;
}
