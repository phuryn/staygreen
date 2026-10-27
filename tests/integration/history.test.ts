import { afterAll, beforeAll, expect, it } from "vitest";
import { measuredById, monitorHistoryDto, monitorHistoryOf, workspaceHistoryDto } from "@/lib/history";
import { limits } from "@/lib/plans";
import { snapshotDto } from "@/lib/public-page";
import { lastLine } from "@/components/MonitorTable";
import { monitor as monitorShape } from "../unit/fixtures";
import { clientFor, describeTarget, expectOk, Fixtures, hex, httpMonitor, readTarget } from "../support/integration";

/* What the probes measured, read back (migration 014): `workspace_history` for the dashboard's
   snapshot, `monitor_history` for one monitor's page, the `rollups_1d` days the trigger on
   `rollups_5m` keeps, and the days on a status page's components. The rows are written as the
   probe writes them, straight into 013's tables, and each read is parsed by the DTO the app
   parses it with.

   Needs 014 applied to the development project; until then the first test says so. */

const target = readTarget();

const SLOT = 300_000;
const DAY_MS = 86_400_000;
const utcDay = (t: number) => Math.floor(t / DAY_MS);
const iso = (t: number) => new Date(t).toISOString();

describeTarget("probe history: the dashboard's and the status page's numbers", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);
  const secret = `itest-detail-${hex(6)}`;

  let A: { id: string }, B: { id: string };
  let measured: Record<string, any>, quiet: Record<string, any>, other: Record<string, any>;
  let page: Record<string, any>;
  // Two closed windows in the last quarter hour, and one three days back.
  const now = Date.now();
  const w1 = Math.floor(now / SLOT) * SLOT - 2 * SLOT;
  const w2 = w1 + SLOT;
  const old = w1 - 3 * DAY_MS;

  const history = async (ws: string) => workspaceHistoryDto.parse(expectOk(await db.rpc("workspace_history", { p_workspace_id: ws })));
  const one = async (ws: string, id: string) => monitorHistoryDto.parse(expectOk(await db.rpc("monitor_history", { p_workspace_id: ws, p_monitor_id: id })));
  const day = async (id: string, t: number) =>
    (await db.from("rollups_1d").select("windows, checks, failures").eq("monitor_id", id).eq("day", iso(t).slice(0, 10)).maybeSingle()).data;
  // Every monitor a workspace has, its automatic SSL monitors included.
  const idsOf = async (ws: string) => ((await db.from("monitors").select("id").eq("workspace_id", ws)).data ?? []).map((r) => r.id).sort();

  beforeAll(async () => {
    A = await fx.workspace();
    B = await fx.workspace();
    const app = await fx.app(A.id);
    const appB = await fx.app(B.id);
    measured = await fx.monitor(httpMonitor(A.id, app.id, `itest-${hex(4)}.example.com`, limits.free));
    quiet = await fx.monitor(httpMonitor(A.id, app.id, `itest-${hex(4)}.example.com`, limits.free));
    other = await fx.monitor(httpMonitor(B.id, appB.id, `itest-${hex(4)}.example.com`, limits.free));

    // A probe sets the state; both of A's monitors are up, and only one has windows.
    for (const id of [measured.id, quiet.id]) {
      const res = await db.from("monitors").update({ state: "up", state_since: iso(now - DAY_MS) }).eq("id", id);
      if (res.error) throw new Error(`fixture state failed: ${res.error.code}`);
    }
    const rows = [
      { monitor_id: measured.id, location: "tor1", window_start: iso(w1), checks: 5, failures: 0, p50_ms: 100, p95_ms: 200, max_ms: 250 },
      { monitor_id: measured.id, location: "sfo3", window_start: iso(w1), checks: 5, failures: 1, p50_ms: 150, p95_ms: 400, max_ms: 900 },
      { monitor_id: measured.id, location: "tor1", window_start: iso(w2), checks: 5, failures: 0, p50_ms: 110, p95_ms: 210, max_ms: 260 },
      { monitor_id: measured.id, location: "tor1", window_start: iso(old), checks: 4, failures: 0, p50_ms: 90, p95_ms: 120, max_ms: 130 },
      { monitor_id: other.id, location: "tor1", window_start: iso(w1), checks: 5, failures: 5, p50_ms: null, p95_ms: null, max_ms: null },
    ];
    const ins = await db.from("rollups_5m").insert(rows);
    if (ins.error) throw new Error(`fixture rollups_5m failed: ${ins.error.code} ${ins.error.message}`);
    const f = await db.from("check_failures").insert({
      monitor_id: measured.id, location: "sfo3", at: iso(w1 + 60_000), kind: "status", message: "Returned 503", status: 503, ms: 80, snippet: "<h1>503</h1>", detail: { secret },
    });
    if (f.error) throw new Error(`fixture check_failures failed: ${f.error.code}`);
    const tr = await db.from("transitions").insert({ monitor_id: measured.id, from_state: null, to_state: "up", at: iso(w1) });
    if (tr.error) throw new Error(`fixture transitions failed: ${tr.error.code}`);
    // A one-minute outage, closed, inside the last day.
    await fx.incident(A.id, measured.id, { opened_at: iso(w2), resolved_at: iso(w2 + 60_000) });

    page = await fx.page(A.id, app.id);
    page = await fx.savePage(page as never, [{ name: "API", monitorIds: [measured.id, quiet.id] }]);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("is applied: migration 014's readers exist", async () => {
    const res = await db.rpc("workspace_history", { p_workspace_id: A.id });
    expect(res.error?.code, "apply supabase/migrations/20261022113447_probe_history.sql to the development project first").toBeUndefined();
  });

  it("keeps each UTC day in rollups_1d as the windows arrive, and merges a window written twice", async () => {
    const same = utcDay(w1) === utcDay(w2);
    expect(await day(measured.id, w1)).toEqual({ windows: same ? 2 : 1, checks: same ? 15 : 10, failures: 1 });
    expect(await day(measured.id, old)).toEqual({ windows: 1, checks: 4, failures: 0 });

    // A probe restarting flushes its window again: the merge adds what it added, and no window.
    // The old day's, so the last 24 hours the tests below read stay as written.
    const up = await db.from("rollups_5m").upsert({ monitor_id: measured.id, location: "tor1", window_start: iso(old), checks: 6, failures: 1, p50_ms: 90, p95_ms: 120, max_ms: 130 });
    expect(up.error).toBeNull();
    expect(await day(measured.id, old)).toEqual({ windows: 1, checks: 6, failures: 1 });
  });

  it("reads every monitor of the workspace, and only its own", async () => {
    const h = await history(A.id);
    expect(h.monitors.map((m) => m.id).sort()).toEqual(await idsOf(A.id));
    expect(h.monitors.map((m) => m.id)).toEqual(expect.arrayContaining([measured.id, quiet.id]));
    expect(h.monitors.map((m) => m.id)).not.toContain(other.id);
    expect((await history(B.id)).monitors.map((m) => m.id).sort()).toEqual(await idsOf(B.id));
  });

  it("gives each location's newest window, the last day's coverage, outage and p95, and the days with a window", async () => {
    const h = await history(A.id);
    const m = h.monitors.find((x) => x.id === measured.id)!;
    expect(m.latest.map((l) => [l.loc, Date.parse(l.end)])).toEqual([
      ["tor1", w2 + SLOT],
      ["sfo3", w1 + SLOT],
    ]);
    // Two windows, each standing for 5 minutes (the Free interval is 3, below the window).
    expect(m.day).toEqual({ covered: 600, down: 60 });
    expect(m.p95).toBe(400);
    const today = utcDay(Date.parse(`${h.today}T00:00:00Z`));
    expect(m.days.map(([age]) => age).sort((a, b) => a - b)).toEqual([...new Set([today - utcDay(w1), today - utcDay(w2), today - utcDay(old)])].sort((a, b) => a - b));
    // The old day: one window, no outage. The outage's day: under 100, never rounded up to it.
    expect(m.days.find(([age]) => age === today - utcDay(old))?.[1]).toBe(100);
    expect(m.days.find(([age]) => age === today - utcDay(w2))?.[1]).toBeLessThan(100);
    expect(m.days.every(([, up]) => up >= 0 && up <= 100)).toBe(true);
  });

  it("reads an up monitor with no window as up with no data, never as not checked", async () => {
    const h = await history(A.id);
    const row = h.monitors.find((x) => x.id === quiet.id)!;
    expect(row).toMatchObject({ days: [], day: { covered: 0, down: 0 }, month: { covered: 0, down: 0 }, p95: null, latest: [] });
    const got = measuredById(h, Date.now()).get(quiet.id)!;
    expect(got.uptime.day.pct).toBeNull();
    expect(got.daily.every((v) => v === -1)).toBe(true);
    expect(lastLine(monitorShape({ id: quiet.id, state: "up", checked: true, ...got }), Date.now()).main).toBe("No data yet");
  });

  it("gives one monitor's page its merged windows, failures and state changes, and none of another workspace's", async () => {
    const h = await one(A.id, measured.id);
    expect(h).not.toBeNull();
    const p1 = h!.points.find((p) => Date.parse(p.t) === w1)!;
    // Both locations in one point; the median weighted by each one's passing checks.
    expect(p1).toMatchObject({ checks: 10, failures: 1, p95: 400 });
    expect(p1.p50).toBe(Math.round((100 * 5 + 150 * 4) / 9));
    expect(h!.points.map((p) => Date.parse(p.t))).toEqual([w1, w2]);
    expect(h!.failures).toEqual([expect.objectContaining({ loc: "sfo3", message: "Returned 503", status: 503, snippet: "<h1>503</h1>" })]);
    expect(h!.transitions).toEqual([{ at: expect.any(String), from: null, to: "up" }]);
    expect(monitorHistoryOf(h).events.map((e) => e.kind)).toEqual(["fail", "pass"]);

    expect(await one(B.id, measured.id)).toBeNull();
    expect(await one(A.id, other.id)).toBeNull();
  });

  it("never returns a failure's detail", async () => {
    const raw = expectOk(await db.rpc("monitor_history", { p_workspace_id: A.id, p_monitor_id: measured.id }));
    expect(JSON.stringify(raw)).not.toContain(secret);
  });

  it("puts the days on the status page's component, the worst monitor's, with no monitor in them", async () => {
    const s = expectOk(await db.rpc("public_status_snapshot", { p_slug: page.slug })) as Record<string, any>;
    const parsed = snapshotDto.parse(s);
    const daily = parsed.components[0].daily;
    expect(daily.map((d) => d.d)).toContain(iso(old).slice(0, 10));
    expect(Object.keys(s.components[0].daily[0]).sort()).toEqual(["d", "up"]);
    expect(JSON.stringify(s)).not.toContain(measured.id);
    expect(JSON.stringify(s)).not.toContain(quiet.id);
  });
});
