import "server-only";
import { db } from "./db";
import { limits, type PlanId } from "./plans";

/** Synchronize a verified plan. Callers exclude development simulations and unread plans. */
export async function syncWorkspacePlan(workspaceId: string, stored: string, next: PlanId): Promise<void> {
  if (stored === next) return;
  if (next === "builder") {
    // Only HTTP, TCP and Supabase move. DNS and SSL are fixed and heartbeats follow cron. Stripe
    // and MCP stay too: history reads multiply stored windows by the live interval, floored at
    // 300 s, so their move from 600 s to 300 s would halve every past day's coverage and rewrite
    // their uptime, public pages included (review s49b); HTTP's 180 s and 60 s both read as 300 s.
    // The exact old-value predicate preserves other choices, including an edit racing this update.
    const { error } = await db().from("monitors").update({ interval_sec: limits.builder.httpIntervalMin * 60 })
      .eq("workspace_id", workspaceId).in("type", ["http", "tcp", "supabase"]).eq("interval_sec", limits.free.httpIntervalMin * 60);
    // Keep the old plan until the interval write succeeds, so the next request retries.
    if (error) return;
  }
  // Downgrades only change probe eligibility; slowing monitors remains deferred in BACKLOG.
  await db().from("workspaces").update({ plan: next }).eq("id", workspaceId).eq("plan", stored);
}
