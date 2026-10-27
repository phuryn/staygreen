import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { Store } from "../../probe/store";
import { probeDatabase } from "../support/probe-database";
import { INGEST_FUNCTIONS } from "../support/probe-functions";

/* The heartbeat receiver against a real Postgres with every migration applied (migration 019,
   `probe/README.md` § A local Postgres): `record_heartbeat` as a login made like the Worker's (a
   member of `ingest` and nothing else), and the home's judgement through the real
   `Store.judgeHeartbeat` as a login made like a probe's. `PROBE_DATABASE_URL` names the local
   database; missing, the file skips and says so. */

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
const local = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
if (url && !local) throw new Error("PROBE_DATABASE_URL must name a Postgres on this machine (127.0.0.1 or localhost)");

const suite = url ? describe : describe.skip;
if (!url) console.warn('[integration] SKIPPED "heartbeat receiver": PROBE_DATABASE_URL is not set. Nothing in this file reached a database.');

const hex = (n: number) => randomBytes(n).toString("hex");
const sha = (token: string) => createHash("sha256").update(token).digest("hex");

suite("heartbeat receiver", () => {
  let probeDb: Awaited<ReturnType<typeof probeDatabase>>;
  let ingestDb: Awaited<ReturnType<typeof probeDatabase>>;
  let admin: pg.Pool;
  let ingest: pg.Pool;
  let store: Store;
  let ws = "";
  let app = "";
  let mon = "";
  let token = "";

  beforeAll(async () => {
    probeDb = await probeDatabase(url, "probe");
    ingestDb = await probeDatabase(url, "ingest");
    admin = probeDb.admin;
    ingest = new pg.Pool({ connectionString: ingestDb.probeUrl, max: 4 });
    store = Store.connect(probeDb.probeUrl);
    ws = (await admin.query("insert into public.workspaces (clerk_org_id) values ($1) returning id", [`org_hbtest${hex(6)}`])).rows[0].id;
    app = (await admin.query("insert into public.apps (workspace_id, name) values ($1, 'heartbeat test') returning id", [ws])).rows[0].id;
  });

  afterAll(async () => {
    try {
      if (ws) await admin.query("delete from public.workspaces where id = $1", [ws]);
    } finally {
      try { await ingest?.end(); await store?.close(); await ingestDb?.close(); } finally { await probeDb?.close(); }
    }
  });

  /** A heartbeat made a day ago, so the test can place pings and deadlines in the past. */
  async function heartbeat(config: Record<string, unknown> = {}) {
    token = randomBytes(32).toString("base64url");
    const c = { schedule: "* * * * *", tz: "UTC", graceMin: 1, maxRunMin: 30, assertions: [], ...config };
    mon = (await admin.query(`insert into public.monitors (workspace_id, app_id, type, name, target, interval_sec, config,
      heartbeat_token_hash, created_at, updated_at)
      values ($1, $2, 'heartbeat', 'Nightly job', 'in.staygreen.io', 60, $3, $4, now() - interval '1 day', now() - interval '1 day')
      returning id`, [ws, app, c, sha(token)])).rows[0].id;
  }

  beforeEach(async () => {
    await admin.query("delete from public.monitors where workspace_id = $1", [ws]);
    await heartbeat();
  });

  const record = (kind: "ping" | "start" | "fail", payload: Record<string, unknown> = {}, hash = sha(token), note: string | null = null) =>
    ingest.query("select public.record_heartbeat($1, $2, $3::jsonb, $4) as r", [hash, kind, JSON.stringify(payload), note]).then((r) => r.rows[0].r as string);
  const latest = async () => (await admin.query("select * from public.heartbeat_latest where monitor_id = $1", [mon])).rows[0];
  const monitor = async () => (await admin.query("select state, state_since from public.monitors where id = $1", [mon])).rows[0];
  const incidents = async () => (await admin.query("select * from public.incidents where monitor_id = $1 order by opened_at", [mon])).rows;
  const failures = async () => (await admin.query("select kind, message from public.check_failures where monitor_id = $1 order by at", [mon])).rows;
  /** Judge until nothing is due, as the home's loop does. */
  async function settle() {
    const runs: { at: number; ok: boolean }[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await store.judgeHeartbeat(mon, "tor1");
      runs.push(...r.runs);
      if (r.applied !== "written") return { ...r, runs };
    }
    throw new Error("never settled");
  }
  /** Moves what arrived and what was judged back by `minutes`, as if it happened then. */
  const age = (minutes: number) => admin.query(`update public.heartbeat_latest set
      ping_at = ping_at - make_interval(mins => $2), start_at = start_at - make_interval(mins => $2),
      fail_at = fail_at - make_interval(mins => $2), judged_at = judged_at - make_interval(mins => $2),
      run_at = run_at - make_interval(mins => $2) where monitor_id = $1`, [mon, minutes]);

  // ── record_heartbeat, as the ingest role ─────────────────────────────────────

  it("answers unknown for a token no heartbeat has, and for a hash of the wrong shape, writing nothing", async () => {
    expect(await record("ping", {}, sha("not-a-token"))).toBe("unknown");
    expect(await record("ping", {}, "nothex")).toBe("unknown");
    expect(await latest()).toBeUndefined();
  });

  it("records the newest of each kind with its payload, in times that only go forward", async () => {
    expect(await record("start")).toBe("recorded");
    expect(await record("ping", { emails_sent: 12 })).toBe("recorded");
    expect(await record("fail", { error: "smtp" }, sha(token), "truncated")).toBe("recorded");
    expect(await record("ping", { emails_sent: 13 })).toBe("recorded");
    const h = await latest();
    expect(h).toMatchObject({ workspace_id: ws, ping_payload: { emails_sent: 13 }, fail_payload: { error: "smtp" }, fail_note: "truncated",
      start_payload: {}, finishes: "3", judged_at: null });
    const times = [h.start_at, h.fail_at, h.ping_at].map((d: Date) => d.getTime());
    expect(times[0]).toBeLessThan(times[1]);
    expect(times[1]).toBeLessThan(times[2]);
    expect(times.every((x) => x % 1 === 0)).toBe(true);
  });

  it("bounds a token in a tight loop per kind: 10 of each recorded a minute, the rest acknowledged and not written", async () => {
    const answers: string[] = [];
    for (let i = 0; i < 14; i++) answers.push(await record("ping", { n: i }));
    expect(answers.filter((a) => a === "recorded")).toHaveLength(10);
    expect(answers.slice(10)).toEqual(["limited", "limited", "limited", "limited"]);
    const h = await latest();
    expect(h.ping_payload).toEqual({ n: 9 });
    expect(h).toMatchObject({ rate_ping: 10, rate_start: 0, rate_fail: 0 });
    // The over-limit path writes nothing: the row's version is the tenth ping's.
    const xmin = async () => (await admin.query("select xmin::text from public.heartbeat_latest where monitor_id = $1", [mon])).rows[0].xmin;
    const before = await xmin();
    expect(await record("ping", { n: 99 })).toBe("limited");
    expect(await xmin()).toBe(before);
    // The burst never crowds out the /fail after it, or a /start: each kind has its own bound.
    expect(await record("fail", { error: "smtp" })).toBe("recorded");
    expect(await record("start")).toBe("recorded");
    expect(await latest()).toMatchObject({ fail_payload: { error: "smtp" }, rate_ping: 10, rate_start: 1, rate_fail: 1 });
    for (let i = 0; i < 9; i++) expect(await record("fail", { n: i })).toBe("recorded");
    expect(await record("fail", { n: 99 })).toBe("limited");
    // A new minute opens a new window for every kind.
    await admin.query("update public.heartbeat_latest set rate_minute = rate_minute - interval '1 minute' where monitor_id = $1", [mon]);
    expect(await record("ping", { n: 100 })).toBe("recorded");
    expect(await latest()).toMatchObject({ rate_ping: 1, rate_start: 0, rate_fail: 0 });
  });

  it("holds the bound under concurrent calls", async () => {
    // The counters reset each minute of the database's clock (`rate_minute`), so a burst that
    // straddles a minute may rightly record up to 10 on each side: start it clear of one. A gate
    // run under load recorded 12 of 20 this way (2026-10-27).
    const left = Number((await admin.query("select 60 - extract(second from now()) as left")).rows[0].left);
    if (left < 5) await new Promise((r) => setTimeout(r, left * 1000 + 200));
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => record("ping", { n: i })));
    expect(answers.filter((a) => a === "recorded").length).toBeLessThanOrEqual(10);
    expect((await latest()).rate_ping).toBeLessThanOrEqual(10);
  });

  it("refuses a payload that isn't an object or is over the database's bound, and a kind it doesn't know", async () => {
    await expect(ingest.query("select public.record_heartbeat($1, 'ping', '[1]'::jsonb, null)", [sha(token)])).rejects.toMatchObject({ code: "22023", message: "heartbeat_payload_invalid" });
    await expect(record("ping", { big: "x".repeat(5000) })).rejects.toMatchObject({ code: "22023", message: "heartbeat_payload_invalid" });
    await expect(ingest.query("select public.record_heartbeat($1, 'stop', '{}'::jsonb, null)", [sha(token)])).rejects.toMatchObject({ message: "heartbeat_kind_invalid" });
    await expect(record("ping", {}, sha(token), "invented")).rejects.toMatchObject({ message: "heartbeat_note_invalid" });
    expect(await latest()).toBeUndefined();
  });

  it("finds the heartbeat by its current token only: a rotated one is unknown", async () => {
    const old = sha(token);
    await admin.query("update public.monitors set heartbeat_token_hash = $2, updated_at = now() where id = $1", [mon, sha("rotated-token")]);
    expect(await record("ping", {}, old)).toBe("unknown");
    expect(await record("ping", {}, sha("rotated-token"))).toBe("recorded");
  });

  it("lets the ingest login do nothing but record: no table, sequence or other function", async () => {
    const who = (await ingest.query("select rolbypassrls, rolsuper from pg_roles where rolname = current_user")).rows[0];
    expect(who).toEqual({ rolbypassrls: false, rolsuper: false });
    expect((await admin.query(`select r.rolname from pg_auth_members a join pg_roles r on r.oid = a.roleid where a.member = $1::regrole`,
      [ingestDb.role])).rows).toEqual([{ rolname: "ingest" }]);
    expect((await ingest.query(`select c.relname, p.priv from pg_class c
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f')
        and has_table_privilege(current_user, c.oid, p.priv)`)).rows).toEqual([]);
    expect((await ingest.query(`select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
        and has_sequence_privilege(current_user, c.oid, 'USAGE,SELECT,UPDATE')`)).rows).toEqual([]);
    expect((await ingest.query(`select p.oid::regprocedure::text as signature from pg_proc p
      where p.pronamespace = 'public'::regnamespace and has_function_privilege(current_user, p.oid, 'EXECUTE') order by 1`))
      .rows.map((r) => r.signature)).toEqual(INGEST_FUNCTIONS);
    for (const table of ["monitors", "heartbeat_latest", "incidents", "monitor_secrets", "workspaces"]) {
      await expect(ingest.query(`select * from public.${table} limit 1`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(ingest.query("update public.heartbeat_latest set judged_at = now()")).rejects.toMatchObject({ code: "42501" });
    await expect(ingest.query("select * from public.probe_lock_heartbeat($1)", [mon])).rejects.toMatchObject({ code: "42501" });
    await expect(ingest.query("select * from public.probe_load_heartbeats(null)")).rejects.toMatchObject({ code: "42501" });
    const { rows } = await admin.query(`select oid::regprocedure::text as s from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_monitor'`);
    const types = rows[0].s.slice("create_monitor(".length, -1).split(",");
    await expect(ingest.query(`select public.create_monitor(${types.map((t: string) => `null::${t}`).join(",")})`))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for function create_monitor" });
    // And a probe can't record a ping: the two roles' APIs don't overlap.
    await expect(store.pool.query("select public.record_heartbeat($1, 'ping', '{}'::jsonb, null)", [sha(token)])).rejects.toMatchObject({ code: "42501" });
  });

  it("pins record_heartbeat as definer with an empty search path, executable by ingest alone", async () => {
    const r = (await admin.query(`select p.prosecdef, p.proconfig,
      has_function_privilege('ingest', p.oid, 'EXECUTE') as ingest, has_function_privilege('probe', p.oid, 'EXECUTE') as probe,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service
      from pg_proc p where p.oid = 'public.record_heartbeat(text,text,jsonb,text)'::regprocedure`)).rows[0];
    expect(r).toEqual({ prosecdef: true, proconfig: ['search_path=""'], ingest: true, probe: false, anon: false, authenticated: false, service: false });
  });

  // ── the home's judgement, through the real store ─────────────────────────────

  it("No ping yet, then a ping moves it to up: the first good ping is the first state", async () => {
    expect(await settle()).toMatchObject({ applied: "unchanged", due: null });
    expect((await monitor()).state).toBeNull();
    await record("ping", { emails_sent: 1 });
    const done = await settle();
    expect((await monitor()).state).toBe("up");
    expect(done.runs).toHaveLength(1);
    expect(done.runs[0].ok).toBe(true);
    expect((await admin.query("select from_state, to_state from public.transitions where monitor_id = $1", [mon])).rows)
      .toEqual([{ from_state: null, to_state: "up" }]);
    // Its next deadline is the next minute plus a minute of grace, on the database's clock.
    expect(done.due).toBeGreaterThan(Date.now());
  });

  it("missed: a deadline that passes with no ping opens one incident, and the next good ping closes it", async () => {
    await record("ping");
    await settle();
    await age(10);
    const missed = await settle();
    expect((await monitor()).state).toBe("down");
    expect(missed.runs.length).toBeGreaterThan(1);
    expect(missed.runs.every((r) => !r.ok)).toBe(true);
    let inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ title: "Nightly job is down", resolved_at: null, evidence: { locations: [] } });
    expect(inc[0].evidence.summary).toMatch(/^No ping by /);
    expect((await failures()).map((f) => f.kind)).toEqual(["missed"]);
    // Judged again with nothing new: nothing more is due, nothing opens.
    expect((await settle()).applied).toBe("unchanged");
    await record("ping");
    await settle();
    expect((await monitor()).state).toBe("up");
    inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0].resolved_at).not.toBeNull();
    expect(inc[0].timeline.at(-1).text).toBe("A good ping arrived, incident closed");
  });

  it("failed by /fail: one incident, closed by the next good ping", async () => {
    await record("ping");
    await settle();
    await record("fail", { error: "smtp down" });
    await settle();
    expect((await monitor()).state).toBe("down");
    const [inc] = await incidents();
    expect(inc.evidence).toMatchObject({ request: "/fail", summary: "The job reported a failure (/fail)" });
    expect(inc.evidence.snippet).toContain("smtp down");
    await record("ping");
    await settle();
    expect((await monitor()).state).toBe("up");
    expect(await incidents()).toHaveLength(1);
    expect((await incidents())[0].resolved_at).not.toBeNull();
  });

  it("gives an outage its own incident when one is still open on a heartbeat that wasn't down", async () => {
    // As 017's commit after review 35: a seeded degraded incident is closed, not kept.
    await record("ping");
    await settle();
    await admin.query("insert into public.incidents (workspace_id, monitor_id, title, severity, opened_at) values ($1, $2, 'Seeded', 'degraded', now() - interval '1 hour')", [ws, mon]);
    await record("fail", { error: "smtp down" });
    await settle();
    expect((await monitor()).state).toBe("down");
    const [seed, outage] = await incidents();
    expect(seed).toMatchObject({ title: "Seeded", severity: "degraded" });
    expect(seed.resolved_at).not.toBeNull();
    expect(outage).toMatchObject({ title: "Nightly job is down", severity: "down", resolved_at: null, evidence: { request: "/fail" } });
  });

  it("failed by a false assertion: one incident with what it got, closed by a ping that passes", async () => {
    await admin.query("delete from public.monitors where id = $1", [mon]);
    await heartbeat({ assertions: [{ path: "emails_sent", op: ">", value: "0" }] });
    await record("ping", { emails_sent: 4 });
    await settle();
    expect((await monitor()).state).toBe("up");
    await record("ping", { emails_sent: 0 });
    await settle();
    expect((await monitor()).state).toBe("down");
    const [inc] = await incidents();
    expect(inc.evidence).toMatchObject({ assertion: "emails_sent > 0", got: "0", summary: "emails_sent > 0 failed: got 0" });
    await record("ping", { emails_sent: "2" });
    await settle();
    expect((await monitor()).state).toBe("up");
    expect(await incidents()).toHaveLength(1);
  });

  it("stuck: a /start with no finish within the max run time opens one incident; its finish closes it", async () => {
    await record("ping");
    await settle();
    await record("start");
    await age(40);
    await settle();
    expect((await monitor()).state).toBe("down");
    // Stuck first; this job runs every minute, so the runs expected after it while it stayed
    // stuck are missed too, as failures of the incident already open.
    expect((await failures()).map((f) => f.kind)).toEqual(["stuck", "missed"]);
    expect(await incidents()).toHaveLength(1);
    await record("ping");
    await settle();
    expect((await monitor()).state).toBe("up");
    expect((await incidents())[0].resolved_at).not.toBeNull();
  });

  it("judges the /fail that follows a burst of pings: the burst can't hide a failure", async () => {
    await record("ping");
    await settle();
    for (let i = 0; i < 12; i++) await record("ping", { n: i });
    expect(await record("fail", { error: "disk full" })).toBe("recorded");
    await settle();
    expect((await monitor()).state).toBe("down");
    expect((await incidents())[0].evidence.snippet).toContain("disk full");
  });

  it("never loses a /fail to a good ping that lands before the home reads either", async () => {
    await record("ping");
    await settle();
    await record("fail", { error: "x" });
    await record("ping");
    await settle();
    expect((await monitor()).state).toBe("up");
    const inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0].resolved_at).not.toBeNull();
    expect((await admin.query("select from_state, to_state from public.transitions where monitor_id = $1 order by id", [mon])).rows.map((r) => `${r.from_state}->${r.to_state}`))
      .toEqual(["null->up", "up->down", "down->up"]);
    const h = await latest();
    expect(h.judged_finishes).toBe(h.finishes);
  });

  it("two homes judging at once judge each event once", async () => {
    await record("fail");
    const other = Store.connect(probeDb.probeUrl);
    try {
      await Promise.allSettled([store.judgeHeartbeat(mon, "tor1"), other.judgeHeartbeat(mon, "sfo3")]);
    } finally { await other.close(); }
    expect(await incidents()).toHaveLength(1);
    expect(await failures()).toHaveLength(1);
  });

  it("judges nothing while paused, and fences pings from before the resume", async () => {
    await record("ping");
    await settle();
    await admin.query("select public.pause_monitor($1, $2, null, null)", [ws, mon]);
    expect(await record("fail")).toBe("recorded");
    expect((await store.judgeHeartbeat(mon, "tor1")).applied).toBe("paused");
    await admin.query("select public.resume_monitor($1, $2)", [ws, mon]);
    await settle();
    expect((await monitor()).state).toBe("up");
    expect(await incidents()).toHaveLength(0);
  });

  it("refuses commits a probe could never legitimately make", async () => {
    await record("ping");
    const r = (await admin.query("select (extract(epoch from updated_at) * 1000000)::bigint::text as v from public.monitors where id = $1", [mon])).rows[0];
    const h = await latest();
    const commit = (over: Partial<Record<string, unknown>> = {}) => {
      const a = { version: r.v, from: null, at: h.ping_at, judged: h.ping_at, finishes: 1, run: h.ping_at, state: "up", effects: [] as unknown[], ...over };
      return store.pool.query("select public.probe_commit_heartbeat($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
        [mon, a.version, a.from, a.at, a.judged, a.finishes, a.run, a.state, JSON.stringify(a.effects)]);
    };
    await expect(commit({ version: "1" })).rejects.toMatchObject({ message: "probe_monitor_moved" });
    await expect(commit({ state: "degraded" })).rejects.toMatchObject({ message: "probe_state_invalid" });
    await expect(commit({ from: new Date(0) })).rejects.toMatchObject({ message: "probe_heartbeat_moved" });
    await expect(commit({ judged: new Date(Date.now() + 3_600_000) })).rejects.toMatchObject({ message: "probe_heartbeat_order_invalid" });
    await expect(commit({ finishes: 2 })).rejects.toMatchObject({ message: "probe_heartbeat_finishes_invalid" });
    await expect(commit({ effects: [{ kind: "delete_monitor" }] })).rejects.toMatchObject({ message: "probe_effect_invalid" });
    await expect(commit({ effects: [{ kind: "transition", from: "down", to: "up" }] })).rejects.toMatchObject({ message: "probe_transition_invalid" });
    await expect(commit({ effects: [{ kind: "open_incident", evidence: {}, timeline: [] }] })).rejects.toMatchObject({ message: "probe_incident_invalid" });
    // The run cursor is a scheduled time: at most 30 s past what was judged (a run reported
    // early), and it never moves back or is cleared.
    await expect(commit({ run: new Date(h.ping_at.getTime() + 30_001) })).rejects.toMatchObject({ message: "probe_heartbeat_order_invalid" });
    await admin.query("update public.heartbeat_latest set run_at = $2 where monitor_id = $1", [mon, h.ping_at]);
    await expect(commit({ run: new Date(h.ping_at.getTime() - 60_000) })).rejects.toMatchObject({ message: "probe_heartbeat_order_invalid" });
    await expect(commit({ run: null })).rejects.toMatchObject({ message: "probe_heartbeat_order_invalid" });
    expect((await monitor()).state).toBeNull();
    expect((await latest()).judged_at).toBeNull();
    // A checked monitor's commit refuses a heartbeat, and the heartbeat's refuses a checked monitor.
    await expect(store.pool.query("select public.probe_commit_monitor($1,$2,now(),'up',0,0,0,'{tor1}',$3::jsonb)", [mon, r.v, "[]"]))
      .rejects.toMatchObject({ code: "22023" });
  });

  it("writes uptime as the share of runs on time and passed, for the days and the 24 hours alike", async () => {
    // 3 runs passed and 1 failed, in one of this location's windows, ten minutes back. In a UTC day's
    // first half hour that is yesterday, or today's four runs (1,200 s) are capped by the little of
    // the day gone by (gates at 00:02 and 00:14 UTC, 2026-10-27): then yesterday's last window.
    const now = Date.now() / 1000, dayStart = Math.floor(now / 86_400) * 86_400, early = now - dayStart < 1800;
    const window = early ? dayStart - 300 : Math.floor(now / 300) * 300 - 600;
    await store.flushRollups([{ monitorId: mon, location: "tor1", windowStart: window, checks: 4, failures: 1, p50Ms: null, p95Ms: null, maxMs: null }]);
    const days = (await admin.query("select up, covered, down from public.monitor_days($1, 2)", [[mon]])).rows;
    expect(days).toHaveLength(1);
    expect(days[0].up).toBe(75);
    const history = (await admin.query("select public.workspace_history($1) as h", [ws])).rows[0].h;
    const m = history.monitors.find((x: { id: string }) => x.id === mon);
    expect(m.day.covered).toBeGreaterThan(0);
    expect(m.day.down / m.day.covered).toBeCloseTo(0.25, 5);
    expect(m.days).toEqual([[early ? 1 : 0, 75]]);
  });

  it("is deleted with its monitor", async () => {
    await record("ping");
    await admin.query("delete from public.monitors where id = $1", [mon]);
    expect(await latest()).toBeUndefined();
  });
});
