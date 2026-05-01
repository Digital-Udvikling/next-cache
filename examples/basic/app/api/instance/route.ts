export async function GET() {
  return Response.json({ instance: process.env.INSTANCE_ID ?? "?" });
}
