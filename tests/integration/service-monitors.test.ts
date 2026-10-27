import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Store, type Monitor } from "../../probe/store";
import { probeDatabase, servicePool } from "../support/probe-database";
import { headerContext, seal } from "@/lib/seal";
import { STRIPE_CRITICAL } from "@/lib/service-monitor";
import { judgeStripe, type StripeObservation } from "@/checks/stripe";

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
if (url && !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw Error("Local Postgres only");
if (!url) console.warn('[integration] SKIPPED "service monitors": PROBE_DATABASE_URL is not set; no database was reached.');
const suite = url ? describe : describe.skip;
const key = randomBytes(32);
const credential = "rk_test_abcdefghijklmnop123456789";
const config = { endpoints: ["we_one"], critical: STRIPE_CRITICAL, failureThreshold: 3, windowMin: 30, pendingMin: 30 };
const id = () => `mon_${randomBytes(12).toString("hex")}`;

suite("service monitors on the real database", () => {
  let database: Awaited<ReturnType<typeof probeDatabase>>;
  let service: Awaited<ReturnType<typeof probeDatabase>>;
  let sql: ReturnType<typeof servicePool>;
  let store: Store;
  let ws: string;
  let other: string;
  let app: string;
  let otherApp: string;
  beforeAll(async () => {
    database = await probeDatabase(url);
    service = await probeDatabase(url, "service_role");
    sql = servicePool(service.probeUrl);
    store = Store.connect(database.probeUrl, key);
    const work = async () => {
      const w = (await database.admin.query("insert into public.workspaces(clerk_org_id) values($1) returning id", [`org_service${randomBytes(6).toString("hex")}`])).rows[0].id as string;
      const a = (await database.admin.query("insert into public.apps(workspace_id,name) values($1,'Service tests') returning id", [w])).rows[0].id as string;
      return [w, a];
    };
    [ws, app] = await work(); [other, otherApp] = await work();
  });
  beforeEach(async () => { await database.admin.query("delete from public.monitors where workspace_id = any($1)", [[ws, other]]); });
  afterAll(async () => {
    if (database) await database.admin.query("delete from public.workspaces where id = any($1)", [[ws, other]]);
    await store?.close(); await sql?.end(); await service?.close(); await database?.close();
  });
  const save = async (mon = id(), overrides: Record<string, unknown> = {}) => {
    const p = { ws, mon, app, type: "stripe", target: "https://api.stripe.com", config, edit: false, max: 50, maxType: 1, perHost: 5, interval: 600, ...overrides };
    await sql.query("select public.save_service_monitor($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [p.ws, p.mon, p.app, p.type, "Service", p.target, JSON.stringify(p.config), seal(credential, headerContext(mon, "service-key"), key), p.edit, p.max, p.maxType, p.perHost, p.interval]);
    return mon;
  };
  const load = async (mon: string) => (await store.loadMonitors()).find(m => m.id === mon)!;
  const row = async (mon: string) => (await database.admin.query("select *, xmin::text as revision from public.monitors where id=$1", [mon])).rows[0];
  const apply = async (m: Monitor, observation: StripeObservation, at: number) => {
    const r = judgeStripe(config, observation);
    return store.apply({ monitorId: m.id, version: m.version, atSec: at,
      outcome: { first: { ...r, ms: 1, location: "tor1", detail: { ...r.detail, observation } }, confirm: { ...r, ms: 1, location: "sfo3", detail: { ...r.detail, observation } } } });
  };

  it("enforces the per-type quota under a race and refuses missing quotas", async () => {
    const results = await Promise.allSettled([save(), save()]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { message: "service_monitor_limit" } });
    await expect(save(id(), { maxType: null })).rejects.toMatchObject({ message: "limits_required" });
  });
  it("scopes create and edit, and never lets a probe change configuration or read credentials directly", async () => {
    await expect(save(id(), { app: otherApp })).rejects.toMatchObject({ code: "PT404" });
    const mon = await save();
    await expect(save(mon, { ws: other, app: otherApp, edit: true })).rejects.toMatchObject({ code: "PT404" });
    await expect(store.pool.query("select * from public.monitor_secrets")).rejects.toMatchObject({ code: "42501" });
    await expect(store.pool.query("update public.monitors set config='{}' where id=$1", [mon])).rejects.toMatchObject({ code: "42501" });
    const loaded = await load(mon);
    expect(loaded.headers).toEqual({ "service-key": credential });
    const raw = (await store.pool.query("select * from public.probe_load_service_monitors($1)", [[ws]])).rows;
    expect(JSON.stringify(raw)).not.toContain(credential);
    expect((await store.pool.query("select * from public.probe_load_monitors($1)", [[ws]])).rows).toEqual([]);
    const foreignFilter = (await store.pool.query("select * from public.probe_load_service_monitors($1)", [[other]])).rows;
    expect(foreignFilter).toEqual([]);
  });
  it("opens one incident naming event types, persists recovery across homes, and never reopens old terminal failures", async () => {
    const mon = await save(); const m = await load(mon);
    const at = Math.ceil(Number(m.version) / 1e6) + 1;
    const observation = { at, disabled: [], events: [{ id: "evt_failed", type: "invoice.paid", created: at - 60, pending: 0 }] };
    await apply(m, observation, at);
    let incidents = (await database.admin.query("select * from public.incidents where monitor_id=$1", [mon])).rows;
    expect(incidents).toHaveLength(1); expect(incidents[0].evidence.summary).toContain("invoice.paid");
    expect((await row(mon)).state).toBe("down");
    await apply(await load(mon), observation, at + 600);
    expect((await row(mon)).state).toBe("down");
    await apply(await load(mon), observation, at + 1200);
    expect((await row(mon)).state).toBe("up");
    const revision = (await row(mon)).revision;
    await apply(await load(mon), observation, at + 1800);
    expect((await row(mon)).revision).toBe(revision); // No row per steady check.
    incidents = (await database.admin.query("select * from public.incidents where monitor_id=$1", [mon])).rows;
    expect(incidents).toHaveLength(1); expect(incidents[0].resolved_at).not.toBeNull();
    expect((await database.admin.query("select count(*)::int as n from public.alert_events where incident_id=$1", [incidents[0].id])).rows[0].n).toBeGreaterThanOrEqual(2);
  });
  it("loads Supabase backoff evidence from failures and the incident, and recovers without clearing a marker", async () => {
    const mon = await save(id(), { type: "supabase", target: "https://abcdefghijklmnopqrst.supabase.co", config: { projectUrl: "https://abcdefghijklmnopqrst.supabase.co", databaseRead: "health" }, interval: 180 });
    const m = await load(mon); const at = Math.ceil(Number(m.version) / 1e6) + 1;
    const f = { ok: false, ms: 1, status: 401, failure: { kind: "status" as const, message: "Database read refused" } };
    await store.apply({ monitorId: mon, version: m.version, atSec: at, outcome: { first: { ...f, location: "tor1" }, confirm: { ...f, location: "sfo3" } } });
    expect((await load(mon)).config).toMatchObject({ __state: "down", __failureStatus: 401, __incidentStatus: 401,
      __outcomeAt: at, __runtime: { pausedOrDeleted: false } });
    expect((await row(mon)).service_runtime).not.toHaveProperty("rejected");
    // The incident still explains the down state if failure history has been purged.
    await database.admin.query("delete from public.check_failures where monitor_id=$1", [mon]);
    expect((await load(mon)).config).toMatchObject({ __failureStatus: null, __incidentStatus: 401 });
    for (const delta of [1800, 3600]) {
      await store.apply({ monitorId: mon, version: m.version, atSec: at + delta,
        outcome: { first: { ok: true, ms: 1, location: "tor1" } } });
    }
    expect((await load(mon)).config).toMatchObject({ __state: "up", __incidentStatus: null,
      __outcomeAt: at + 3600 });
    await sql.query("select public.pause_monitor($1,$2,$3,$4)", [ws, mon, 5, "Test"]);
    await sql.query("select public.resume_monitor($1,$2)", [ws, mon]);
    expect((await load(mon)).config.__runtime).toEqual({ pausedOrDeleted: false });
    await save(mon, { type: "supabase", edit: true, target: "https://abcdefghijklmnopqrst.supabase.co", config: { projectUrl: "https://abcdefghijklmnopqrst.supabase.co", databaseRead: "health" }, interval: 180 });
    expect((await load(mon)).config.__runtime).toEqual({});
    expect((await row(mon)).state).toBe(null);
    await sql.query("select public.delete_monitor($1,$2)", [ws, mon]);
    expect((await database.admin.query("select * from public.monitor_secrets where monitor_id=$1", [mon])).rows).toEqual([]);
  });
  it("updates the paused-or-deleted label as the failure changes, without returning internal runtime", async () => {
    const mon = await save(id(), { type: "supabase", target: "https://abcdefghijklmnopqrst.supabase.co", config: { projectUrl: "https://abcdefghijklmnopqrst.supabase.co", databaseRead: "" }, interval: 180 });
    const m = await load(mon); const at = Math.ceil(Number(m.version) / 1e6) + 1;
    const failed = async (kind: "project_paused" | "timeout", t: number) => {
      const r = { ok: false, ms: 1, failure: { kind, message: kind } };
      await store.apply({ monitorId: mon, version: m.version, atSec: t,
        outcome: { first: { ...r, location: "tor1" }, confirm: { ...r, location: "sfo3" } } });
    };
    const snapshot = async () => (await sql.query("select public.workspace_snapshot($1) as s", [ws])).rows[0].s.monitors[0];
    await failed("project_paused", at);
    expect(await snapshot()).toMatchObject({ state: "down", service_status: "paused_or_deleted" });
    expect(await snapshot()).not.toHaveProperty("service_runtime");
    await failed("timeout", at + 180);
    expect(await snapshot()).toMatchObject({ state: "down", service_status: null });
    await failed("project_paused", at + 360);
    expect(await snapshot()).toMatchObject({ service_status: "paused_or_deleted" });
  });

  it("fails closed on arbitrary config, invalid read paths and invented intervals", async () => {
    await expect(save(id(), { config: { ...config, key: credential } })).rejects.toMatchObject({ message: "service_config_invalid" });
    await expect(save(id(), { interval: 61 })).rejects.toMatchObject({ message: "interval_not_allowed" });
    await expect(save(id(), { type: "supabase", target: "https://abcdefghijklmnopqrst.supabase.co", config: { projectUrl: "https://abcdefghijklmnopqrst.supabase.co", databaseRead: "../" }, interval: 180 })).rejects.toMatchObject({ message: "service_config_invalid" });
  });
});
