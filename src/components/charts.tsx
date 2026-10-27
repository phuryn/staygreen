"use client";

// Charts drawn per the dataviz method: thin marks, a legend for two series, a hover layer with
// a crosshair, a table view, and status colours only where they carry status.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Incident, Point } from "@/lib/model";
import { ms, pct, time } from "@/lib/format";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// ---------- response times ----------
/** `stepMs` is how far apart the windows should be: a longer gap, when no probe reported, breaks
 *  the lines instead of drawing a time nobody measured. */
export function ResponseChart({ points, incidents, slowMs, stepMs = 300_000, height = 220 }: { points: Point[]; incidents: Incident[]; slowMs?: number; stepMs?: number; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const pad = { l: 44, r: 12, t: 12, b: 26 };
  // A window whose checks all failed has no response time: it has a failure mark on the baseline
  // and breaks the lines, which never join across it.
  const data = points.filter((p) => p.checks > 0);
  const t0 = points[0]?.t ?? 0;
  const t1 = points[points.length - 1]?.t ?? 1;
  // Scale to the data. The slow threshold joins the scale only when the data comes near it,
  // so a 1.5 s threshold doesn't flatten a 200 ms API into the baseline.
  const dataMax = Math.max(300, ...data.map((p) => p.p95 ?? 0));
  const maxV = slowMs && dataMax > slowMs * 0.6 ? Math.max(dataMax, slowMs * 1.1) : dataMax * 1.15;
  const niceMax = niceCeil(maxV);
  const iw = Math.max(10, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * iw;
  const y = (v: number) => pad.t + ih - (v / niceMax) * ih;
  const line = (key: "p50" | "p95") => {
    let d = "";
    let last = -Infinity;
    for (const p of data) {
      const v = p[key];
      if (v == null) { last = -Infinity; continue; }
      d += `${p.t - last <= 2 * stepMs ? "L" : "M"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
      last = p.t;
    }
    return d;
  };
  const ticks = [0, niceMax / 2, niceMax];
  const hourTicks = useMemo(() => {
    const out: number[] = [];
    const first = Math.ceil(t0 / (6 * 3600_000)) * 6 * 3600_000;
    for (let t = first; t <= t1; t += 6 * 3600_000) out.push(t);
    return out;
  }, [t0, t1]);
  const bands = incidents.filter((i) => (i.resolvedAt ?? t1) > t0 && i.openedAt < t1);
  const hp = hover != null ? data[hover] : null;

  return (
    <figure className="chart">
      <div className="chart-head">
        <ul className="legend" aria-label="Series">
          <li><span className="swatch" style={{ background: "var(--chart-p50)" }} />Median (p50)</li>
          <li><span className="swatch" style={{ background: "var(--chart-p95)" }} />Slowest 5% (p95)</li>
          {bands.length > 0 && <li><span className="swatch swatch-band" />Incident</li>}
          {slowMs && slowMs >= niceMax && <li className="t-3">Slow above {ms(slowMs)}, above this range</li>}
        </ul>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => setAsTable((v) => !v)} aria-pressed={asTable}>
          {asTable ? "Show chart" : "Show table"}
        </button>
      </div>
      {asTable ? (
        <div className="scroll-x chart-table">
          <table className="table">
            <thead><tr><th>Hour</th><th className="r">p50</th><th className="r">p95</th><th className="r">Failed checks</th></tr></thead>
            <tbody>
              {hourly(data).map((r) => (
                <tr key={r.t}><td className="num">{time(r.t)}</td><td className="r num">{ms(r.p50)}</td><td className="r num">{ms(r.p95)}</td><td className="r num">{r.fails}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="chart-plot" style={{ height }}>
          {w > 0 && (
            <svg width={w} height={height} role="img" aria-label="Response times over the last 24 hours"
              onMouseLeave={() => setHover(null)}
              onMouseMove={(e) => {
                const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
                const px = e.clientX - r.left;
                let best = 0, bd = Infinity;
                data.forEach((p, i) => { const d = Math.abs(x(p.t) - px); if (d < bd) { bd = d; best = i; } });
                setHover(best);
              }}>
              {ticks.map((v) => (
                <g key={v}>
                  <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="var(--chart-grid)" strokeWidth="1" />
                  <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" className="axis">{ms(v)}</text>
                </g>
              ))}
              {hourTicks.map((t) => (
                <text key={t} x={x(t)} y={height - 6} textAnchor="middle" className="axis">{time(t)}</text>
              ))}
              {bands.map((b) => {
                const a = Math.max(x(b.openedAt), pad.l);
                const z = Math.min(x(b.resolvedAt ?? t1), w - pad.r);
                return (
                  <g key={b.id}>
                    <rect x={a} y={pad.t} width={Math.max(3, z - a)} height={ih} fill="var(--chart-band)" />
                    <rect x={a} y={pad.t} width={2} height={ih} fill="var(--down)" />
                  </g>
                );
              })}
              {slowMs && slowMs < niceMax && (
                <g>
                  <line x1={pad.l} x2={w - pad.r} y1={y(slowMs)} y2={y(slowMs)} stroke="var(--warn)" strokeWidth="1" strokeDasharray="3 4" />
                  <text x={w - pad.r} y={y(slowMs) - 5} textAnchor="end" className="axis">Slow above {ms(slowMs)}</text>
                </g>
              )}
              <path d={line("p95")} fill="none" stroke="var(--chart-p95)" strokeWidth="2" strokeLinejoin="round" />
              <path d={line("p50")} fill="none" stroke="var(--chart-p50)" strokeWidth="2" strokeLinejoin="round" />
              {data.filter((p) => p.fails > 0).map((p) => (
                <rect key={p.t} x={x(p.t) - 4} y={y(p.p50 ?? 0) - 4} width="8" height="8" rx="1.5" fill="var(--down)" stroke="var(--surface)" strokeWidth="2" />
              ))}
              {hp && (
                <g>
                  <line x1={x(hp.t)} x2={x(hp.t)} y1={pad.t} y2={pad.t + ih} stroke="var(--edge)" strokeWidth="1" />
                  {hp.p50 != null && <circle cx={x(hp.t)} cy={y(hp.p50)} r="4.5" fill="var(--chart-p50)" stroke="var(--surface)" strokeWidth="2" />}
                  {hp.p95 != null && <circle cx={x(hp.t)} cy={y(hp.p95)} r="4.5" fill="var(--chart-p95)" stroke="var(--surface)" strokeWidth="2" />}
                </g>
              )}
            </svg>
          )}
          {hp && (
            <div className="tip" style={{ left: Math.min(Math.max(x(hp.t), 90), w - 90), top: 4 }}>
              <strong className="num">{time(hp.t)}</strong>
              <span>p50 <b className="num">{ms(hp.p50)}</b></span>
              <span>p95 <b className="num">{ms(hp.p95)}</b></span>
              {hp.fails > 0 && <span className="t-down">{hp.fails === hp.checks ? `All ${hp.checks} failed` : `${hp.fails} of ${hp.checks} failed`}</span>}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

/** The table view's rows, newest hour first: the median weighted by passing checks, the slowest
 *  window's p95, and every failed check. An hour whose checks all failed has no times. */
export function hourly(points: Point[]) {
  const by = new Map<number, Point[]>();
  for (const p of points) {
    const h = Math.floor(p.t / 3600_000) * 3600_000;
    by.set(h, [...(by.get(h) ?? []), p]);
  }
  return [...by.entries()].sort((a, b) => b[0] - a[0]).map(([t, ps]) => {
    const timed = ps.filter((p) => p.p50 != null && p.checks > p.fails);
    const passed = timed.reduce((a, p) => a + p.checks - p.fails, 0);
    const p95s = ps.flatMap((p) => (p.p95 == null ? [] : [p.p95]));
    return {
      t,
      p50: passed ? timed.reduce((a, p) => a + (p.p50 ?? 0) * (p.checks - p.fails), 0) / passed : null,
      p95: p95s.length ? Math.max(...p95s) : null,
      fails: ps.reduce((a, p) => a + p.fails, 0),
    };
  });
}

function niceCeil(v: number) {
  const steps = [200, 400, 500, 800, 1000, 1500, 2000, 3000, 4000, 5000, 8000, 10000, 15000, 20000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 5000) * 5000;
}

// ---------- 90-day bars ----------
/** Exactly `days` bars, oldest first. A day with no window is -1: no data, never 100%. */
export const padDays = (daily: number[], days: number) =>
  daily.length >= days ? daily.slice(-days) : [...Array.from({ length: days - daily.length }, () => -1), ...daily];

export function UptimeBars({ daily, now, label, height = 34, compact }: { daily: number[]; now: number; label: string; height?: number; compact?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  // Each bar is a UTC day, as the database counts it (`history.ts`), so its label is too: a local
  // date would put an evening's outage under the wrong day for anyone west or east of UTC.
  const dayOf = (t: number) => `${new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} (UTC)`;
  const days = daily.length;
  const known = daily.filter((v) => v >= 0);
  // No day with a check is no uptime to claim, not 100%.
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  const dayAt = (i: number) => now - (days - 1 - i) * 86_400_000;
  return (
    <div className="bars-wrap">
      <div className="bars" style={{ height }} role="img" aria-label={avg === null ? `${label}: no data yet` : `${label}: ${pct(avg)} uptime over ${days} days`} onMouseLeave={() => setHover(null)}>
        {daily.map((v, i) => (
          <span
            key={i}
            className={`bar ${v < 0 ? "none" : v >= 99.95 ? "up" : v >= 99 ? "dip" : "down"}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            tabIndex={compact ? -1 : 0}
            aria-label={`${dayOf(dayAt(i))}: ${v < 0 ? "no data" : pct(v)}`}
            title={`${dayOf(dayAt(i))}: ${v < 0 ? "No data" : `${pct(v)} uptime`}`}
          />
        ))}
        {hover != null && (
          <div className="tip tip-bar" style={{ left: `${((hover + 0.5) / days) * 100}%` }}>
            <strong>{dayOf(dayAt(hover))}</strong>
            <span className="num">{daily[hover] < 0 ? "No data" : `${pct(daily[hover])} up`}</span>
            {daily[hover] >= 0 && daily[hover] < 99.95 && <span className="t-meta">{daily[hover] < 99 ? "Outage that day" : "Short outage"}</span>}
          </div>
        )}
      </div>
      {!compact && (
        <div className="bars-foot t-meta">
          <span>{days} days ago</span>
          <span className="num">{avg === null ? "No data yet" : `${pct(avg)} uptime`}</span>
          <span>Today</span>
        </div>
      )}
    </div>
  );
}

// ---------- sparkline ----------
export function Spark({ values, width = 96, height = 24, label }: { values: number[]; width?: number; height?: number; label: string }) {
  const v = values.filter((x) => x > 0);
  if (v.length < 2) return <span className="t-meta">—</span>;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = Math.max(1, max - min);
  const d = v.map((p, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((p - min) / span) * (height - 4)).toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="spark">
      <path d={d} fill="none" stroke="var(--chart-p50)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
