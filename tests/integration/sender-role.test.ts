import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeDatabase } from "../support/probe-database";
import { checkSenderLogin, SENDER_FUNCTIONS } from "../support/sender-login";

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
if (!url) console.warn('[integration] SKIPPED "sender role": PROBE_DATABASE_URL is not set. No database reached.');
const suite = url ? describe : describe.skip;

suite("sender role and private API (027 and 028)", () => {
  let db: Awaited<ReturnType<typeof probeDatabase>>;
  let pool: pg.Pool;
  beforeAll(async () => {
    db = await probeDatabase(url, "alert_sender");
    pool = new pg.Pool({ connectionString: db.probeUrl });
  });
  afterAll(async () => { await pool?.end(); await db?.close(); });

  it("holds only eight function capabilities, no table/sequence/CREATE grants or elevated role attributes", async () => {
    await checkSenderLogin(db.probeUrl);
    await expect(pool.query("select * from public.alert_channels")).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("select * from public.monitor_secrets")).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("select public.alert_pending_events(1,null)")).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("select public.delete_app('ws_fake','app_fake')")).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("set role service_role")).rejects.toMatchObject({ code: "42501" });
  });
  it("enumerates the private schema: exact definers, empty paths, owner and grants; no browser or other runtime access", async () => {
    const { rows } = await db.admin.query(`select p.oid::regprocedure::text as signature, p.prosecdef, p.proconfig,
      pg_get_userbyid(p.proowner) as owner,
      (select array_agg(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end order by a.grantee)::text[]
        from aclexplode(p.proacl) a where a.grantee<>p.proowner) as grants
      from pg_proc p where p.pronamespace='alert_sender'::regnamespace order by 1`);
    expect(rows.map((r) => r.signature)).toEqual(SENDER_FUNCTIONS);
    for (const r of rows) expect(r).toMatchObject({ prosecdef: true, proconfig: ['search_path=""'], owner: "postgres", grants: ["alert_sender"] });
    for (const role of ["anon", "authenticated", "service_role", "probe", "ingest", "watchdog"]) {
      const { rows: [r] } = await db.admin.query("select has_schema_privilege($1,'alert_sender','USAGE,CREATE') as access", [role]);
      expect(r.access, role).toBe(false);
    }
    expect((await db.admin.query("select relname from pg_class where relnamespace='alert_sender'::regnamespace")).rows).toEqual([]);
  });
  it("does not silently grant future functions to PUBLIC or to the sender", async () => {
    const c = await db.admin.connect();
    try {
      await c.query("begin");
      await c.query("create function alert_sender.future_boundary_test() returns integer language sql as 'select 1'");
      const { rows } = await c.query(`select role from unnest(array['anon','authenticated','service_role','probe','ingest','watchdog','alert_sender']) role
        where has_function_privilege(role,'alert_sender.future_boundary_test()','EXECUTE')`);
      expect(rows).toEqual([]);
    } finally { await c.query("rollback"); c.release(); }
  });
});
