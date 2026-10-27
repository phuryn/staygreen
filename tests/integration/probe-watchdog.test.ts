import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeDatabase } from "../support/probe-database";
import { Store } from "../../probe/store";
import { WATCHDOG_FUNCTIONS } from "../support/probe-functions";

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
if (!url) console.warn('[integration] SKIPPED "probe watchdog": PROBE_DATABASE_URL is not set. No database reached.');
const suite = url ? describe : describe.skip;

suite("probe flush receipts and read-only watchdog login (025)", () => {
  let probes: Awaited<ReturnType<typeof probeDatabase>>;
  let watchdog: Awaited<ReturnType<typeof probeDatabase>>;
  let watcher: pg.Pool;
  let store: Store;
  const id = `watchdog-test-${randomBytes(6).toString("hex")}`;
  const missing = `${id}-missing`;
  beforeAll(async () => {
    probes = await probeDatabase(url); // Helper refuses non-local targets before connecting.
    watchdog = await probeDatabase(url, "watchdog");
    watcher = new pg.Pool({ connectionString: watchdog.probeUrl });
    store = Store.connect(probes.probeUrl, undefined, undefined, id);
    await store.heartbeat({ id, location: "tor1", builderOnly: false, url: "http://127.0.0.1:7070" });
  });
  afterAll(async () => {
    if (probes) {
      await probes.admin.query("delete from public.probe_flush_receipts where probe_id=$1", [id]);
      await probes.admin.query("delete from public.probes where id=$1", [id]);
    }
    await store?.close();
    await watcher?.end();
    await watchdog?.close();
    await probes?.close();
  });
  const status = async () => (await watcher.query("select * from public.watchdog_flush_status($1::text[])", [[id, missing]])).rows;

  it("has no table, sequence, other function, CREATE or elevated role privileges", async () => {
    const { rows } = await watcher.query(`select oid::regprocedure::text as signature from pg_proc
      where pronamespace='public'::regnamespace and has_function_privilege(current_user,oid,'EXECUTE') order by 1`);
    expect(rows.map((r) => r.signature)).toEqual(WATCHDOG_FUNCTIONS);
    const access = await watcher.query(`select c.relname from pg_class c where c.relnamespace='public'::regnamespace and
      case when c.relkind='S' then has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')
        when c.relkind in ('r','p','v','m') then has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        else false end`);
    expect(access.rows).toEqual([]);
    expect((await watcher.query("select has_schema_privilege(current_user,'public','CREATE') as allowed")).rows[0].allowed).toBe(false);
    expect((await watcher.query("select rolsuper,rolbypassrls,rolcreaterole from pg_roles where rolname=current_user")).rows[0])
      .toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
    await expect(watcher.query("select * from public.monitors")).rejects.toMatchObject({ code: "42501" });
    await expect(watcher.query("select public.probe_leave($1)", [id])).rejects.toMatchObject({ code: "42501" });
    await expect(store.pool.query("select * from public.watchdog_flush_status($1::text[])", [[id]])).rejects.toMatchObject({ code: "42501" });
  });
  it("records an empty flush; heartbeat/leave cannot refresh or erase it; unknown expected probes remain visible", async () => {
    expect((await status()).every((r) => r.age_sec === null)).toBe(true);
    await store.flushRollups([]);
    const first = (await status()).find((r) => r.id === id)!;
    expect(first.age_sec).toBeLessThan(5);
    await store.heartbeat({ id, location: "tor1", builderOnly: false, url: "http://127.0.0.1:7070" });
    await store.leave(id);
    const left = await status();
    expect(left.find((r) => r.id === id)?.flushed_at).toEqual(first.flushed_at);
    expect(left.find((r) => r.id === missing)?.age_sec).toBeNull();
    await store.heartbeat({ id, location: "tor1", builderOnly: false, url: "http://127.0.0.1:7070" });
    await probes.admin.query("update public.probe_flush_receipts set flushed_at=now()-interval '601 seconds' where probe_id=$1", [id]);
    expect((await status()).find((r) => r.id === id)?.age_sec).toBeGreaterThanOrEqual(600);
  });
  it("does not refresh a receipt when the underlying rollup call is rejected", async () => {
    const first = (await status()).find((r) => r.id === id)!.flushed_at;
    await expect(store.pool.query("select public.probe_flush_with_receipt($1,array[]::text[],array[]::text[],array[]::timestamptz[],array[1],array[]::int[],array[]::int[],array[]::int[],array[]::int[])", [id])).rejects.toMatchObject({ code: "22023" });
    expect((await status()).find((r) => r.id === id)!.flushed_at).toEqual(first);
  });
  it("leaves the old flush API callable for a rolling upgrade", async () => {
    await expect(store.pool.query("select public.probe_flush_rollups(array[]::text[],array[]::text[],array[]::timestamptz[],array[]::int[],array[]::int[],array[]::int[],array[]::int[],array[]::int[])")).resolves.toHaveProperty("rowCount", 1);
  });
  it("merges real windows and rolls back both the batch and its receipt on a constraint failure", async () => {
    const ws = (await probes.admin.query("insert into public.workspaces(clerk_org_id) values($1) returning id", [`org_${id.replace(/-/g, "")}`])).rows[0].id;
    try {
      const app = (await probes.admin.query("insert into public.apps(workspace_id,name) values($1,'receipt test') returning id", [ws])).rows[0].id;
      const monitor = (await probes.admin.query(`insert into public.monitors(workspace_id,app_id,type,name,target,target_host,interval_sec,config)
        values($1,$2,'http','receipt test','https://example.com','example.com',60,'{}') returning id`, [ws, app])).rows[0].id;
      const window = { monitorId: monitor, location: "tor1", windowStart: 1_800_000_000, checks: 2, failures: 0, p50Ms: 20, p95Ms: 30, maxMs: 30 };
      await store.flushRollups([window]);
      const first = (await status()).find((r) => r.id === id)!.flushed_at;
      await expect(store.flushRollups([{ ...window, windowStart: window.windowStart + 300 }, { ...window, windowStart: window.windowStart + 600, checks: 0 }])).rejects.toMatchObject({ code: "23514" });
      const rows = (await probes.admin.query("select checks from public.rollups_5m where monitor_id=$1", [monitor])).rows;
      expect(rows).toEqual([{ checks: 2 }]);
      expect((await status()).find((r) => r.id === id)!.flushed_at).toEqual(first);
    } finally { await probes.admin.query("delete from public.workspaces where id=$1", [ws]); }
  });
});
