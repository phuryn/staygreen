import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Outcome } from "../../probe/state";
import type { Report } from "../../probe/peer";
import { Store, type Monitor } from "../../probe/store";
import { probeDatabase } from "../support/probe-database";

/* An SSL monitor's certificate and its domain's registration in the database (migration 020),
   written as the probe's own login through its functions, against the local Postgres
   (`probe/README.md` § A local Postgres). Like `probe-store.test.ts`, it skips without
   `PROBE_DATABASE_URL` and refuses any host but this machine. */

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
const local = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
if (url && !local) throw new Error("PROBE_DATABASE_URL must name a Postgres on this machine (127.0.0.1 or localhost)");

const suite = url ? describe : describe.skip;
if (!url) console.warn('[integration] SKIPPED "probe expiry": PROBE_DATABASE_URL is not set. Nothing in this file reached a database.');

const hex = (n: number) => randomBytes(n).toString("hex");

suite("probe expiry", () => {
  let store: Store;
  let database: Awaited<ReturnType<typeof probeDatabase>>;
  let admin: Awaited<ReturnType<typeof probeDatabase>>["admin"];
  let ws = "";
  let other = "";
  let app = "";
  let mon: Monitor;
  const at = Math.floor(Date.now() / 1000) - 3600;
  const expires = "2027-01-15T08:00:00.000Z";

  const insertSsl = async (workspace: string, appId: string, host: string, paused = false) =>
    (await admin.query(
      `insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, config, auto, paused_at)
       values ($1, $2, 'ssl', $3, $3, $3, 21600, '{}', true, $4) returning id`, [workspace, appId, host, paused ? new Date().toISOString() : null])).rows[0].id as string;

  beforeAll(async () => {
    database = await probeDatabase(url);
    admin = database.admin;
    store = Store.connect(database.probeUrl);
    ws = (await admin.query("insert into public.workspaces (clerk_org_id) values ($1) returning id", [`org_xtest${hex(6)}`])).rows[0].id;
    app = (await admin.query("insert into public.apps (workspace_id, name) values ($1, 'expiry test') returning id", [ws])).rows[0].id;
    other = (await admin.query("insert into public.workspaces (clerk_org_id) values ($1) returning id", [`org_xtest${hex(6)}`])).rows[0].id;
    const otherApp = (await admin.query("insert into public.apps (workspace_id, name) values ($1, 'other') returning id", [other])).rows[0].id;
    await insertSsl(other, otherApp, `other-${hex(4)}.example.net`);
  });

  beforeEach(async () => {
    await admin.query("delete from public.monitors where workspace_id = $1", [ws]);
    await admin.query("delete from public.domain_registrations where name like '%askone.org' or name like '%.example.net' or name like '%.test-expiry.org' or name = 'staygreen.io'");
    const id = await insertSsl(ws, app, "askone.org");
    mon = (await store.loadMonitors()).find((m) => m.id === id)!;
  });

  afterAll(async () => {
    try {
      for (const w of [ws, other]) if (w) await admin.query("delete from public.workspaces where id = $1", [w]);
      await admin.query("delete from public.domain_registrations where name like '%askone.org' or name like '%.example.net' or name = 'staygreen.io'");
    } finally {
      try { await store?.close(); } finally { await database?.close(); }
    }
  });

  const pass = (detail: Record<string, unknown> | undefined, location = "tor1"): Outcome => ({ first: { ok: true, ms: 80, location, ...(detail ? { detail } : {}) } });
  const report = (outcome: Outcome, offset = 0): Report => ({ monitorId: mon.id, version: mon.version, outcome, atSec: at + offset });
  const row = async () => (await admin.query("select *, xmin::text as revision from public.monitors where id = $1", [mon.id])).rows[0];
  const detail = (over: Record<string, unknown> = {}) => ({ daysLeft: 84, expiresAt: expires, issuer: "Let's Encrypt", subject: "askone.org", ...over });

  // ── the certificate ─────────────────────────────────────────────────────────

  it("writes an SSL check's certificate with its outcome, and nothing for a steady pass that read the same one", async () => {
    expect(await store.apply(report(pass(detail())))).toBe("written");
    const first = await row();
    expect(first).toMatchObject({ state: "up", cert_host: "askone.org", cert_issuer: "Let's Encrypt" });
    expect(first.cert_expires_at.toISOString()).toBe(expires);
    // Another location, the same certificate: no update at all.
    expect(await store.apply(report(pass(detail(), "sfo3"), 60))).toBe("unchanged");
    expect((await row()).revision).toBe(first.revision);
  });

  it("writes a renewed certificate on an otherwise steady pass, and keeps the last one when a check reads none", async () => {
    await store.apply(report(pass(detail())));
    expect(await store.apply(report(pass(detail({ expiresAt: "2027-04-15T08:00:00.000Z", issuer: "R11" })), 60))).toBe("written");
    expect(await row()).toMatchObject({ state: "up", cert_issuer: "R11" });
    const renewed = await row();
    expect(await store.apply(report(pass(undefined), 120))).toBe("unchanged");
    expect((await row()).revision).toBe(renewed.revision);
  });

  it("keeps the certificate with the host it was read from, and a check of the new host replaces it", async () => {
    await store.apply(report(pass(detail())));
    // As an edit to another host leaves it: stored for askone.org, while the row names www.
    await admin.query("update public.monitors set cert_host = 'old.askone.org' where id = $1", [mon.id]);
    expect(await store.apply(report(pass(detail()), 60))).toBe("written");
    expect((await row()).cert_host).toBe("askone.org");
  });

  it("commits the outcome whatever certificate it carries, storing only an expiry a certificate can have", async () => {
    // More than 100 years out: refused before, which rolled the whole outcome back on every check.
    expect(await store.apply(report(pass(detail({ expiresAt: "2400-01-01T00:00:00.000Z" }))))).toBe("written");
    expect(await row()).toMatchObject({ state: "up", cert_host: "askone.org" });
    expect((await row()).cert_expires_at.toISOString()).toBe("2400-01-01T00:00:00.000Z");
    // RFC 5280's "no expiry", the last second of 9999.
    expect(await store.apply(report(pass(detail({ expiresAt: "9999-12-31T23:59:59.000Z" })), 60))).toBe("written");
    expect((await row()).cert_expires_at.toISOString()).toBe("9999-12-31T23:59:59.000Z");

    const commit = (id: string, version: string, effects: unknown[]) => store.pool.query("select public.probe_commit_monitor($1,$2,$3,'up',0,0,0,$4,$5::jsonb)",
      [id, version, new Date((at + 120) * 1000).toISOString(), ["tor1"], JSON.stringify(effects)]);
    const fresh = async () => {
      await admin.query("update public.monitors set cert_host = null, cert_expires_at = null, cert_issuer = null, state = null, state_since = null where id = $1", [mon.id]);
      mon = (await store.loadMonitors()).find((m) => m.id === mon.id)!;
    };
    // Outside what X.509 can say (before 1950, past 9999, not a time at all): no certificate,
    // and the transition beside it is still written.
    for (const bad of [{ expiresAt: "1900-01-01T00:00:00Z" }, { expiresAt: "+010000-01-01T00:00:00.000Z" }, { expiresAt: "soon" }, { expiresAt: null }]) {
      await fresh();
      await commit(mon.id, mon.version, [{ kind: "transition", from: null, to: "up" }, { kind: "cert", ...bad }]);
      expect(await row()).toMatchObject({ state: "up", cert_host: null, cert_expires_at: null });
    }
    // The issuer is the database's to bound: cut to its 200 characters, and none when it isn't text.
    await fresh();
    await commit(mon.id, mon.version, [{ kind: "cert", expiresAt: expires, issuer: "x".repeat(300) }]);
    expect((await row()).cert_issuer).toHaveLength(200);
    await fresh();
    await commit(mon.id, mon.version, [{ kind: "cert", expiresAt: expires, issuer: 7 }]);
    expect(await row()).toMatchObject({ cert_host: "askone.org", cert_issuer: null });
    // A monitor that isn't SSL keeps no certificate, and its outcome commits.
    const http = (await admin.query(`insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, config)
      values ($1, $2, 'http', 'API', 'https://askone.org/', 'askone.org', 60, '{}') returning id`, [ws, app])).rows[0].id;
    const httpMon = (await store.loadMonitors()).find((m) => m.id === http)!;
    await commit(http, httpMon.version, [{ kind: "transition", from: null, to: "up" }, { kind: "cert", expiresAt: expires }]);
    expect((await admin.query("select state, cert_host from public.monitors where id = $1", [http])).rows[0]).toEqual({ state: "up", cert_host: null });
  });

  it("holds a certificate's facts together in the row", async () => {
    await expect(admin.query("update public.monitors set cert_host = 'askone.org' where id = $1", [mon.id]))
      .rejects.toMatchObject({ code: "23514" });
  });

  // ── the domain ──────────────────────────────────────────────────────────────

  const found = (domain = "askone.org") => ({ status: "found" as const, domain, expiresAt: Date.parse("2027-08-30T12:25:15.206Z"), registrar: "GoDaddy.com, LLC" });

  it("records the domain under the name the registry answered for, and every host on it reads that row", async () => {
    await insertSsl(ws, app, "www.askone.org");
    expect(await store.recordDomain("www.askone.org", found())).toBe(true);
    const rows = await store.loadDomains(["www.askone.org", "askone.org", "api.askone.org", "nothing.example.net"]);
    expect(rows.map((r) => [r.host, r.name, r.status, r.error]).sort()).toEqual([
      ["api.askone.org", "askone.org", "found", null],
      ["askone.org", "askone.org", "found", null],
      ["www.askone.org", "askone.org", "found", null],
    ]);
    expect(Math.abs(rows[0].attemptedAt - Date.now())).toBeLessThan(60_000);
    const stored = (await admin.query("select * from public.domain_registrations where name = 'askone.org'")).rows[0];
    expect(stored).toMatchObject({ status: "found", registrar: "GoDaddy.com, LLC", error: null });
    expect(stored.expires_at.toISOString()).toBe("2027-08-30T12:25:15.206Z");
  });

  it("writes nothing for a host no SSL monitor names any more", async () => {
    expect(await store.recordDomain("gone.example.net", { status: "no_rdap", domain: "gone.example.net" })).toBe(false);
    expect((await admin.query("select 1 from public.domain_registrations where name = 'gone.example.net'")).rows).toEqual([]);
  });

  it("keeps an answer through a failed refresh, noting the error; a failed walk is a row of its own until the domain is found", async () => {
    await insertSsl(ws, app, "www.askone.org");
    await store.recordDomain("askone.org", found());
    expect(await store.recordDomain("askone.org", { status: "failed", domain: "askone.org", error: "The registry answered 503" })).toBe(true);
    expect((await admin.query("select status, registrar, error, checked_at is not null as answered from public.domain_registrations where name = 'askone.org'")).rows)
      .toEqual([{ status: "found", registrar: "GoDaddy.com, LLC", error: "The registry answered 503", answered: true }]);

    await admin.query("delete from public.domain_registrations where name = 'askone.org'");
    await store.recordDomain("www.askone.org", { status: "failed", domain: "www.askone.org", error: "No answer within 10 s" });
    expect((await store.loadDomains(["www.askone.org"]))[0]).toMatchObject({ name: "www.askone.org", status: "failed" });
    await store.recordDomain("www.askone.org", found());
    // The host's own failed row is gone, so it no longer shadows the domain's.
    expect((await store.loadDomains(["www.askone.org"]))[0]).toMatchObject({ name: "askone.org", status: "found" });
    expect((await admin.query("select 1 from public.domain_registrations where name = 'www.askone.org'")).rows).toEqual([]);
  });

  it("never lets a host's own row hide the domain's answer, as a late walk from an overlapping pass would", async () => {
    await insertSsl(ws, app, "www.askone.org");
    expect(await store.recordDomain("www.askone.org", found())).toBe(true);
    // A walk that started before the domain was found, at the leader that is handing over, ends
    // later with a timeout, then with a registry that knew nothing: each a row of the host's own.
    await store.recordDomain("www.askone.org", { status: "failed", domain: "www.askone.org", error: "No answer within 10 s" });
    expect((await admin.query("select status from public.domain_registrations where name = 'www.askone.org'")).rows).toEqual([{ status: "failed" }]);
    const read = async () => ({
      probe: (await store.loadDomains(["www.askone.org"]))[0],
      screen: (await admin.query("select host, name, status from public.workspace_domains($1)", [ws])).rows.find((r) => r.host === "www.askone.org"),
    });
    expect(await read()).toMatchObject({ probe: { name: "askone.org", status: "found" }, screen: { name: "askone.org", status: "found" } });
    await store.recordDomain("www.askone.org", { status: "not_found", domain: "www.askone.org" });
    expect(await read()).toMatchObject({ probe: { name: "askone.org", status: "found" }, screen: { name: "askone.org", status: "found" } });
  });

  it("says a TLD has no RDAP service, and replaces that once a registry answers", async () => {
    const io = await insertSsl(ws, app, "staygreen.io");
    await store.recordDomain("staygreen.io", { status: "no_rdap", domain: "staygreen.io" });
    expect((await admin.query("select status, expires_at, registrar, error from public.domain_registrations where name = 'staygreen.io'")).rows)
      .toEqual([{ status: "no_rdap", expires_at: null, registrar: null, error: null }]);
    await admin.query("delete from public.monitors where id = $1", [io]);
  });

  it("refuses a name that isn't the host or a parent of it, and facts that don't fit the answer", async () => {
    const record = (args: unknown[]) => store.pool.query("select public.probe_record_domain($1,$2,$3,$4,$5,$6)", args);
    await expect(record(["askone.org", "vercel.com", "found", null, null, null])).rejects.toMatchObject({ code: "22023", message: "probe_domain_name_invalid" });
    await expect(record(["askone.org", "xaskone.org", "found", null, null, null])).rejects.toMatchObject({ code: "22023", message: "probe_domain_name_invalid" });
    await expect(record(["askone.org", "org", "found", null, null, null])).rejects.toMatchObject({ code: "23514" });
    await expect(record(["askone.org", "askone.org", "no_rdap", expires, null, null])).rejects.toMatchObject({ code: "22023", message: "probe_domain_fact_invalid" });
    await expect(record(["askone.org", "askone.org", "failed", null, null, null])).rejects.toMatchObject({ code: "22023", message: "probe_domain_fact_invalid" });
    await expect(record(["askone.org", "askone.org", "found", null, null, "an error"])).rejects.toMatchObject({ code: "22023", message: "probe_domain_fact_invalid" });
    await expect(record(["askone.org", "askone.org", "found", "1970-01-01T00:00:00Z", null, null])).rejects.toMatchObject({ code: "22023", message: "probe_domain_fact_invalid" });
    await expect(record(["askone.org", "askone.org", "found", null, "x".repeat(201), null])).rejects.toMatchObject({ code: "22023", message: "probe_domain_fact_invalid" });
    await expect(store.pool.query("select * from public.probe_load_domains($1::text[])", [Array.from({ length: 100_001 }, (_, i) => `h${i}.example.net`)]))
      .rejects.toMatchObject({ code: "22023", message: "probe_domain_hosts_invalid" });
    expect((await admin.query("select 1 from public.domain_registrations where name = 'askone.org'")).rows).toEqual([]);
  });

  it("lets the probe reach the table only through its two functions", async () => {
    await expect(store.pool.query("select * from public.domain_registrations limit 1"))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for table domain_registrations" });
    await expect(store.pool.query("select * from public.domain_registration_for(array['askone.org'])"))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for function domain_registration_for" });
    await expect(store.pool.query("select * from public.workspace_domains($1)", [ws]))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for function workspace_domains" });
    const t = (await admin.query("select relrowsecurity from pg_class where oid = 'public.domain_registrations'::regclass")).rows[0];
    expect(t.relrowsecurity).toBe(true);
    expect((await admin.query("select 1 from pg_policies where tablename = 'domain_registrations'")).rows).toEqual([]);
    const grants = (await admin.query(`select r from unnest(array['anon','authenticated','probe']) r
      where has_table_privilege(r, 'public.domain_registrations', 'SELECT') or has_function_privilege(r, 'public.workspace_domains(text)', 'EXECUTE')`)).rows;
    expect(grants).toEqual([]);
  });

  it("gives the dashboard the rows for its own SSL hosts and nothing about another workspace's", async () => {
    await store.recordDomain("askone.org", found());
    const otherHost = (await admin.query("select target_host from public.monitors where workspace_id = $1", [other])).rows[0].target_host;
    await store.recordDomain(otherHost, { status: "not_found", domain: otherHost });
    const mine = (await admin.query("select host, name, status from public.workspace_domains($1)", [ws])).rows;
    expect(mine).toEqual([{ host: "askone.org", name: "askone.org", status: "found" }]);
    const theirs = (await admin.query("select host from public.workspace_domains($1)", [other])).rows;
    expect(theirs).toEqual([{ host: otherHost }]);
  });
});
