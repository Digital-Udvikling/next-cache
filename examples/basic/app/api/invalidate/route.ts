import { revalidateTag } from "next/cache";
import type { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  const tag = request.nextUrl.searchParams.get("tag");
  if (!tag) {
    return Response.json({ error: "tag query param is required" }, { status: 400 });
  }
  // `{ expire: 0 }` schedules invalidation at "now", which means cache
  // handlers immediately treat any pre-existing tagged entry as expired
  // (per Next 16's `areTagsExpired` semantics: expired <= now AND
  // expired > entry.timestamp). Profile names like "default"/"max" carry a
  // huge expire (~136 years), which is "scheduled but not yet active".
  revalidateTag(tag, { expire: 0 });
  return Response.json({ ok: true, tag, instance: process.env.INSTANCE_ID ?? "?" });
}
