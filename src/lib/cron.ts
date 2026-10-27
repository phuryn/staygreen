/* A heartbeat's schedule, read the way a person would say it, and when its next run is due.

   Pure, and shared: the add-monitor form shows the label as you type, the snapshot shows it on
   the monitor, the creating action derives the monitor's interval from the period, and the
   monitor's home probe judges its deadlines with `runOf` and `expectedAfter`
   (`probe/heartbeat.ts`), the same answer the dashboard's "Expected" cell shows. Nothing else
   computes a run time. */

export type CronDescription = { valid: boolean; label: string; periodMin: number };

/** One field: `*`, a number, a range, a step, or a comma list of those. */
const FIELD = /^(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?(,(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?)*$/;

/** Minute, hour, day of month, month, day of week (0 and 7 are both Sunday). */
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** Every number in the field inside its range, every range low to high, every step at least 1. */
function inRange(field: string, [lo, hi]: [number, number]): boolean {
  return field.split(",").every((part) => {
    const [base, step] = part.split("/");
    if (step !== undefined && Number(step) < 1) return false;
    if (base === "*") return true;
    const [a, b = a] = base.split("-").map(Number);
    return a >= lo && b <= hi && a <= b;
  });
}

export function isValidCron(c: string): boolean {
  const p = c.trim().split(/\s+/);
  return p.length === 5 && p.every((f, i) => FIELD.test(f) && inRange(f, RANGES[i]));
}

export function describeCron(c: string): CronDescription {
  if (!isValidCron(c)) return { valid: false, label: "Not a valid schedule yet", periodMin: 1440 };
  const [mi, h, dom, mon, dow] = c.trim().split(/\s+/);
  const pad = (x: string) => x.padStart(2, "0");
  const ok = (label: string, periodMin: number) => ({ valid: true, label, periodMin });
  let m: RegExpMatchArray | null;
  if ((m = mi.match(/^\*\/(\d+)$/)) && h === "*") return ok(`Every ${m[1]} minutes`, Math.max(1, Number(m[1])));
  if (mi === "*" && h === "*") return ok("Every minute", 1);
  if (/^\d+$/.test(mi) && h === "*") return ok(`Every hour at :${pad(mi)}`, 60);
  if ((m = h.match(/^\*\/(\d+)$/)) && /^\d+$/.test(mi)) return ok(`Every ${m[1]} hours`, Math.max(1, Number(m[1])) * 60);
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && dom === "*" && mon === "*") {
    const at = `${pad(h)}:${pad(mi)}`;
    if (dow === "*") return ok(`Every day at ${at}`, 1440);
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    if (/^[0-6]$/.test(dow)) return ok(`Every ${days[Number(dow)]} at ${at}`, 10080);
    if (dow === "1-5") return ok(`Weekdays at ${at}`, 1440);
  }
  if (/^\d+$/.test(mi) && /^\d+$/.test(h) && /^\d+$/.test(dom) && mon === "*") return ok(`Monthly on day ${dom} at ${pad(h)}:${pad(mi)}`, 44640);
  return ok("Custom schedule", 1440);
}

/** The monitor row's interval for a schedule: the period, held to what the table allows. */
export function heartbeatIntervalSec(c: string): number {
  return Math.min(86400, Math.max(60, describeCron(c).periodMin * 60));
}

// ── when the next run is due ────────────────────────────────────────────────
// Standard five-field cron, Vixie's rules: when neither the day of the month nor the day of the
// week starts with `*`, a day matching either one runs; otherwise a day must match both. The fields are read as wall-clock time in the schedule's IANA time zone.
//
// Daylight saving, both directions, the way a cron daemon on that clock behaves:
// - Spring forward: a time inside the skipped hour runs once, as far after the change as it
//   was scheduled into the gap (02:30 on the change day is 03:30). Never skipped.
// - Fall back: a time that happens twice runs once, at its first occurrence. The repeated hour
//   is not a second run.

type Fields = { minute: boolean[]; hour: boolean[]; dom: boolean[]; month: boolean[]; dow: boolean[]; domStar: boolean; dowStar: boolean };

function expand(field: string, lo: number, hi: number): boolean[] {
  const on = Array<boolean>(hi + 1).fill(false);
  for (const part of field.split(",")) {
    const [base, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    let a = lo;
    let b = hi;
    if (base !== "*") {
      const [x, y] = base.split("-").map(Number);
      a = x;
      // `5/15` means from 5 to the end, as in Vixie cron.
      b = y ?? (stepText === undefined ? x : hi);
    }
    for (let v = a; v <= b; v += step) on[v] = true;
  }
  return on;
}

function parse(c: string): Fields | null {
  if (!isValidCron(c)) return null;
  const [mi, h, dom, mon, dow] = c.trim().split(/\s+/);
  const days = expand(dow, 0, 7);
  if (days[7]) days[0] = true;
  return {
    minute: expand(mi, 0, 59),
    hour: expand(h, 0, 23),
    dom: expand(dom, 1, 31),
    month: expand(mon, 1, 12),
    dow: days.slice(0, 7),
    domStar: dom.startsWith("*"),
    dowStar: dow.startsWith("*"),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  return f;
}

/** The wall clock in `tz` at instant `t`, as if it were UTC: a "naive" time to do date
 *  arithmetic on without any zone's rules. Seconds dropped. */
function wallAt(t: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(t)) if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/** The instant a wall-clock minute in `tz` names. A minute that happens twice is its first
 *  occurrence; one the clocks skipped is read with the offset from before the change, which
 *  lands it after the gap by the time it was scheduled into it. */
function instantOf(wall: number, tz: string): number {
  // The offsets either side of the minute. No zone changes its offset twice within a day.
  const before = wallAt(wall - 43_200_000, tz) - Math.floor((wall - 43_200_000) / 60_000) * 60_000;
  const after = wallAt(wall + 43_200_000, tz) - Math.floor((wall + 43_200_000) / 60_000) * 60_000;
  const valid = [wall - before, wall - after].filter((t) => wallAt(t, tz) === wall);
  if (valid.length) return Math.min(...valid);
  return wall - before;
}

const DAY_MS = 86_400_000;

/** The first run strictly after `afterMs`, or null when the schedule never runs (the 31st of
 *  February) or isn't valid. An unknown time zone throws, as `Intl` does; the form refuses one. */
export function nextRun(c: string, tz: string, afterMs: number): number | null {
  const f = parse(c);
  if (!f) return null;
  // Start at the wall-clock minute after `afterMs`, then walk forward through matching months,
  // days, hours and minutes. A candidate that names an instant not after `afterMs` (the first
  // occurrence of a repeated hour, read again) moves on by a minute.
  let wall = wallAt(afterMs, tz) + 60_000;
  const limit = wall + 5 * 366 * DAY_MS;
  while (wall < limit) {
    const d = new Date(wall);
    const month = d.getUTCMonth() + 1;
    if (!f.month[month]) {
      wall = Date.UTC(d.getUTCFullYear(), month, 1);
      continue;
    }
    const domOk = f.dom[d.getUTCDate()];
    const dowOk = f.dow[d.getUTCDay()];
    // Vixie: either field starting with `*` means both must match (the star one matches every day
    // it allows); neither starting with one means either may.
    const dayOk = f.domStar || f.dowStar ? domOk && dowOk : domOk || dowOk;
    if (!dayOk) {
      wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    let h = d.getUTCHours();
    while (h < 24 && !f.hour[h]) h++;
    if (h === 24) {
      wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    let mi = h === d.getUTCHours() ? d.getUTCMinutes() : 0;
    while (mi < 60 && !f.minute[mi]) mi++;
    if (mi === 60) {
      wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h + 1);
      continue;
    }
    const candidate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, mi);
    const at = instantOf(candidate, tz);
    if (at > afterMs) return at;
    wall = candidate + 60_000;
  }
  return null;
}

/** The last run at or before `atMs`, or null when there is none in the five years before it (or
 *  the schedule isn't valid). The mirror of `nextRun`: the same instants, walked backwards. */
export function lastRun(c: string, tz: string, atMs: number): number | null {
  const f = parse(c);
  if (!f) return null;
  let wall = wallAt(atMs, tz);
  const limit = wall - 5 * 366 * DAY_MS;
  while (wall > limit) {
    const d = new Date(wall);
    const y = d.getUTCFullYear(), m = d.getUTCMonth(), date = d.getUTCDate();
    if (!f.month[m + 1]) {
      wall = Date.UTC(y, m, 1) - 60_000;
      continue;
    }
    const dayOk = f.domStar || f.dowStar ? f.dom[date] && f.dow[d.getUTCDay()] : f.dom[date] || f.dow[d.getUTCDay()];
    if (!dayOk) {
      wall = Date.UTC(y, m, date) - 60_000;
      continue;
    }
    let h = d.getUTCHours();
    while (h >= 0 && !f.hour[h]) h--;
    if (h < 0) {
      wall = Date.UTC(y, m, date) - 60_000;
      continue;
    }
    let mi = h === d.getUTCHours() ? d.getUTCMinutes() : 59;
    while (mi >= 0 && !f.minute[mi]) mi--;
    if (mi < 0) {
      wall = Date.UTC(y, m, date, h) - 60_000;
      continue;
    }
    const candidate = Date.UTC(y, m, date, h, mi);
    const at = instantOf(candidate, tz);
    if (at <= atMs) return at;
    wall = candidate - 60_000;
  }
  return null;
}

/** How early a run may report and still be the run it was scheduled for, for a job whose clock
 *  runs a little ahead of ours: 30 seconds, or a tenth of the gap to the run after the expected
 *  one when that is shorter. On a frequent schedule a report shortly before a run is far more
 *  likely the previous run finishing late, so the allowance shrinks with the gap. */
export const EARLY_MS = 30_000;

export function earlyFor(c: string, tz: string, expectedMs: number): number {
  const after = nextRun(c, tz, expectedMs);
  return after === null ? EARLY_MS : Math.min(EARLY_MS, Math.floor((after - expectedMs) / 10));
}

/** The scheduled run a report at `t` belongs to, given the run the heartbeat expects next
 *  (`expectedMs`): every run before that one is already accounted for. The probe passes a run's
 *  `/start` time when it sent one, else its finish's.
 *  - At or after the expected run: the latest run at or before `t`. A late finish never claims
 *    the run after it, however long the job took.
 *  - Before it by at most `earlyFor`: the expected run itself, reported a little early.
 *  - Earlier still: no run. A manual run, a retry, or the late finish of a run a deadline already
 *    counted moves no expectation and counts no run. */
export function runOf(c: string, tz: string, t: number, expectedMs: number | null): number | null {
  if (expectedMs === null) return null;
  if (t >= expectedMs) {
    const run = lastRun(c, tz, t);
    return run === null || run < expectedMs ? expectedMs : run;
  }
  return expectedMs - t <= earlyFor(c, tz, expectedMs) ? expectedMs : null;
}

/** The run a heartbeat expects next: the first scheduled after the last run it accounted for
 *  (`lastRunMs`, a scheduled time, null before any) or after its version's start, whichever is
 *  later. An edit, a pause or a resume restarts the expectation from that moment. The probe's
 *  deadline is this plus the grace window. */
export const expectedAfter = (c: string, tz: string, lastRunMs: number | null, sinceMs: number): number | null =>
  nextRun(c, tz, Math.max(lastRunMs ?? sinceMs, sinceMs));
