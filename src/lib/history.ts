import { z } from "zod";
import { ago, time } from "./format";
import { isLocationId, locationIds, locations, type LocationId } from "./plans";
import type { MonEvent, Monitor, Point, Report, Uptime } from "./model";

/* What the probes measured, as the dashboard reads it: `workspace_history` for every monitor of
   a workspace and `monitor_history` for one monitor's page (migration 014). The SQL works out
   each day's uptime and every sum; this file checks the shape, places each value on its day and
   words it, and is pure, so all of that is tested without a database.

   Days are UTC days, the database's and the bars' alike (`UptimeBars`). */

const DAY_MS = 86_400_000;

const when = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "a timestamp");
const count = z.number().int().min(0);
const seconds = z.number().int().min(0);
const ms = z.number().int().min(0);
const stored = z.enum(["up", "degraded", "down"]);

export const workspaceHistoryDto = z.object({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  monitors: z.array(
    z.object({
      id: z.string(),
      // [days before today, uptime that day]: only days with a window.
      days: z.array(z.tuple([z.number().int().min(0), z.number().min(0).max(100)])),
      month: z.object({ covered: seconds, down: seconds }),
      day: z.object({ covered: seconds, down: seconds }),
      p95: ms.nullable(),
      latest: z.array(z.object({ loc: z.string(), end: when, checks: count, failures: count, p50: ms.nullable() })),
    }),
  ),
});

export type WorkspaceHistory = z.infer<typeof workspaceHistoryDto>;
type MonitorRow = WorkspaceHistory["monitors"][number];

export const monitorHistoryDto = z
  .object({
    points: z.array(z.object({ t: when, checks: count, failures: count, p50: ms.nullable(), p95: ms.nullable() })),
    failures: z.array(
      z.object({ at: when, loc: z.string(), kind: z.string(), message: z.string(), status: z.number().int().nullable(), ms, snippet: z.string().nullable() }),
    ),
    transitions: z.array(z.object({ at: when, from: stored.nullable(), to: stored })),
  })
  .nullable();

export type MonitorHistoryRow = NonNullable<z.infer<typeof monitorHistoryDto>>;

/** The fields of a `Monitor` the probes fill. */
export type Measured = Pick<Monitor, "reports" | "uptime" | "p95" | "daily">;

/** A monitor nobody's probe has reported on: every number is absent, none is zero. */
export const nothingMeasured = (): Measured => ({
  reports: [],
  uptime: { day: { pct: null, coveredMs: 0 }, month: { pct: null, coveredMs: 0 } },
  p95: null,
  daily: Array<number>(90).fill(-1),
});

/** The share of `covered` seconds no outage took, or null when nothing was covered. */
export function uptimeOf(covered: number, down: number): Uptime {
  if (!(covered > 0)) return { pct: null, coveredMs: 0 };
  return { pct: (100 * (covered - Math.min(Math.max(down, 0), covered))) / covered, coveredMs: covered * 1000 };
}

const utcDay = (t: number) => Math.floor(t / DAY_MS);

/** `n` days of uptime, oldest first and ending on the UTC day of `now`; -1 for a day with no
 *  window. `days` counts back from the database's `today`, which a page read just after UTC
 *  midnight can be a day behind. */
export function dailySeries(days: [number, number][], today: string, now: number, n = 90): number[] {
  const shift = utcDay(now) - utcDay(Date.parse(`${today}T00:00:00Z`));
  const out = Array<number>(n).fill(-1);
  for (const [age, up] of days) {
    const i = n - 1 - (age + shift);
    if (i >= 0 && i < n) out[i] = up;
  }
  return out;
}

/** The same from `{ d, up }` pairs, the public snapshot's form (`public_status_snapshot`). A
 *  day after the UTC day of `now` is dropped. */
export function datedSeries(days: { d: string; up: number }[], now: number, n = 90): number[] {
  const today = utcDay(now);
  const aged = days.map((x) => [today - utcDay(Date.parse(`${x.d}T00:00:00Z`)), x.up] as [number, number]).filter(([age]) => age >= 0);
  return dailySeries(aged, new Date(now).toISOString().slice(0, 10), now, n);
}

/** Each location's newest window, newest first; a location the plan module doesn't know is
 *  dropped, and one that never reported has no entry. */
