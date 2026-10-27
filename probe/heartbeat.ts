import { judgeAll, type Assertion } from "../src/checks/assertions";
import { snippet } from "../src/checks/mask";
import type { AssertionResult } from "../src/checks/types";
import { expectedAfter, nextRun, runOf } from "../src/lib/cron";
import type { Located, State } from "./state";

/* A heartbeat's verdicts (`spec.md § 3.3`), judged by its home probe from what the receiver
   recorded (`ingest/`, `record_heartbeat`). Pure: the store reads the locked row, `plan` names
   the next event to judge, `judge` turns it into the reducer's outcome and the row's new
   cursor, and the store commits both in one transaction (`store.ts`). Every time here is epoch
   milliseconds on the database's clock: pings are stamped by it, and the deadlines are computed
   from those stamps and the schedule, which lives in probe memory and nowhere else.

   What the row holds: the newest good ping, `/start` and `/fail` with their payloads; how many
   finishes (good pings and `/fail`s) ever arrived; and the home's cursor: the newest event it
   judged (`judgedAt`), how many finishes that covered (`judgedFinishes`), and the last scheduled
   run it accounted for, by a finish or a deadline (`runAt`, a scheduled time, never a ping's).
   The run expected next is the first scheduled after `runAt` (or after the last edit), so a run
   belongs to its own slot however long it ran.

   The events, judged oldest first, one per transaction:
   - A finish: a good ping (passes when every assertion holds on its payload, through the same
     code as an HTTP body's) or a `/fail`. It belongs to a scheduled run by `runOf` (`cron.ts`),
     judged at its `/start` when it sent one, else at the finish: at or after the expected run,
     the latest run at or before that time, so a late finish never claims the run after it; a
     little before the expected run, that run, reported early; earlier still, no run (a manual
     run, a retry, the late finish of a run already counted missed), which moves no expectation
     and counts nothing.
   - Missed: no finish by the expected run plus the grace window. A heartbeat never pinged has no
     expected run, so it keeps saying "No ping yet" and never gets a state from a deadline. An
     edit, a pause or a resume restarts the expectation from that moment, and pings that arrived
     before it are not judged, as a check run against an older version is fenced.
   - Stuck: a `/start` newer than the last run with no finish within the max run time. While a
     run is open its missed deadline waits: the job started on time.
   A deadline is judged 5 seconds after it falls, so a ping that reached the database before it
   is always visible to the read that judges it.

   Uptime counts runs: each scheduled run counts once, passed or failed by the finish that claimed
   it, failed when a deadline counted it missed or stuck. A finish that claims no run counts
   nothing.

   When pings arrive faster than the home judges them (no probe live, or a home changing), only
   the newest of each kind is left, so the row's finish count can exceed what is visible. Then a
   deadline before the newest visible finish may have been met by a finish nobody can see any
   more: it gets the benefit of the doubt, neither missed nor counted. */

export type Ping = { at: number; payload: Record<string, unknown>; note: string | null };

export type HeartbeatConfig = { schedule: string; tz: string; graceMin: number; maxRunMin: number; assertions: Assertion[] };

export type HeartbeatRow = {
  state: State | null;
  /** The monitor's `updated_at`, floored to the millisecond: its version's start. */
  versionAt: number;
  config: HeartbeatConfig;
  ping: Ping | null;
  start: Ping | null;
  fail: Ping | null;
  finishes: number;
  judgedAt: number | null;
  judgedFinishes: number;
  runAt: number | null;
};

/** A deadline is judged this long after it falls. */
export const DEADLINE_MARGIN_MS = 5_000;
/** At most this many missed runs in one event; a heartbeat dead longer than that while no probe
    was live is caught up a batch at a time. */
const MAX_MISSED_RUNS = 1_000;

export type HeartbeatEvent =
  | { kind: "ping"; at: number; ping: Ping; last: boolean }
  | { kind: "fail"; at: number; ping: Ping; last: boolean }
  /** `runs` are the expected times missed, oldest first; `at` is the first one's deadline and
      `judgedTo` the last one's. */
  | { kind: "missed"; at: number; runs: number[]; judgedTo: number; last: boolean }
  | { kind: "stuck"; at: number; startedAt: number; last: boolean };

/** The next event to judge, or none, with the next deadline when none is due. */
export type Plan = { event: HeartbeatEvent | null; due: number | null };

const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** A heartbeat's settings from its monitor's `config` (`src/lib/monitor-input.ts` writes them). */
export function configOf(raw: Record<string, unknown>): HeartbeatConfig {
  const list = Array.isArray(raw.assertions) ? raw.assertions : [];
  return {
    schedule: typeof raw.schedule === "string" ? raw.schedule : "",
    tz: typeof raw.tz === "string" ? raw.tz : "UTC",
    graceMin: num(raw.graceMin, 5),
    maxRunMin: num(raw.maxRunMin, 60),
    assertions: list
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .map((a) => ({ path: String(a.path ?? ""), op: String(a.op ?? "=="), value: String(a.value ?? "") })),
  };
}

