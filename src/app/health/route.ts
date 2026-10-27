import { db } from "@/lib/db";

// The uptime monitor's target (`AGENTS.md § 1.3`): 200 with the database reachable, 503 when
// it is not. It runs one count and says nothing about what is stored, not even the count.
export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    const { error } = await db().from("workspaces").select("id", { count: "exact", head: true });
    if (error) throw error;
    return Response.json({ ok: true, database: "reachable", ms: Date.now() - started }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false, database: "unreachable", ms: Date.now() - started }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
