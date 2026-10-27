import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Probe } from "../../probe/runtime";
import { Store } from "../../probe/store";
import { domainPass } from "../../probe/domains";
import { BOOTSTRAP_URL, Rdap } from "../../src/checks/rdap";
import { measuredById, reportedWhen, workspaceHistoryDto } from "../../src/lib/history";
import { sslOf } from "../../src/lib/expiry";
import { probeDatabase } from "../support/probe-database";

/* The round trip a new monitor takes to its first numbers, on this machine: a monitor saved in
   the database, a real probe (`probe/runtime.ts`, its background jobs on) checking it against
   targets on this machine as its own login, and the dashboard's readers (`workspace_history`,
   `workspace_domains`, and the mapping in `src/lib/`) reading what it wrote. The probe's
   30-second refresh is called by hand right after the save, the moment a refresh lands at its
   luckiest; `FIRST_DATA_TIMING=1` adds a run that waits for the probe's own refresh instead and
   prints the times. Skips without `PROBE_DATABASE_URL`, as the store suites do. */

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
const local = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
if (url && !local) throw new Error("PROBE_DATABASE_URL must name a Postgres on this machine (127.0.0.1 or localhost)");

const suite = url ? describe : describe.skip;
if (!url) console.warn('[integration] SKIPPED "first data": PROBE_DATABASE_URL is not set. Nothing in this file reached a database.');
const timing = url && process.env.FIRST_DATA_TIMING === "1" ? it : it.skip;