/** Tolerates a time zone `Intl` doesn't know (an old row): such a heartbeat has no deadline
    rather than a probe that throws on every refresh. */
function safe(f: () => number | null): number | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/** The run expected after the row's last accounted run, or after its version's start. */
const expectedOf = (row: HeartbeatRow) => safe(() => expectedAfter(row.config.schedule, row.config.tz, row.runAt, row.versionAt));
/** The scheduled run after `t`. */
const slotAfter = (c: HeartbeatConfig, t: number) => safe(() => nextRun(c.schedule, c.tz, t));
/** The scheduled run a report at `t` belongs to, or null (`runOf`). */
const claimOf = (row: HeartbeatRow, t: number) => safe(() => runOf(row.config.schedule, row.config.tz, t, expectedOf(row)));

/** A `/start` after the last event judged and the last edit: the run that is open. One judged
    stuck is behind the cursor (its deadline is), and so is one a finish closed. */
const openStart = (row: HeartbeatRow) => (row.start && row.start.at > Math.max(row.judgedAt ?? -Infinity, row.versionAt) ? row.start : null);

type Deadline = { kind: "missed"; at: number; expected: number } | { kind: "stuck"; at: number; startedAt: number };

/** The first deadline after `cursor`, judged or not yet due. */
function deadlineAfter(row: HeartbeatRow, cursor: number): Deadline | null {
  const c = row.config;
  const grace = c.graceMin * 60_000;
  const open = openStart(row);
  let missed: Deadline | null = null;
  // Never pinged, no deadline: "No ping yet" until the first ping gives the heartbeat a state.
  if (row.state !== null) {
    let e = expectedOf(row);
    // Deadlines already judged, or fenced by an edit, are behind the cursor.
    for (let guard = 0; e !== null && e + grace <= cursor && guard < 100_000; guard++) e = slotAfter(c, e);
    if (e !== null) missed = { kind: "missed", at: e + grace, expected: e };
  }
  if (open) {
    if (missed && missed.at < open.at) return missed;
    return { kind: "stuck", at: open.at + c.maxRunMin * 60_000, startedAt: open.at };
  }
  return missed;
}

export function plan(row: HeartbeatRow, now: number): Plan {
  const cursor = Math.max(row.judgedAt ?? -Infinity, row.versionAt);
  const visible = (["ping", "fail"] as const)
    .map((kind) => ({ kind, ping: row[kind] }))
    .filter((x): x is { kind: "ping" | "fail"; ping: Ping } => !!x.ping && x.ping.at > cursor)
    .sort((a, b) => a.ping.at - b.ping.at);
  const newestVisible = visible.at(-1)?.ping.at;
  const hidden = row.finishes - row.judgedFinishes - visible.length;

  let deadline = deadlineAfter(row, cursor);
  if (deadline && hidden > 0 && newestVisible !== undefined && deadline.at < newestVisible) deadline = null;
  const due = deadline && deadline.at + DEADLINE_MARGIN_MS <= now ? deadline : null;

  const first = visible[0];
  // A finish at a deadline's very millisecond made it in time: finishes first.
  if (first && (!due || first.ping.at <= due.at)) {
    const finish = { at: first.ping.at, ping: first.ping, last: visible.length === 1 };
    return { event: first.kind === "ping" ? { kind: "ping", ...finish } : { kind: "fail", ...finish }, due: null };
  }
  if (!due) return { event: null, due: deadline?.at ?? null };
  if (due.kind === "stuck") return { event: { kind: "stuck", at: due.at, startedAt: due.startedAt, last: visible.length === 0 }, due: null };

  // Missed runs in a row, up to the next finish or `/start`, as one event.
  const c = row.config;
  const grace = c.graceMin * 60_000;
  const before = Math.min(first?.ping.at ?? Infinity, openStart(row)?.at ?? Infinity);
  const runs = [due.expected];
  for (let e = slotAfter(c, due.expected); e !== null && runs.length < MAX_MISSED_RUNS; e = slotAfter(c, e)) {
    if (e + grace + DEADLINE_MARGIN_MS > now || e + grace >= before) break;
    runs.push(e);
  }
  return { event: { kind: "missed", at: due.at, runs, judgedTo: runs[runs.length - 1] + grace, last: visible.length === 0 }, due: null };
}

/** The row's cursor after an event. `runAt` stays as it was when the event claimed no run. */
export type Cursor = { judgedAt: number; judgedFinishes: number; runAt: number | null };

export type Judged = {
  outcome: Located;
  cursor: Cursor;
  /** Runs to count into the home's windows, at their expected (or finish) time. */
  runs: { at: number; ok: boolean }[];
  /** What the incident page shows, if this opens one (`src/lib/workspace.ts` reads it). */
  evidence: { request: string; summary: string; assertion?: string; got?: string; locations: string[]; snippet: string };
  /** The incident timeline's first entry, if this opens one. */
  opened: string;
};

