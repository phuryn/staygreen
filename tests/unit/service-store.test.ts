import type pg from "pg";
import { describe, expect, it } from "vitest";
import { Store } from "../../probe/store";
import { fresh, type Located, type Outcome } from "../../probe/state";
import { judgeStripe, type StripeObservation } from "@/checks/stripe";
import { STRIPE_CRITICAL } from "@/lib/service-monitor";

const at = 1_800_000_000;
const config = { endpoints: ["we_one"], critical: STRIPE_CRITICAL, failureThreshold: 3, windowMin: 30, pendingMin: 30 };
const project = "https://abcdefghijklmnopqrst.supabase.co";

// Real Store.apply and reducer; only the lock/commit SQL calls are faked. SQL locking,
// privileges and durable effects have their own local-Postgres integration harness.
function stored(type: "stripe" | "supabase") {
  const row = { id: "mon_service", workspace_id: "ws_test", name: "Service", type,
    target: type === "stripe" ? "https://api.stripe.com" : project, version: "1", paused: false,
    config: { ...(type === "stripe" ? config : { projectUrl: project, databaseRead: "" }) } as Record<string, unknown>,
    state: fresh().state, since: null, outcome_at: null as number | null,
    probe_slow_streak: 0, probe_pass_streak: 0, probe_fail_streak: 0, probe_outcome_locations: [] as string[] };
  const effects: { kind: string; runtime?: unknown }[] = [];
  const client = { release() {}, async query(sql: string, args: unknown[] = []) {
    if (sql.includes("probe_lock_monitor")) return { rows: [structuredClone(row)] };
    if (sql.includes("probe_commit_monitor")) {
      Object.assign(row, { state: args[3], probe_slow_streak: args[4], probe_pass_streak: args[5], probe_fail_streak: args[6],
        outcome_at: Date.parse(String(args[2])) / 1000, probe_outcome_locations: args[7] });
      const writes = JSON.parse(String(args[8])) as typeof effects;
      effects.push(...writes);
      for (const write of writes) if (write.kind === "service_runtime") row.config.__runtime = write.runtime;
    } else if (!["begin", "commit", "rollback"].includes(sql)) throw Error(`Unexpected SQL: ${sql}`);
    return { rows: [] };
  } };
  const store = new Store({ connect: async () => client } as unknown as pg.Pool);
  let clock = at;
  return { row, effects, runtime: () => row.config.__runtime as { seen?: string[]; pausedOrDeleted?: boolean } | undefined,
    apply: (outcome: Outcome) => store.apply({ monitorId: row.id, version: row.version, atSec: clock++, outcome }) };
}

const failed = { id: "evt_original", type: "invoice.paid", created: at - 60, pending: 0 };
const stripe = (events: StripeObservation["events"], location = "tor1", disabled: string[] = []): Located => {
  const observation = { at, events, disabled };
  const result = judgeStripe(config, observation);
  return { ...result, location, detail: { ...result.detail, observation } };
};
const confirmed = (first: Located): Outcome => ({ first, confirm: { ...first, location: "sfo3" } });
const refusal = (status = 401, name = "Auth health", location = "tor1"): Located => ({
  ok: false, ms: 1, status, location, failure: { kind: "status", message: `${name} answered ${status}` },
});
const pass: Located = { ok: true, ms: 1, location: "sfo3" };

describe("Stripe recovery cursor under the store lock", () => {
  it("never handles in-flight or out-of-window ids, and a new terminal failure alerts after recovery", async () => {
    const s = stored("stripe");
    await s.apply(confirmed(stripe([failed])));
    const inFlight = { ...failed, id: "evt_later", pending: 1 };
    const tooOld = { ...failed, id: "evt_old", created: at - 1801 };
    // A disabled endpoint keeps the original incident open while a new delivery is in flight.
    await s.apply(confirmed(stripe([failed, inFlight, tooOld], "tor1", ["we_one"])));
    expect(s.runtime()?.seen).toEqual([failed.id]);
    await s.apply({ first: stripe([failed, inFlight, tooOld]) });
    await s.apply({ first: stripe([failed, inFlight, tooOld], "sfo3") });
    expect(s.row.state).toBe("up");
    expect(s.runtime()?.seen).toEqual([failed.id]);
    // The same formerly in-flight id now fails terminally, still inside the window.
    await s.apply(confirmed(stripe([failed, { ...inFlight, pending: 0 }, tooOld])));
    expect(s.row.state).toBe("down");
    expect(s.effects.filter(e => e.kind === "open_incident")).toHaveLength(2);
    expect(s.runtime()?.seen).toEqual(["evt_later", "evt_original"]);
  });
  it.each(["passing", "missing"])("does not consume a terminal failure while down with a %s confirmation", async confirm => {
    const s = stored("stripe");
    await s.apply(confirmed(stripe([failed])));
    const later = { ...failed, id: "evt_later" };
    await s.apply({ first: stripe([failed, later]), ...(confirm === "passing" ? { confirm: stripe([failed], "sfo3") } : {}) });
    expect(s.runtime()?.seen).toEqual([failed.id]);
    await s.apply(confirmed(stripe([failed, later])));
    expect(s.runtime()?.seen).toEqual(["evt_later", "evt_original"]);
    await s.apply({ first: stripe([failed, later]) });
    await s.apply({ first: stripe([failed, later]) });
    expect(s.row.state).toBe("up");
    expect(s.effects.filter(e => e.kind === "open_incident")).toHaveLength(1);
  });
});

describe("Supabase uses ordinary failure evidence and recovery", () => {
  it.each(["pass", "missing", "timeout", "different read", "different status", "same location"])("records the real response when confirmation is %s", async kind => {
    const s = stored("supabase");
    const first = refusal();
    const confirm = kind === "missing" ? undefined : kind === "pass" ? pass
      : kind === "timeout" ? { ...pass, ok: false, failure: { kind: "timeout" as const, message: "Timed out" } }
      : kind === "different read" ? refusal(401, "Storage status", "sfo3")
      : kind === "different status" ? refusal(403, "Auth health", "sfo3")
      : first;
    await s.apply({ first, ...(confirm ? { confirm } : {}) });
    expect(s.runtime()).toEqual({ pausedOrDeleted: false });
    expect(s.row.state).toBe(kind === "pass" || kind === "missing" ? null : "down");
    expect(s.effects.filter(e => e.kind === "record_failure").length).toBeGreaterThan(0);
  });
  it("recovers from a confirmed refusal without an edit or anything to clear", async () => {
    const s = stored("supabase");
    await s.apply(confirmed(refusal()));
    expect(s.runtime()).toEqual({ pausedOrDeleted: false });
    expect(s.row.state).toBe("down");
    await s.apply({ first: pass });
    expect(s.row.state).toBe("down");
    await s.apply({ first: pass });
    expect(s.row.state).toBe("up");
    await s.apply(confirmed(refusal()));
    expect(s.row.state).toBe("down");
    expect(s.effects.filter(e => e.kind === "open_incident")).toHaveLength(2);
  });
});
