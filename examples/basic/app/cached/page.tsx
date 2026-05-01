import { Suspense } from "react";
import { cacheTag } from "next/cache";
import { connection } from "next/server";

async function getCachedData(): Promise<{ ts: number; nonce: string }> {
  "use cache";
  cacheTag("cached-page");
  return {
    ts: Date.now(),
    nonce: Math.random().toString(36).slice(2, 10),
  };
}

async function CachedContent() {
  // Defer to request time so per-request env (INSTANCE_ID) is read at runtime
  // and each instance independently goes through its in-memory 'use cache'
  // store.
  await connection();
  const data = await getCachedData();
  return (
    <>
      <p>
        Cached timestamp: <span data-testid="ts">{data.ts}</span>
      </p>
      <p>
        Cached nonce: <span data-testid="nonce">{data.nonce}</span>
      </p>
      <p>
        Instance: <span data-testid="instance">{process.env.INSTANCE_ID ?? "?"}</span>
      </p>
    </>
  );
}

export default function CachedPage() {
  return (
    <main>
      <h1>'use cache' page</h1>
      <Suspense fallback={<p data-testid="loading">Loading…</p>}>
        <CachedContent />
      </Suspense>
    </main>
  );
}
