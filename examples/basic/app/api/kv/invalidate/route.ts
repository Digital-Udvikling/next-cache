import { createCache } from "@aortl/next-cache";
import type { NextRequest } from "next/server";

const cache = createCache();

export async function POST(request: NextRequest) {
  const tag = request.nextUrl.searchParams.get("tag");
  if (!tag) {
    return Response.json({ error: "tag required" }, { status: 400 });
  }
  await cache.invalidateTag(tag);
  return Response.json({ ok: true, tag });
}