export function reportsOf(latest: MonitorRow["latest"]): Report[] {
  return latest
    .filter((r) => isLocationId(r.loc))
    .map((r) => ({ loc: r.loc as Report["loc"], end: Date.parse(r.end), checks: r.checks, failures: r.failures, p50: r.p50 }))
    .sort((a, b) => b.end - a.end || locationIds.indexOf(a.loc) - locationIds.indexOf(b.loc));
}

export function measuredOf(row: MonitorRow, today: string, now: number): Measured {
  return {
    reports: reportsOf(row.latest),
    uptime: { day: uptimeOf(row.day.covered, row.day.down), month: uptimeOf(row.month.covered, row.month.down) },
    p95: row.p95,
    daily: dailySeries(row.days, today, now),
  };
}

/** Every monitor's measurements by id. A monitor the function didn't return gets none. */
export function measuredById(h: WorkspaceHistory, now: number): Map<string, Measured> {
  return new Map(h.monitors.map((row) => [row.id, measuredOf(row, h.today, now)]));
}

/** What still belongs to a monitor whose row has no state. A changed address clears the state
 *  (006) and leaves the old address's windows behind, so only a window that ended after the last
 *  edit (`updated_at`) is this address's: a new monitor whose first failures no second location
 *  confirmed yet has those, and they say it was checked. Days and the uptime built from them
 *  can't be split at the edit, so none are shown until a probe sets a state again. */
export function sinceLastEdit(m: Measured, updatedAt: number): Measured {
  return { ...nothingMeasured(), reports: m.reports.filter((r) => r.end > updatedAt) };
}

// ── what a screen says about them ───────────────────────────────────────────

/** The newest window anywhere, or null before the first. */
export const newestReport = (m: Pick<Monitor, "reports">): Report | null => m.reports[0] ?? null;

const WINDOW_MS = 300_000;

/** When a window's checks ran, for the words beside its result. A closed window reads as old as
 *  its end, as it always has. One still open was written before it closed: a new monitor's first
 *  check, which the probe writes at once, or what a stopping probe had (`probe/runtime.ts`). Its
 *  end hasn't come, so "just now" would stay on screen for up to five minutes after the check;
 *  what is true is that its checks ran since the window began, or since the monitor's current
 *  version began (`since`: its creation, or its last edit, pause or resume) when that is later,
 *  because an edit starts its open windows over, in the database and in the probes (020):
 *  "since 18:37". */
export function reportedWhen(r: Pick<Report, "end">, now: number, since = 0): string {
  if (r.end <= now) return ago(r.end, now);
  return `since ${time(Math.max(r.end - WINDOW_MS, since))}`;
}

/** When a monitor's current version began, for `reportedWhen`. */
export const versionSince = (m: Pick<Monitor, "createdAt" | "updatedAt">) => m.updatedAt ?? m.createdAt;

/** What to write where a number would be: never "Not checked yet" beside a state a probe set. */
export const noNumber = (m: Pick<Monitor, "checked">) => (m.checked ? "No data yet" : "Not checked yet");

/** A probe has checked this monitor, but its state is not settled. A heartbeat before its
 *  first ping has no check or state, so it stays unchecked rather than waiting on a probe. */
export const isChecking = (m: Pick<Monitor, "state" | "checked">) => m.state === "unchecked" && m.checked;

/** The badge, app summaries and filters share these words; neither is a stored state. A Supabase
 *  project that stopped resolving reads Paused or deleted rather than plain down. */
export const stateLabel = (m: Pick<Monitor, "state" | "checked" | "serviceStatus">) =>
  m.state === "down" && m.serviceStatus === "paused_or_deleted" ? "Paused or deleted" : isChecking(m) ? "Checking…" : undefined;

