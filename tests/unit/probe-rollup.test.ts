import { describe, expect, it } from "vitest";
import { merged, percentile, Rollups, WINDOW_SEC } from "../../probe/rollup";

/* 5-minute rollups in memory (`spec.md § 4`), exact because one probe holds every check of its
   own location's window. */

const T = 1_800_000_000; // a multiple of 300

describe("percentile", () => {
  it("is the nearest rank", () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(xs, 0.5)).toBe(50);
    expect(percentile(xs, 0.95)).toBe(95);
    expect(percentile([7], 0.95)).toBe(7);
    expect(percentile([1, 2], 0.5)).toBe(1);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("Rollups", () => {
  it("counts checks and failures per monitor and window, with times of passing checks only", () => {
    const r = new Rollups("tor1");
    r.record("m1", T + 1, { ok: true, ms: 100 });
    r.record("m1", T + 61, { ok: true, ms: 300 });
    r.record("m1", T + 121, { ok: false, ms: 15_000 });
    r.record("m2", T + 2, { ok: true, ms: 50 });
    r.record("m1", T + WINDOW_SEC + 1, { ok: true, ms: 80 });
    const rows = r.closed(T + WINDOW_SEC);
    expect(rows.sort((a, b) => a.monitorId.localeCompare(b.monitorId))).toEqual([
      { monitorId: "m1", location: "tor1", windowStart: T, checks: 3, failures: 1, p50Ms: 100, p95Ms: 300, maxMs: 300 },
      { monitorId: "m2", location: "tor1", windowStart: T, checks: 1, failures: 0, p50Ms: 50, p95Ms: 50, maxMs: 50 },
    ]);
    expect(r.size).toBe(1);
  });

  it("gives a window of only failures no response times", () => {
    const r = new Rollups("sfo3");
    r.record("m1", T, { ok: false, ms: 10 });
    expect(r.closed(T + WINDOW_SEC)[0]).toMatchObject({ checks: 1, failures: 1, p50Ms: null, p95Ms: null, maxMs: null });
  });

  it("holds a window until its grace has passed, and hands each one out once", () => {
    const r = new Rollups("tor1");
    r.record("m1", T + 10, { ok: true, ms: 1 });
    expect(r.closed(T + WINDOW_SEC + 4, 5)).toEqual([]);
    expect(r.closed(T + WINDOW_SEC + 5, 5)).toHaveLength(1);
    expect(r.closed(T + 10 * WINDOW_SEC, 5)).toEqual([]);
  });

  it("drains open windows too, for a probe shutting down", () => {
    const r = new Rollups("tor1");
    r.record("m1", T + 10, { ok: true, ms: 1 });
    expect(r.drain()).toHaveLength(1);
    expect(r.size).toBe(0);
  });

  it("takes one monitor's window out early, and its close then carries only what came after", () => {
    const r = new Rollups("tor1");
    r.record("m1", T + 10, { ok: true, ms: 120 });
    r.record("m2", T + 11, { ok: true, ms: 50 });
    expect(r.take("m1")).toEqual([{ monitorId: "m1", location: "tor1", windowStart: T, checks: 1, failures: 0, p50Ms: 120, p95Ms: 120, maxMs: 120 }]);
    expect(r.take("m1")).toEqual([]);
    r.record("m1", T + 70, { ok: false, ms: 15_000 });
    r.record("m1", T + 130, { ok: true, ms: 80 });
    const closed = r.closed(T + WINDOW_SEC).sort((a, b) => a.monitorId.localeCompare(b.monitorId));
    expect(closed).toEqual([
      { monitorId: "m1", location: "tor1", windowStart: T, checks: 2, failures: 1, p50Ms: 80, p95Ms: 80, maxMs: 80 },
      { monitorId: "m2", location: "tor1", windowStart: T, checks: 1, failures: 0, p50Ms: 50, p95Ms: 50, maxMs: 50 },
    ]);
  });
});

describe("merged", () => {
  it("is one row a key, combined as the database combines a row with the one stored", () => {
    const row = { monitorId: "mon_a", location: "tor1", windowStart: 600, checks: 1, failures: 0, p50Ms: 100, p95Ms: 100, maxMs: 100 };
    const rest = { ...row, checks: 4, failures: 1, p50Ms: 200, p95Ms: 400, maxMs: 500 };
    const other = { ...row, location: "sfo3" };
    const later = { ...row, windowStart: 900 };
    expect(merged([row, other, rest, later])).toEqual([
      { ...row, checks: 5, failures: 1, p50Ms: 175, p95Ms: 400, maxMs: 500 },
      other,
      later,
    ]);
    // A part with no passes, or no times, leaves the other's.
    expect(merged([{ ...row, failures: 1, p50Ms: null, p95Ms: null, maxMs: null }, rest])).toEqual([{ ...rest, checks: 5, failures: 2 }]);
    expect(merged([])).toEqual([]);
  });
});
