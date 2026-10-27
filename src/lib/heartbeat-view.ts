import { judgeAll, type Assertion } from "@/checks/assertions";
import type { AssertionResult } from "@/checks/types";
import { expectedAfter, runOf } from "./cron";
import type { PingKind } from "./model";

/* What a heartbeat's screens say about what arrived (`spec.md § 3.3`): read from the receiver's
   row (`heartbeat_latest`, migration 019) and the monitor's own. Pure, so the unit suite pins it
   (`tests/unit/heartbeat-view.test.ts`).

   The probe judges; this only describes. The two agree because they share their parts: the next
   expected run comes from `expectedAfter` and `runOf` in `cron.ts`, which the home's deadlines
   are built on (`probe/heartbeat.ts`), from the same cursor (the last scheduled run the home
   accounted for, then each finish it hasn't judged yet, claimed by the same rule), and
   assertions run through `judgeAll`, the code that judged the ping. Before the first ping
   nothing is expected: a heartbeat nobody has pinged says "No ping yet", never a state. */

export type HeartbeatReceived = {
  pingAt: number | null;
  pingPayload: Record<string, unknown> | null;
  startAt: number | null;
  failAt: number | null;
  /** The home's cursor: the newest event it judged, and the last scheduled run it accounted
      for, by a finish or a deadline. */
  judgedAt: number | null;
  runAt: number | null;
};

export type HeartbeatView = {
  lastPingAt: number;
  lastKind: PingKind | null;
  summary: [string, string] | null;
  runningSince: number | null;
  expectedAt: number | null;
  /** Each assertion on the newest good ping's payload; null before one has arrived. */
  results: AssertionResult[] | null;
};

const shown = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

export function heartbeatView(
  r: HeartbeatReceived,
  m: { schedule: string; tz: string; versionAt: number; paused: boolean; assertions: readonly Assertion[] },
): HeartbeatView {
  const kinds = ([["ping", r.pingAt], ["start", r.startAt], ["fail", r.failAt]] as const).filter((k): k is readonly [PingKind, number] => k[1] !== null);
  const newest = kinds.reduce<readonly [PingKind, number] | null>((a, k) => (!a || k[1] > a[1] ? k : a), null);
  const finishes = [r.pingAt, r.failAt].filter((t): t is number => t !== null);
  const since = Math.max(r.judgedAt ?? -Infinity, m.versionAt);
  let expectedAt: number | null = null;
  if (!m.paused && (r.runAt !== null || finishes.length > 0)) {
    try {
      // The finishes the home hasn't judged yet, oldest first, each claiming its run as the
      // home will: by the /start still open before it, else by its own time (a retry or a late
      // finish of a counted run claims none and moves nothing).
      let runAt = r.runAt;
      let judged = since;
      for (const t of finishes.filter((f) => f > since).sort((a, b) => a - b)) {
        const at = r.startAt !== null && r.startAt > judged && r.startAt < t ? r.startAt : t;
        runAt = runOf(m.schedule, m.tz, at, expectedAfter(m.schedule, m.tz, runAt, m.versionAt)) ?? runAt;
        judged = t;
      }
      expectedAt = expectedAfter(m.schedule, m.tz, runAt, m.versionAt);
    } catch {
      expectedAt = null;
    }
  }
  const first = r.pingPayload ? Object.entries(r.pingPayload)[0] : undefined;
  return {
    lastPingAt: newest?.[1] ?? 0,
    lastKind: newest?.[0] ?? null,
    summary: first ? [first[0], shown(first[1])] : null,
    runningSince: r.startAt !== null && r.startAt > Math.max(since, ...finishes) ? r.startAt : null,
    expectedAt,
    results: r.pingPayload ? judgeAll(r.pingPayload, m.assertions) : null,
  };
}
