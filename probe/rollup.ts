/* 5-minute rollups, aggregated in memory (`spec.md § 4`, `AGENTS.md`: never one row per check).
   Each probe keeps its own windows for its own location, so the percentiles are exact: every
   check of the window is in one place when the window closes. The one exception is a new
   monitor's first window, written in two parts (`take`), whose p50 is the passes' weighted mean
   of the two parts' and whose p95 is the greater. Response times are of passing checks only; a
   timeout's 15 s would say nothing about how fast the target answers. */

export const WINDOW_SEC = 300;

export type RollupRow = {
  monitorId: string;
  location: string;
  /** Epoch seconds, a multiple of `WINDOW_SEC`. */
  windowStart: number;
  checks: number;
  failures: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
};

/** One row per monitor, location and window, each pair combined as `probe_flush_rollups`
    combines a row with the one already stored: checks and failures summed, p50 weighted by
    passes, p95 and max the greater. Postgres refuses an upsert that names one key twice, so a
    batch holding a window's failed first write beside the rest of that window would fail, and
    every flush after it with the same batch. */
export function merged(rows: RollupRow[]): RollupRow[] {
  const byKey = new Map<string, RollupRow>();
  const greater = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.max(a, b));
  for (const r of rows) {
    const key = `${r.monitorId}|${r.location}|${r.windowStart}`;
    const had = byKey.get(key);
    if (!had) {
      byKey.set(key, { ...r });
      continue;
    }
    const passes = had.checks - had.failures;
    const more = r.checks - r.failures;
    had.p50Ms = had.p50Ms === null ? r.p50Ms : r.p50Ms === null ? had.p50Ms : (had.p50Ms * passes + r.p50Ms * more) / (passes + more);
    had.p95Ms = greater(had.p95Ms, r.p95Ms);
    had.maxMs = greater(had.maxMs, r.maxMs);
    had.checks += r.checks;
    had.failures += r.failures;
  }
  return [...byKey.values()];
}

type Acc = { monitorId: string; windowStart: number; checks: number; failures: number; ms: number[] };

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1];
}

export class Rollups {
  private open = new Map<string, Acc>();

  constructor(readonly location: string) {}

  get size(): number {
    return this.open.size;
  }

  /** `ms` null is a result with no response time: a heartbeat's run counts, its time doesn't. */
  record(monitorId: string, atSec: number, r: { ok: boolean; ms: number | null }): void {
    const windowStart = Math.floor(atSec / WINDOW_SEC) * WINDOW_SEC;
    const key = `${windowStart}|${monitorId}`;
    let acc = this.open.get(key);
    if (!acc) this.open.set(key, (acc = { monitorId, windowStart, checks: 0, failures: 0, ms: [] }));
    acc.checks++;
    if (!r.ok) acc.failures++;
    else if (r.ms !== null) acc.ms.push(r.ms);
  }

  /** The windows that ended at least `graceSec` before `nowSec`, taken out of memory. */
  closed(nowSec: number, graceSec = 0): RollupRow[] {
    const rows: RollupRow[] = [];
    for (const [key, acc] of this.open) {
      if (acc.windowStart + WINDOW_SEC + graceSec > nowSec) continue;
      rows.push(this.row(acc));
      this.open.delete(key);
    }
    return rows;
  }

  /** One monitor's open windows, taken out of memory before they close: a new monitor's first
      check, written at once so the dashboard has a number within seconds (`runtime.ts`). The
      next check in the same window starts a new accumulator, and the window's close writes only
      what came after, which `probe_flush_rollups` adds to what is already there (checks and
      failures summed, p50 weighted by passes, p95 and max the greater). */
  take(monitorId: string): RollupRow[] {
    const rows: RollupRow[] = [];
    for (const [key, acc] of this.open) {
      if (acc.monitorId !== monitorId) continue;
      rows.push(this.row(acc));
      this.open.delete(key);
    }
    return rows;
  }

  /** Drops one monitor's windows that end after `sinceSec` (all of them by default): a new
      version of the monitor (an edit, a pause, a resume) starts its windows over, and what was
      held for them is the old version's (`runtime.ts`). Windows that ended before it stay. */
  forget(monitorId: string, sinceSec = -Infinity): number {
    let dropped = 0;
    for (const [key, acc] of this.open) {
      if (acc.monitorId !== monitorId || acc.windowStart + WINDOW_SEC <= sinceSec) continue;
      this.open.delete(key);
      dropped++;
    }
    return dropped;
  }

  /** Everything, open windows included: for a probe shutting down. */
  drain(): RollupRow[] {
    const rows = [...this.open.values()].map((acc) => this.row(acc));
    this.open.clear();
    return rows;
  }

  private row(acc: Acc): RollupRow {
    const ms = acc.ms.sort((a, b) => a - b);
    return {
      monitorId: acc.monitorId,
      location: this.location,
      windowStart: acc.windowStart,
      checks: acc.checks,
      failures: acc.failures,
      p50Ms: percentile(ms, 0.5),
      p95Ms: percentile(ms, 0.95),
      maxMs: ms.length ? ms[ms.length - 1] : null,
    };
  }
}