const tls = (f: string) => readFileSync(new URL(`../fixtures/tls/${f}`, import.meta.url));
const recorded = (f: string) => readFileSync(new URL(`../fixtures/rdap/${f}`, import.meta.url), "utf8");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(read: () => Promise<T | null | undefined>, withinMs: number, what: () => string = () => "it"): Promise<T> {
  const end = Date.now() + withinMs;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what()}: nothing within ${withinMs} ms`);
    await sleep(50);
  }
}

suite("first data", () => {
  let database: Awaited<ReturnType<typeof probeDatabase>>;
  let admin: Awaited<ReturnType<typeof probeDatabase>>["admin"];
  let store: Store;
  let probe: Probe;
  let web: http.Server;
  let cert: https.Server;
  let webUrl = "";
  let certPort = 0;
  let ws = "";
  let app = "";
  /** When each early write began and ended, by monitor. */
  const writes = new Map<string, { started: number; done: number }>();

  beforeAll(async () => {
    web = http.createServer((req, res) => res.writeHead(req.url?.endsWith("/broken") ? 503 : 200).end('{"ok":true}'));
    cert = https.createServer({ key: tls("localhost.key"), cert: tls("localhost.pem") }, (_, res) => res.writeHead(200).end());
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
    // The monitor targets localhost; on Windows it may resolve only to ::1.
    await new Promise<void>((r) => cert.listen(0, "localhost", r));
    webUrl = `http://127.0.0.1:${(web.address() as AddressInfo).port}/api/health`;
    certPort = (cert.address() as AddressInfo).port;

    database = await probeDatabase(url);
    admin = database.admin;
    ws = (await admin.query("insert into public.workspaces (clerk_org_id) values ($1) returning id", [`org_ftest${randomBytes(6).toString("hex")}`])).rows[0].id;
    app = (await admin.query("insert into public.apps (workspace_id, name) values ($1, 'first data') returning id", [ws])).rows[0].id;
    // Only this workspace, as the development probes check only theirs.
    store = Store.connect(database.probeUrl, undefined, [ws]);
    const flush = store.flushRollups.bind(store);
    store.flushRollups = async (rows) => {
      const started = Date.now();
      await flush(rows);
      for (const r of rows) if (!writes.has(r.monitorId)) writes.set(r.monitorId, { started, done: Date.now() });
    };
    probe = new Probe({
      self: { id: `tor1-ft${randomBytes(3).toString("hex")}`, location: "tor1", builderOnly: false, url: "http://127.0.0.1:1" },
      secret: "first-data-test-secret-of-32-characters",
      store,
      port: 0,
      host: "127.0.0.1",
      checks: { allow: () => true, ca: tls("ca.pem") },
      rdap: false,
    });
    await probe.start();
  }, 60_000);

  afterAll(async () => {
    try {
      await probe?.stop();
      if (ws) await admin.query("delete from public.workspaces where id = $1", [ws]);
      await admin.query("delete from public.domain_registrations where name = 'askone.org'");
    } finally {
      try { await store?.close(); } finally {
        await database?.close();
        await new Promise((r) => web?.close(r));
        await new Promise((r) => cert?.close(r));
      }
    }
  });

  const addHttp = async (name: string) =>
    (await admin.query(`insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, config)
      values ($1, $2, 'http', $3, $4, '127.0.0.1', 60, '{"method":"GET","expect":"2xx","timeoutSec":5}') returning id, created_at`, [ws, app, name, webUrl])).rows[0];
  const windowsOf = async (id: string) => (await admin.query("select * from public.rollups_5m where monitor_id = $1", [id])).rows;
  const history = async () => {
    const { rows } = await admin.query("select public.workspace_history($1) as h", [ws]);
    return measuredById(workspaceHistoryDto.parse(rows[0].h), Date.now());
  };

  it("puts a new monitor's first check in the rollups within a second of the check, and the dashboard reads it", async () => {
    const saved = await addHttp("API");
    const savedAt = Date.now();
    await probe.refresh();
    const refreshed = Date.now();
    const w = await until(async () => writes.get(saved.id), 15_000);
    const rows = await until(async () => ((await windowsOf(saved.id)).length ? windowsOf(saved.id) : null), 2_000);
    const visible = Date.now();
    expect(rows).toEqual([expect.objectContaining({ location: "tor1", checks: 1, failures: 0 })]);
    expect(rows[0].p50_ms).not.toBeNull();
    // The window is still open: its close adds whatever comes after.
    expect(rows[0].window_start.getTime() + 300_000).toBeGreaterThan(Date.now());

    const readStarted = Date.now();
    const measured = (await history()).get(saved.id)!;
    const readMs = Date.now() - readStarted;
    expect(measured.reports).toHaveLength(1);
    expect(measured.reports[0]).toMatchObject({ loc: "tor1", checks: 1, failures: 0 });
    expect(measured.uptime.day.pct).toBe(100);
    expect(reportedWhen(measured.reports[0], Date.now(), Date.parse(saved.created_at))).toMatch(/^since \d\d:\d\d$/);
    expect(w.done - w.started).toBeLessThan(1000);
    console.log(`[first data] saved → refresh ${refreshed - savedAt} ms; refresh → check done ${w.started - refreshed} ms; ` +
      `write ${w.done - w.started} ms; visible ${visible - w.done} ms later; workspace_history ${readMs} ms`);
  }, 30_000);

  it("writes an SSL monitor's certificate with its first outcome, and the registry's answer for its domain", async () => {
    const { rows: [ssl] } = await admin.query(`insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, config)
      values ($1, $2, 'ssl', 'localhost', 'localhost', 'localhost', 21600, $3) returning id`, [ws, app, JSON.stringify({ port: certPort })]);
    await probe.refresh();
    const row = await until(async () => (await admin.query("select * from public.monitors where id = $1 and cert_host is not null", [ssl.id])).rows[0], 15_000);
    const facts = sslOf("localhost", { ...row, cert_expires_at: row.cert_expires_at.toISOString() }, undefined, Date.now());
    expect(facts.certDays).toBeGreaterThan(0);
    expect(facts.issuer).toEqual(expect.any(String));
    expect(row.state).toBe("up");

    // The domain, through the store and the reader, over recorded RDAP answers: an SSL monitor
    // for askone.org, paused so no probe checks it over the network.
    await admin.query(`insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, config, paused_at)
      values ($1, $2, 'ssl', 'askone.org', 'askone.org', 'askone.org', 21600, '{}', now())`, [ws, app]);
    const pir = "https://rdap.publicinterestregistry.org/rdap/domain/";
    const rdap = new Rdap(async (u) =>
      u === BOOTSTRAP_URL ? { status: 200, body: recorded("iana-dns-bootstrap.json") }
      : u === `${pir}askone.org` ? { status: 200, body: recorded("askone.org.json") } : { status: 404, body: "" }, { sleep: async () => {} });
    expect(await domainPass(store, rdap, ["askone.org"], Date.now())).toEqual({ looked: 1, recorded: 1, errors: 0, deferred: new Set() });
    const domains = (await admin.query("select * from public.workspace_domains($1)", [ws])).rows;
    const read = domains.map((d) => ({ ...d, expires_at: d.expires_at?.toISOString() ?? null }));
    const ssl2 = sslOf("askone.org", { cert_host: null, cert_expires_at: null, cert_issuer: null }, read.find((d) => d.host === "askone.org"), Date.now());
    expect(ssl2.domain).toMatchObject({ status: "found", name: "askone.org", registrar: "GoDaddy.com, LLC" });
    expect((ssl2.domain as { days: number }).days).toBeGreaterThan(0);
  }, 30_000);

  it("starts a monitor's open window over when it is edited, so a fixed address's first numbers are its own", async () => {
    // The whole story inside one 5-minute window: wait out a boundary that is too close.
    const left = 300_000 - (Date.now() % 300_000);
    if (left < 90_000) await sleep(left + 1_000);
    const { rows: [m] } = await admin.query(`insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, config)
      values ($1, $2, 'http', 'Typo', $3, '127.0.0.1', 60, '{"method":"GET","expect":"2xx","timeoutSec":5}') returning id`,
      [ws, app, webUrl.replace("/api/health", "/broken")]);
    // A window that closed earlier, as a probe elsewhere wrote it: an edit leaves it alone.
    const closed = new Date(Math.floor(Date.now() / 300_000) * 300_000 - 900_000);
    await admin.query(`insert into public.rollups_5m (monitor_id, location, window_start, checks, failures, p50_ms, p95_ms, max_ms)
      values ($1, 'sfo3', $2, 2, 0, 100, 120, 130)`, [m.id, closed]);
    // Added at a broken address: its first check fails, and is in the database at once.
    await probe.refresh();
    await until(async () => (await windowsOf(m.id)).some((w) => w.failures > 0), 30_000, () => "the broken address's first check");
    // The builder fixes the address in the same window.
    await admin.query("update public.monitors set target = $2, updated_at = now() where id = $1", [m.id, webUrl]);
    expect((await windowsOf(m.id)).map((w) => w.window_start.getTime())).toEqual([closed.getTime()]);
    await probe.refresh();
    const open = await until(async () => (await windowsOf(m.id)).find((w) => w.window_start.getTime() !== closed.getTime()), 30_000,
      () => `the fixed address's first check (${JSON.stringify(probe.counts)})`);
    // Only the fixed address's check: not the broken one's failures beside it.
    expect(open).toMatchObject({ location: "tor1", checks: 1, failures: 0 });
    // And the day's tier is the sum of what is left.
    const sums = async (sql: string) => (await admin.query(sql, [m.id])).rows.map((r) => ({ day: String(r.day), windows: Number(r.windows), checks: Number(r.checks), failures: Number(r.failures) }));
    expect(await sums("select day, windows, checks, failures from public.rollups_1d where monitor_id = $1 order by day"))
      .toEqual(await sums(`select (window_start at time zone 'UTC')::date as day, count(distinct window_start) as windows, sum(checks) as checks,
        sum(failures) as failures from public.rollups_5m where monitor_id = $1 group by 1 order by 1`));
  }, 200_000);

  timing("FIRST_DATA_TIMING: waits for the probe's own refresh, as in production, and prints each monitor's time to its first window", async () => {
    const times: number[] = [];
    for (let i = 0; i < 4; i++) {
      // Saved at a different point of the probe's 30-second refresh each time.
      await sleep(7_000 + Math.floor(Math.random() * 8_000));
      const saved = await addHttp(`timing ${i}`);
      const at = Date.now();
      await until(async () => ((await windowsOf(saved.id)).length ? true : null), 50_000);
      times.push(Date.now() - at);
    }
    console.log(`[first data] save → first window in the database, waiting for the probe's own refresh: ${times.map((t) => `${(t / 1000).toFixed(1)} s`).join(", ")}`);
    for (const t of times) expect(t).toBeLessThan(42_000);
  }, 240_000);
});
