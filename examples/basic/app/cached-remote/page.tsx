import { Suspense } from "react";
import { cacheTag } from "next/cache";
import { connection } from "next/server";

async function getRemoteCachedData(): Promise<{ ts: number; nonce: string }> {
  "use cache: remote";
  cacheTag("cached-remote-page");
  return {
    ts: Date.now(),
    nonce: Math.random().toString(36).slice(2, 10),
  };
}

async function RemoteContent() {
  // Defer to request time so the remote cache lookup runs per request.
  await connection();
  const data = await getRemoteCachedData();
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

export default function CachedRemotePage() {
  return (
    <main>
      <h1>'use cache: remote' page</h1>
      <Suspense fallback={<p data-testid="loading">Loading…</p>}>
        <RemoteContent />
      </Suspense>
    </main>
  );
}
