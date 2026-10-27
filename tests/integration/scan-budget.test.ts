import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { probeDatabase, servicePool } from "../support/probe-database";
const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
if (url && !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw Error("Local Postgres only");
if (!url) console.warn('[integration] SKIPPED "scan budgets": PROBE_DATABASE_URL is not set; no database was reached.');
(url ? describe : describe.skip)("033 scan admission on local Postgres", () => {
  let service: Awaited<ReturnType<typeof probeDatabase>>; let sql: ReturnType<typeof servicePool>;
  const key = (kind = "ip") => `${kind}:${randomBytes(32).toString("hex")}`;
  const admit = async (actor: string) => (await sql.query("select public.admit_scan($1) as wait", [actor])).rows[0].wait as number;
  beforeAll(async () => { service = await probeDatabase(url, "service_role"); sql = servicePool(service.probeUrl); });
  beforeEach(async () => { await service.admin.query("delete from public.scan_budgets"); });
  afterAll(async () => { await service?.admin.query("delete from public.scan_budgets"); await sql?.end(); await service?.close(); });
  it("serializes concurrent requests for one IP, and isolates another actor's allowance", async () => {
    const actor = key(); const answers = await Promise.all(Array.from({ length: 15 }, () => admit(actor)));
    expect(answers.filter(n => n === 0)).toHaveLength(5); expect(answers.filter(n => n > 0)).toHaveLength(10); expect(await admit(key())).toBe(0);
    expect((await sql.query("select used from public.scan_budgets where key='global'")).rows[0].used).toBe(6);
  });
  it("shares the global ceiling across anonymous and authenticated callers and removes expired keys", async () => {
    await admit(key()); await sql.query("update public.scan_budgets set used=99 where key='global'");
    const answers = await Promise.all([admit(key()), admit(key("agent")), admit(key())]); expect(answers.filter(n => n === 0)).toHaveLength(1);
    await sql.query("update public.scan_budgets set expires_at=now()-interval '1 second'"); expect(await admit(key())).toBe(0);
    expect((await sql.query("select count(*)::int n from public.scan_budgets")).rows[0].n).toBe(2);
  });
  it("uses a separate ten-scan credential ceiling and rejects missing or raw identity keys", async () => {
    const actor = key("agent"); for (let i=0; i<10; i++) expect(await admit(actor)).toBe(0); expect(await admit(actor)).toBeGreaterThan(0);
    for (const invalid of [null, "1.2.3.4", "ip:1.2.3.4", "global"]) await expect(sql.query("select public.admit_scan($1)", [invalid])).rejects.toMatchObject({ code: "22023" });
  });
  it("keeps RLS deny-all, invoker execution, and no grants for anonymous or authenticated clients", async () => {
    const r = (await service.admin.query("select c.relrowsecurity, (select count(*)::int from pg_policy p where p.polrelid=c.oid) policies from pg_class c where c.oid='public.scan_budgets'::regclass")).rows[0];
    expect(r).toEqual({ relrowsecurity: true, policies: 0 });
    for (const role of ["anon", "authenticated", "probe", "edge", "ingest"]) {
      const p = (await service.admin.query("select has_table_privilege($1,'public.scan_budgets','SELECT') as read, has_function_privilege($1,'public.admit_scan(text)','EXECUTE') as execute", [role])).rows[0]; expect(p).toEqual({ read: false, execute: false });
    }
  });
});