/** A check interval as the screens say it: "10 min", "6 h". */
export const everyLabel = (sec: number) => (sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`);

/** When a down monitor turns green: after two passing checks in a row (`probe/state.ts`). The
 *  owner asked what Down beside Passed means and when it ends (2026-10-23). It states the rule,
 *  never that the newest check passed: a check reaches the screens only when its 5-minute window
 *  closes, so the newest one shown can be older than a failure that already reset the count. A
 *  heartbeat recovers on its next good ping and a service monitor on its own rules, so neither. */
export function recoveryNote(m: Pick<Monitor, "state" | "type" | "intervalSec">): string | null {
  if (m.state !== "down" || !["http", "tcp", "dns", "ssl"].includes(m.type)) return null;
  return `Green after two passing checks in a row. Checks run every ${everyLabel(m.intervalSec)}.`;
}

/** A window's checks in a few words. */
export function reportResult(r: Pick<Report, "checks" | "failures">): string {
  if (r.failures === 0) return r.checks === 1 ? "Passed" : `${r.checks} checks passed`;
  if (r.failures === r.checks) return r.checks === 1 ? "Failed" : `${r.checks} checks failed`;
  return `${r.failures} of ${r.checks} checks failed`;
}

/** Up, a warning or down, for the shape beside a window's result. */
export const reportState = (r: Pick<Report, "checks" | "failures">): "up" | "degraded" | "down" =>
  r.failures === 0 ? "up" : r.failures === r.checks ? "down" : "degraded";

// ── one monitor's page ──────────────────────────────────────────────────────

/** `lastFailure` is each location's newest failed check, for its card. */
export type MonitorHistory = { points: Point[]; events: MonEvent[]; lastFailure: Partial<Record<LocationId, { t: number; message: string }>> };

export const NO_HISTORY: MonitorHistory = { points: [], events: [], lastFailure: {} };

const place = (loc: string) => (isLocationId(loc) ? locations[loc].city : loc);

/** What a state change means, said for the builder. Down needs a failure a second location
 *  confirmed, up after down needs two passes, and degraded is three slow passes in a row
 *  (`probe/state.ts`). A heartbeat's grace window is its confirmation, so it is down on a
 *  missed, failed or stuck run and up again on the next good ping (`spec.md § 3.3`). */
export function transitionEvent(from: "up" | "degraded" | "down" | null, to: "up" | "degraded" | "down", heartbeat = false): Pick<MonEvent, "kind" | "text"> {
  if (heartbeat) {
    if (to === "down") return { kind: "down", text: from === null ? "Down from its first ping. An incident opened." : "Down. An incident opened." };
    if (from === null) return { kind: "pass", text: "First ping received." };
    if (from === "down") return { kind: "recovered", text: "Up again: a good ping arrived. The incident closed." };
    return { kind: "recovered", text: "Up." };
  }
  if (to === "down") return { kind: "down", text: from === null ? "Down from its first checks. An incident opened." : "Down. An incident opened." };
  if (to === "degraded") {
    if (from === null) return { kind: "degraded", text: "Slow from its first checks." };
    if (from === "down") return { kind: "recovered", text: "Up again after two passing checks, but slow. The incident closed." };
    return { kind: "degraded", text: "Slow: three checks in a row took longer than the threshold." };
  }
  if (from === null) return { kind: "pass", text: "First check passed." };
  if (from === "down") return { kind: "recovered", text: "Up again after two passing checks. The incident closed." };
  return { kind: "recovered", text: "Responses are fast again." };
}

/** `heartbeat`: a heartbeat's failures were judged by its home from what arrived, not checked
 *  from a place, so they say what happened without a city. */
export function monitorHistoryOf(row: MonitorHistoryRow | null, heartbeat = false): MonitorHistory {
  if (!row) return NO_HISTORY;
  const points: Point[] = row.points.map((p) => ({ t: Date.parse(p.t), p50: p.p50, p95: p.p95, fails: p.failures, checks: p.checks }));
  const failures: MonEvent[] = row.failures.map((f, i) => ({
    id: `fail-${i}-${f.at}`,
    t: Date.parse(f.at),
    kind: "fail",
    text: heartbeat ? f.message : `Failed in ${place(f.loc)}: ${f.message}`,
    ...(isLocationId(f.loc) ? { loc: f.loc } : {}),
    ...(f.snippet ? { snippet: f.snippet } : {}),
  }));
  const transitions: MonEvent[] = row.transitions.map((t, i) => ({ id: `state-${i}-${t.at}`, t: Date.parse(t.at), ...transitionEvent(t.from, t.to, heartbeat) }));
  const lastFailure: MonitorHistory["lastFailure"] = {};
  for (const f of row.failures) {
    if (!isLocationId(f.loc)) continue;
    const t = Date.parse(f.at);
    const seen = lastFailure[f.loc];
    if (!seen || t > seen.t) lastFailure[f.loc] = { t, message: f.message };
  }
  return { points, events: [...failures, ...transitions].sort((a, b) => b.t - a.t), lastFailure };
}
