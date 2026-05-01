import { createCache } from "@aortl/next-cache";
import type { NextRequest } from "next/server";

const cache = createCache();

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return Response.json({ error: "key required" }, { status: 400 });
  }
  const value = await cache.get(key);
  // Normalize undefined → null so the JSON wire format is stable.
  return Response.json({
    key,
    value: value ?? null,
    instance: process.env.INSTANCE_ID ?? "?",
  });
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return Response.json({ error: "key required" }, { status: 400 });
  }
  const body = (await request.json()) as {
    value: unknown;
    tags?: string[];
    ttl?: number;
  };
  await cache.set(key, body.value, { tags: body.tags, ttl: body.ttl });
  return Response.json({ ok: true, key });
}

export async function DELETE(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key");
  if (!key) {
    return Response.json({ error: "key required" }, { status: 400 });
  }
  await cache.delete(key);
  return Response.json({ ok: true, key });
}