function when(t: number, tz: string): string {
  try {
    const p: Record<string, string> = {};
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const part of f.formatToParts(t)) p[part.type] = part.value;
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${tz}`;
  } catch {
    return new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
}

const NOTE: Record<string, string> = {
  not_json: "its body wasn't a JSON object",
  too_large: "its body was over the size Staygreen reads",
  truncated: "some of its fields were dropped to fit",
};

function assertionLine(a: AssertionResult, ping: Ping): string {
  const why = ping.note && a.got === undefined ? `, ${NOTE[ping.note] ?? "it carried no fields"}` : "";
  return `${a.path} ${a.op}${a.op === "exists" ? "" : ` ${a.expected}`} failed: got ${a.got ?? "nothing"}${why}`;
}

/** The outcome, cursor and runs for `event`, judged at `location` (the home's). */
export function judge(row: HeartbeatRow, event: HeartbeatEvent, location: string): Judged {
  const c = row.config;
  const finishedFinishes = event.last ? row.finishes : row.judgedFinishes + (event.kind === "ping" || event.kind === "fail" ? 1 : 0);
  if (event.kind === "ping" || event.kind === "fail") {
    const t = event.at;
    const start = openStart(row);
    const opened = start && start.at < t ? start.at : null;
    const ms = opened === null ? 0 : Math.min(t - opened, 2_147_483_647);
    const body = snippet(JSON.stringify(event.ping.payload));
    // The scheduled run this finish belongs to, by its /start when it sent one (a job that runs
    // past its next slot still finishes its own run); none for a retry, a manual run, or the
    // late finish of a run a deadline already counted.
    const slot = claimOf(row, opened ?? t);
    const late = slot === null;
    const cursor: Cursor = { judgedAt: t, judgedFinishes: finishedFinishes, runAt: slot ?? row.runAt };
    if (event.kind === "fail") {
      const message = "The job reported a failure (/fail)";
      return {
        outcome: { ok: false, ms, location, failure: { kind: "fail", message }, snippet: body },
        cursor,
        runs: late ? [] : [{ at: t, ok: false }],
        evidence: { request: "/fail", summary: message, locations: [], snippet: body },
        opened: "The job reported a failure, incident opened",
      };
    }
    const results = judgeAll(event.ping.payload, c.assertions);
    const failed = results.find((r) => !r.pass);
    if (!failed) {
      return {
        outcome: { ok: true, ms, location, assertions: results },
        cursor,
        runs: late ? [] : [{ at: t, ok: true }],
        evidence: { request: "Ping", summary: "", locations: [], snippet: "" },
        opened: "",
      };
    }
    const message = assertionLine(failed, event.ping);
    return {
      outcome: { ok: false, ms, location, assertions: results, failure: { kind: "assertion", message }, snippet: body },
      cursor,
      runs: late ? [] : [{ at: t, ok: false }],
      evidence: {
        request: "Ping",
        summary: message,
        assertion: `${failed.path} ${failed.op}${failed.op === "exists" ? "" : ` ${failed.expected}`}`,
        got: failed.got ?? "",
        locations: [],
        snippet: body,
      },
      opened: "A ping's assertion failed, incident opened",
    };
  }
  if (event.kind === "missed") {
    const first = event.runs[0];
    const more = event.runs.length > 1 ? `, and ${event.runs.length - 1} more expected ${event.runs.length === 2 ? "run" : "runs"} after it` : "";
    const message = `No ping by ${when(event.at, c.tz)}: expected at ${when(first, c.tz).split(" ")[1]}, plus ${c.graceMin} min grace${more}`;
    return {
      outcome: { ok: false, ms: 0, location, failure: { kind: "missed", message } },
      cursor: { judgedAt: event.judgedTo, judgedFinishes: finishedFinishes, runAt: event.runs[event.runs.length - 1] },
      runs: event.runs.map((at) => ({ at, ok: false })),
      evidence: { request: `Expected ${when(first, c.tz)}`, summary: message, locations: [], snippet: "" },
      opened: `No ping by ${when(event.at, c.tz).split(" ")[1]}, incident opened`,
    };
  }
  const message = `Started at ${when(event.startedAt, c.tz)} and didn't finish within ${c.maxRunMin} min`;
  // The run that `/start` began, by the same rule as a finish; a start that began no scheduled
  // run (a manual one) still fails the heartbeat, but counts no run.
  const slot = claimOf(row, event.startedAt);
  return {
    outcome: { ok: false, ms: 0, location, failure: { kind: "stuck", message } },
    cursor: { judgedAt: event.at, judgedFinishes: finishedFinishes, runAt: slot ?? row.runAt },
    runs: slot === null ? [] : [{ at: event.startedAt, ok: false }],
    evidence: { request: "/start", summary: message, locations: [], snippet: "" },
    opened: `No finish within ${c.maxRunMin} min of its start, incident opened`,
  };
}
