import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Located, Outcome } from "../../probe/state";
import { sendReports, type Report } from "../../probe/peer";
import { Probe } from "../../probe/runtime";
import { Store, type Monitor } from "../../probe/store";
import { probeDatabase } from "../support/probe-database";
import { DEFINER_FUNCTIONS, PROBE_FUNCTIONS } from "../support/probe-functions";
import { headerContext, seal } from "../../src/lib/seal";

/* The probe's writes against a real Postgres with the real migrations applied (stage 2.1 runs a
   local one: `probe/README.md`). `PROBE_DATABASE_URL` names it; it must be on this
   machine, so this file can never write probe tables into a shared database. Missing, the file
   skips and says so. */

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
const local = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
if (url && !local) throw new Error("PROBE_DATABASE_URL must name a Postgres on this machine (127.0.0.1 or localhost)");

const suite = url ? describe : describe.skip;
if (!url) console.warn('[integration] SKIPPED "probe store": PROBE_DATABASE_URL is not set. Nothing in this file reached a database.');

const hex = (n: number) => randomBytes(n).toString("hex");

suite("probe store", () => {
  let store: Store;
  let database: Awaited<ReturnType<typeof probeDatabase>>;
  let admin: Awaited<ReturnType<typeof probeDatabase>>["admin"];
  let probeUrl: string;
  let ws = "";
  let mon: Monitor;
  let app = "";
  const at = 1_800_000_000;

  beforeAll(async () => {
    database = await probeDatabase(url);
    ({ admin, probeUrl } = database);
    store = Store.connect(probeUrl);
    const w = await admin.query("insert into public.workspaces (clerk_org_id) values ($1) returning id", [`org_ptest${hex(6)}`]);
    ws = w.rows[0].id;
    const a = await admin.query("insert into public.apps (workspace_id, name) values ($1, 'probe test') returning id", [ws]);
    app = a.rows[0].id;
  });

  beforeEach(async () => {
    await admin.query("delete from public.monitors where workspace_id = $1", [ws]);
    await admin.query(
      `insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, config)
       values ($1, $2, 'http', 'API', 'https://example.com/health', 'example.com', 60, '{"method":"GET","expect":"2xx"}')`, [ws, app]);
    mon = (await store.loadMonitors()).find((m) => m.workspaceId === ws)!;
  });

  const pass = (slow = false, location = "tor1"): Outcome => ({ first: { ok: true, ms: 120, slow, location } });
  const fail = (location = "tor1"): Located => ({ ok: false, ms: 210, status: 503, location,
    failure: { kind: "status", message: "Answered 503, expected 2xx" } });
  const down = (): Outcome => ({ first: fail(), confirm: fail("sfo3") });
  const report = (outcome: Outcome, offset = 0): Report => ({ monitorId: mon.id, version: mon.version, outcome, atSec: at + offset });
  const apply = (outcome: Outcome, offset = 0) => store.apply(report(outcome, offset));
  const row = async () => (await admin.query("select *, xmin::text as revision from public.monitors where id = $1", [mon.id])).rows[0];
  const incidents = async () => (await admin.query("select * from public.incidents where monitor_id = $1 order by opened_at", [mon.id])).rows;
  const reload = async () => { mon = (await store.loadMonitors()).find((m) => m.id === mon.id)!; };
  const edit = async (target = mon.target) => {
    await admin.query(`select public.update_monitor($1, $2, 'API renamed', $3, 'example.com', 60,
      '{"method":"GET","expect":"2xx","keyword":"ready"}', null, 10, 5, 100, 60)`, [ws, mon.id, target]);
    await reload();
  };

  afterAll(async () => {
    try {
      if (ws) await admin.query("delete from public.workspaces where id = $1", [ws]);
    } finally {
      try { await store?.close(); } finally { await database?.close(); }
    }
  });

  it("uses a separate login with only probe membership, no bypass or relation grants", async () => {
    const identity = (await store.pool.query(`select current_user, session_user, rolsuper, rolbypassrls,
      rolcreaterole, rolcreatedb, rolreplication from pg_roles where rolname = current_user`)).rows[0];
    expect(identity).toEqual({ current_user: database.role, session_user: database.role,
      rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false });
    expect((await admin.query(`select r.rolname from pg_auth_members a join pg_roles r on r.oid = a.roleid
      where a.member = $1::regrole`, [database.role])).rows).toEqual([{ rolname: "probe" }]);
    const grants = await store.pool.query(`select c.relname, p.priv from pg_class c
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p(priv)
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','f')
        and has_table_privilege(current_user, c.oid, p.priv)`);
    expect(grants.rows).toEqual([]);
    expect((await store.pool.query(`select c.relname from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
        and has_sequence_privilege(current_user, c.oid, 'USAGE,SELECT,UPDATE')`)).rows).toEqual([]);
    expect((await store.pool.query(`select p.oid::regprocedure::text as signature from pg_proc p
      where p.pronamespace = 'public'::regnamespace and has_function_privilege(current_user, p.oid, 'EXECUTE')
      order by 1`)).rows.map((r) => r.signature).sort()).toEqual(PROBE_FUNCTIONS);
  });

  it.each(["monitor_secrets", "incidents", "incident_notes", "workspaces", "status_pages"])(
    "denies a direct SELECT on %s with a real SQL privilege error", async (table) => {
      await expect(store.pool.query(`select * from public.${table} limit 1`))
        .rejects.toMatchObject({ code: "42501", message: `permission denied for table ${table}` });
    },
  );

  it("denies direct monitor updates and dashboard function execution", async () => {
    await expect(store.pool.query("update public.monitors set name = 'stolen' where id = $1", [mon.id]))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for table monitors" });
    // Resolve the actual dashboard signature, so a missing/changed overload cannot masquerade
    // as a permission denial. NULLs are typed: execution must fail before the body can run.
    const { rows } = await admin.query(`select oid::regprocedure::text as signature
      from pg_proc where pronamespace = 'public'::regnamespace and proname = 'create_monitor'`);
    expect(rows).toHaveLength(1);
    const types = rows[0].signature.slice("create_monitor(".length, -1).split(",");
    await expect(store.pool.query(`select public.create_monitor(${types.map((t: string) => `null::${t}`).join(",")})`))
      .rejects.toMatchObject({ code: "42501", message: "permission denied for function create_monitor" });
  });

  it("pins the probe API's definer, empty search path and exclusive execution grants", async () => {
    const { rows } = await admin.query(`select p.oid::regprocedure::text as signature,
      p.prosecdef, p.proconfig, has_function_privilege('probe',p.oid,'EXECUTE') as probe,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service
      from pg_proc p where p.pronamespace='public'::regnamespace and p.prosecdef`);
    // The heartbeat Worker's `record_heartbeat` is the only other definer (019,
    // `tests/integration/heartbeat.test.ts`); it is not the probe's.
    expect(rows.map((r) => r.signature).sort()).toEqual(DEFINER_FUNCTIONS);
    for (const r of rows.filter((x) => PROBE_FUNCTIONS.includes(x.signature))) {
      expect(r).toMatchObject({ prosecdef: true, proconfig: ['search_path=""'],
        probe: true, anon: false, authenticated: false, service: false });
    }
    expect(rows.filter((x) => !PROBE_FUNCTIONS.includes(x.signature)).every((r) => r.probe === false)).toBe(true);
  });

  const commit = (id = mon.id, version: string | null = mon.version, state: string | null = "up", effects: unknown[] = []) =>
    store.pool.query("select public.probe_commit_monitor($1,$2,$3,$4,0,0,0,$5,$6::jsonb)",
      [id, version, new Date(at * 1000).toISOString(), state, ["tor1"], JSON.stringify(effects)]);

  it("bounds direct commit calls: missing monitor, stale/missing version, illegal state and paused monitor", async () => {
    const before = await row();
    await expect(commit("mon_gone")).rejects.toMatchObject({ code: "22023", message: "probe_monitor_missing" });
    for (const v of ["0", null]) {
      await expect(commit(mon.id, v)).rejects.toMatchObject({ code: "22023", message: "probe_monitor_moved" });
    }
    for (const state of ["invented", "paused"]) {
      await expect(commit(mon.id, mon.version, state)).rejects.toMatchObject({ code: "22023", message: "probe_state_invalid" });
    }
    expect(await row()).toEqual(before);
    await admin.query("select public.pause_monitor($1,$2,null,null)", [ws, mon.id]);
    await reload();
    await expect(commit()).rejects.toMatchObject({ code: "22023", message: "probe_monitor_not_checkable" });
  });

  it("gives a confirmed outage its own incident when one is still open on a monitor that wasn't down", async () => {
    // A seeded incident on a monitor that isn't down (scripts/seed-incident.mjs --degraded):
    // refusing rolled every confirmed failure back (review 34); keeping folded the outage into
    // the seed's degraded row, which uptime doesn't count (review 35).
    await admin.query(
      "insert into public.incidents (workspace_id, monitor_id, title, severity, opened_at) values ($1, $2, 'Seeded', 'degraded', now() - interval '1 hour')",
      [ws, mon.id],
    );
    await reload();
    await commit(mon.id, mon.version, "down", [{ kind: "open_incident", evidence: { kind: "status", got: 503 }, timeline: [{ t: "now", text: "Confirmed" }] }]);
    expect((await row()).state).toBe("down");
    const [seed, outage] = await incidents();
    expect(seed).toMatchObject({ title: "Seeded", severity: "degraded" });
    expect(seed.resolved_at).not.toBeNull();
    expect(outage).toMatchObject({ severity: "down", resolved_at: null, evidence: { kind: "status", got: 503 } });
  });

  it("rejects effects outside the bounded contract and cannot clear an established state", async () => {
    const before = await row();
    await expect(commit(mon.id, mon.version, "up", [{ kind: "delete_monitor" }]))
      .rejects.toMatchObject({ code: "22023", message: "probe_effect_invalid" });
    await expect(commit(mon.id, mon.version, "up", [{ kind: "transition", from: "down", to: "up" }]))
      .rejects.toMatchObject({ code: "22023", message: "probe_transition_invalid" });
    // Six at most since 026: two failures, a transition, an incident, a certificate and a service monitor's runtime.
    await expect(commit(mon.id, mon.version, "up", Array.from({ length: 7 }, () => ({}))))
      .rejects.toMatchObject({ code: "22023", message: "probe_effects_invalid" });
    expect(await row()).toEqual(before);
    await apply(pass());
    await expect(commit(mon.id, mon.version, null))
      .rejects.toMatchObject({ code: "22023", message: "probe_state_invalid" });
    expect((await row()).state).toBe("up");
  });

  it("checks only the workspaces it is given, and marks a monitor with no outcome yet", async () => {
    const only = Store.connect(probeUrl, undefined, [ws]);
    const elsewhere = Store.connect(probeUrl, undefined, ["ws_000000000000000000000000"]);
    try {
      const mine = await only.loadMonitors();
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((m) => m.workspaceId === ws)).toBe(true);
      expect((await elsewhere.loadMonitors()).some((m) => m.workspaceId === ws)).toBe(false);
      expect(mine.find((m) => m.id === mon.id)?.unchecked).toBe(true);
      await admin.query("update public.monitors set probe_outcome_at = now() where id = $1", [mon.id]);
      expect((await only.loadMonitors()).find((m) => m.id === mon.id)?.unchecked).toBe(false);
    } finally {
      await only.close();
      await elsewhere.close();
    }
  });

  it("marks a Builder workspace's monitors by the plan its members last showed, and reads no other workspace's", async () => {
    try {
      expect((await store.loadMonitors()).find((m) => m.id === mon.id)?.builder).toBe(false);
      await admin.query("update public.workspaces set plan = 'builder' where id = $1", [ws]);
      expect((await store.loadMonitors()).find((m) => m.id === mon.id)?.builder).toBe(true);
      const elsewhere = Store.connect(probeUrl, undefined, ["ws_000000000000000000000000"]);
      try {
        const { rows } = await store.pool.query("select workspace_id from public.probe_builder_workspaces($1::text[])", [["ws_000000000000000000000000"]]);
        expect(rows).toEqual([]);
        expect((await elsewhere.loadMonitors()).some((m) => m.workspaceId === ws)).toBe(false);
      } finally {
        await elsewhere.close();
      }
    } finally {
      await admin.query("update public.workspaces set plan = 'free' where id = $1", [ws]);
    }
  });

  it("loads check configuration and pauses, but no copy of the state machine", async () => {
    await admin.query(`insert into public.monitors (workspace_id, app_id, type, name, target, interval_sec, heartbeat_token_hash)
      values ($1, $2, 'heartbeat', 'Nightly job', 'nightly', 60, $3)`, [ws, app, hex(32)]);
    await admin.query(`insert into public.monitors (workspace_id, app_id, type, name, target, interval_sec, paused_at)
      values ($1, $2, 'tcp', 'Postgres port', 'example.com:5432', 60, now())`, [ws, app]);
    const mine = (await store.loadMonitors()).filter((m) => m.workspaceId === ws);
    expect(mine.map((m) => [m.type, m.paused]).sort()).toEqual([["http", false], ["tcp", true]]);
    expect(mon).toMatchObject({ name: "API", intervalSec: 60, config: { method: "GET" } });
    expect(mon).not.toHaveProperty("state");
    expect(mon).not.toHaveProperty("since");
    expect(mon).not.toHaveProperty("passStreak");
  });

  it("knows which probes are live: heartbeated in the last two minutes", async () => {
    const id = `ptest-${hex(3)}`;
    await store.heartbeat({ id, location: "tor1", builderOnly: false, url: "http://10.0.0.2:7070" });
    expect((await store.liveProbes()).map((p) => p.id)).toContain(id);
    await admin.query("update public.probes set last_seen = now() - interval '3 minutes' where id = $1", [id]);
    expect((await store.liveProbes()).map((p) => p.id)).not.toContain(id);
    await admin.query("delete from public.probes where id = $1", [id]);
  });

  it("drops a probe that leaves from the live set at once", async () => {
    const id = `ptest-${hex(3)}`;
    await store.heartbeat({ id, location: "sfo3", builderOnly: false, url: "http://10.0.0.3:7070" });
    await store.leave(id);
    expect((await store.liveProbes()).map((p) => p.id)).not.toContain(id);
  });

  it("steps a confirmed failure, writing one incident, evidence and transition together", async () => {
    const outcome = down();
    outcome.first.snippet = 'masked';
    outcome.confirm!.snippet = 'masked';
    expect(await apply(outcome)).toBe("written");
    await apply(down(), 60);
    const m = await row();
    expect(m.state).toBe("down");
    expect(new Date(m.state_since).getTime()).toBe(at * 1000);
    expect(m.probe_pass_streak).toBe(0);
    const inc = await incidents();
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({ title: "API is down", severity: "down", resolved_at: null,
      evidence: { request: "GET https://example.com/health", summary: "Answered 503, expected 2xx", status: 503,
        locations: ["tor1", "sfo3"], snippet: "masked" } });
    expect(inc[0].timeline.map((t: { text: string }) => t.text)).toEqual(["Check failed in Toronto", "Confirmed from San Francisco, incident opened"]);
    expect((await admin.query("select from_state, to_state from public.transitions where monitor_id = $1", [mon.id])).rows)
      .toEqual([{ from_state: null, to_state: "down" }]);
  });

  it("never dates an incident later than the database's clock, whatever the probe's says", async () => {
    // A report an hour ahead of the real time stands for a probe whose clock leads the database's.
    const ahead = Math.floor(Date.now() / 1000) + 3600 - at;
    await apply(down(), ahead);
    const [inc] = await incidents();
    expect(new Date(inc.opened_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("persists the first pass and closes only after the second, including across a store restart", async () => {
    await apply(down());
    await apply(pass(), 60);
    expect(await row()).toMatchObject({ state: "down", probe_pass_streak: 1 });
    expect((await incidents())[0].resolved_at).toBeNull();
    const other = Store.connect(probeUrl);
    try { await other.apply(report(pass(false, "sfo3"), 120)); } finally { await other.close(); }
    expect(await row()).toMatchObject({ state: "up", probe_pass_streak: 0 });
    const inc = (await incidents())[0];
    expect(new Date(inc.resolved_at).getTime()).toBe((at + 120) * 1000);
    expect(inc.timeline.at(-1).text).toBe("Two checks passed, incident closed");
  });

  it("uses the row another home wrote: a recovery does not hide the next outage", async () => {
    await apply(down());
    const other = Store.connect(probeUrl);
    try {
      await other.apply(report(pass(), 60));
      await other.apply(report(pass(), 120));
    } finally { await other.close(); }
    await apply(down(), 180);
    expect(await row()).toMatchObject({ state: "down" });
    expect(await incidents()).toHaveLength(2);
  });

  it("uses the row another home wrote: an outage after degraded still requires two passes", async () => {
    for (let i = 0; i < 3; i++) await apply(pass(true), i * 60);
    expect((await row()).state).toBe("degraded");
    await new Store(store.pool).apply(report(down(), 180));
    await apply(pass(), 240);
    expect((await row()).state).toBe("down");
    await apply(pass(), 300);
    expect((await row()).state).toBe("up");
    expect((await incidents())[0].resolved_at).not.toBeNull();
  });

  it("rejects a report checked against another version before counters or effects move", async () => {
    const old = report(down(), 60);
    await edit();
    await expect(store.apply(old)).resolves.toBe("moved");
    expect(await row()).toMatchObject({ state: null, probe_pass_streak: 0, probe_fail_streak: 0, probe_slow_streak: 0 });
    expect(await incidents()).toHaveLength(0);
    expect((await admin.query("select * from public.check_failures where monitor_id = $1", [mon.id])).rows).toHaveLength(0);
    await apply(pass(), 120);
    const version = mon.version;
    await reload();
    expect(mon.version).toBe(version);
  });

  it("fences outcomes older than state_since even when the row has no ordering marker yet", async () => {
    // A pre-migration state (or an owner's edit resetting counters) has no outcome marker.
    await admin.query("update public.monitors set state = 'up', state_since = to_timestamp($2) where id = $1", [mon.id, at + 180]);
    expect(await apply(down(), 179)).toBe("moved");
    expect((await row()).state).toBe("up");
    expect(await incidents()).toHaveLength(0);
    await admin.query("update public.monitors set state = 'down' where id = $1", [mon.id]);
    expect(await apply(pass(), 179)).toBe("moved");
    expect((await row()).probe_pass_streak).toBe(0);
  });

  it("round 9: a pass older than the newest counted failure cannot help recover a down monitor", async () => {
    await apply(down());
    await apply(pass(), 60);
    await apply(down(), 180); // No transition: state_since is still at, but recovery starts again.
    expect(await apply(pass(false, "sfo3"), 120)).toBe("moved");
    expect(await row()).toMatchObject({ state: "down", probe_pass_streak: 0 });
    await apply(pass(), 240);
    expect((await incidents())[0].resolved_at).toBeNull();
    await apply(pass(), 300);
    expect((await incidents())[0].resolved_at).not.toBeNull();
  });

  it("orders late failures and slow passes too, and never rewinds the ordering marker", async () => {
    await apply(pass());
    await apply(pass(true), 60);
    await apply(pass(true), 180);
    expect(await apply(down(), 120)).toBe("moved");
    expect(await apply(pass(false, "sfo3"), 120)).toBe("moved");
    await apply(pass(true), 240);
    expect((await row()).state).toBe("degraded");
    expect(await incidents()).toHaveLength(0);
  });

  it("round 9: a refresh landing mid-write cannot admit a pass from before the outage", async () => {
    await apply(pass());
    const probe = new Probe({
      self: { id: "ptest-home", location: "tor1", builderOnly: false, url: "http://127.0.0.1:0" },
      secret: "probe-integration-test", store, port: 0, host: "127.0.0.1", timers: false, now: () => at + 300,
    });
    await probe.start();
    const peer = { id: "ptest-home", url: `http://127.0.0.1:${probe.port}` };
    const lock = await admin.connect();
    try {
      await lock.query("begin");
      await lock.query("select id from public.monitors where id = $1 for update", [mon.id]);
      expect(await sendReports(probe.o.secret, peer, [report(down(), 60)])).toBe(true);
      // The real store is waiting on the row lock. Refresh reads the pre-outage configuration
      // and replaces the cached object while this outcome is already in flight.
      await expect.poll(async () => (await admin.query(`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like 'select * from public.probe_lock_monitor(%'`)).rows[0].n).toBe(1);
      await probe.refresh();
      await lock.query("commit");
      await probe.idle();
      expect((await row()).state).toBe("down");
      expect(await sendReports(probe.o.secret, peer, [report(pass(false, "sfo3"), 30), report(pass(), 120)])).toBe(true);
      await probe.idle();
      expect(await row()).toMatchObject({ state: "down", probe_pass_streak: 1 });
      expect((await incidents())[0].resolved_at).toBeNull();
      expect(await sendReports(probe.o.secret, peer, [report(pass(), 180)])).toBe(true);
      await probe.idle();
      expect((await row()).state).toBe("up");
    } finally {
      await lock.query("rollback");
      lock.release();
      await probe.stop();
    }
  });

  it.each(["edit", "pause/resume", "pause expiry", "restart"])("round 9: degraded survives %s until a fast pass", async (change) => {
    for (let i = 0; i < 3; i++) await apply(pass(true), i * 60);
    if (change === "edit") await edit();
    if (change === "pause/resume") {
      await admin.query("select public.pause_monitor($1, $2, null, 'maintenance')", [ws, mon.id]);
      await admin.query("select public.resume_monitor($1, $2)", [ws, mon.id]);
      await reload();
    }
    if (change === "pause expiry") {
      await admin.query("select public.pause_monitor($1, $2, 1, 'maintenance')", [ws, mon.id]);
      // Advance the stored window, not the test wall clock. Pausing already reset the counters.
      await admin.query("update public.monitors set paused_at = now() - interval '2 minutes', paused_until = now() - interval '1 minute' where id = $1", [mon.id]);
      await reload();
    }
    const other = Store.connect(probeUrl);
    try { await other.apply(report(pass(true), 180)); } finally { await other.close(); }
    expect((await row()).state).toBe("degraded");
    await apply(pass(), 240);
    expect((await row()).state).toBe("up");
  });

  it.each(["edit", "pause/resume"])("%s resets recovery to two fresh passes in the database", async (change) => {
    await apply(down());
    await apply(pass(), 60);
    const old = report(pass(), 120);
    if (change === "edit") await edit();
    else {
      await admin.query("select public.pause_monitor($1, $2, null, null)", [ws, mon.id]);
      await admin.query("select public.resume_monitor($1, $2)", [ws, mon.id]);
      await reload();
    }
    expect((await row()).probe_pass_streak).toBe(0);
    await expect(store.apply(old)).resolves.toBe("moved");
    await apply(pass(), 180);
    expect((await row()).state).toBe("down");
    await apply(pass(), 240);
    expect((await row()).state).toBe("up");
  });

  it("an address change clears state, closes the old incident and fences the old target", async () => {
    await apply(down());
    const old = report(down(), 60);
    await edit("https://example.com/new");
    expect(await row()).toMatchObject({ state: null, state_since: null, probe_pass_streak: 0, probe_outcome_at: null });
    expect((await incidents())[0].resolved_at).not.toBeNull();
    await expect(store.apply(old)).resolves.toBe("moved");
    await apply(down(), 120);
    expect(await incidents()).toHaveLength(2);
  });

  it("advances the version for pause and resume even in a single transaction", async () => {
    const c = await admin.connect();
    try {
      await c.query("begin");
      await c.query("select public.pause_monitor($1, $2, null, null)", [ws, mon.id]);
      const v = (await c.query("select updated_at::text as v from public.monitors where id = $1", [mon.id])).rows[0].v;
      await c.query("select public.resume_monitor($1, $2)", [ws, mon.id]);
      expect((await c.query("select updated_at::text as v from public.monitors where id = $1", [mon.id])).rows[0].v).not.toBe(v);
      await c.query("commit");
    } finally { await c.query("rollback"); c.release(); }
  });

  it.each(["edit", "pause"])("judges a concurrent %s after acquiring the row lock", async (change) => {
    const lock = await admin.connect();
    let pending: ReturnType<Store["apply"]> | undefined;
    try {
      await lock.query("begin");
      if (change === "edit") await lock.query("update public.monitors set updated_at = now() where id = $1", [mon.id]);
      else await lock.query("select public.pause_monitor($1, $2, null, null)", [ws, mon.id]);
      pending = apply(down());
      await expect.poll(async () => (await admin.query(`select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like 'select * from public.probe_lock_monitor(%'`)).rows[0].n).toBe(1);
      await lock.query("commit");
      expect(await pending).toBe(change === "edit" ? "moved" : "paused");
      expect((await row()).state).toBeNull();
      expect(await incidents()).toHaveLength(0);
    } finally {
      await lock.query("rollback");
      lock.release();
      await pending;
    }
  });

  it("reapplying the additive migration preserves live counters and its trigger has no public grant", async () => {
    await apply(down());
    await apply(pass(), 60);
    const before = await row();
    await admin.query(readFileSync(new URL("../../supabase/migrations/20261022101144_probe_row_state.sql", import.meta.url), "utf8"));
    expect(await row()).toEqual(before);
    const fn = (await admin.query(`select prosecdef, proacl::text as acl from pg_proc
      where oid = 'public.reset_probe_state_on_edit()'::regprocedure`)).rows[0];
    expect(fn.prosecdef).toBe(false);
    expect(fn.acl).not.toMatch(/(?:^|[,{])(?:anon|authenticated)?=X/);
  });

  it("persists slow and DNS streaks across homes and resets them on version change", async () => {
    await apply(pass(true));
    await new Store(store.pool).apply(report(pass(true), 60));
    await edit();
    await apply(pass(true), 120);
    expect(await row()).toMatchObject({ state: "up", probe_slow_streak: 1 });
    await apply(pass(true), 180);
    await apply(pass(true), 240);
    expect((await row()).state).toBe("degraded");
    await admin.query("update public.monitors set type = 'dns', state = null, state_since = null, updated_at = now() where id = $1", [mon.id]);
    await reload();
    await apply({ first: fail() }, 300);
    expect(await row()).toMatchObject({ state: null, probe_fail_streak: 1 });
    await new Store(store.pool).apply(report({ first: fail("sfo3") }, 360));
    expect((await row()).state).toBe("down");
  });

  it("blips and unconfirmed failures neither count nor break recovery and slow streaks", async () => {
    await apply(pass(true));
    await apply({ first: fail(), confirm: pass().first }, 60);
    await apply({ first: fail() }, 120);
    await apply(pass(true), 180);
    await apply(pass(true), 240);
    expect((await row()).state).toBe("degraded");
    await apply(down(), 300);
    await apply(pass(), 360);
    await apply({ first: fail(), confirm: pass().first }, 420);
    await apply({ first: fail() }, 480);
    expect((await row()).probe_pass_streak).toBe(1);
    await apply(pass(), 540);
    expect((await row()).state).toBe("up");
  });

  it("resends across two homes and a restart count once, including same-second locations", async () => {
    await apply(down());
    const first = report(pass(), 60);
    const results = await Promise.all([store.apply(first), new Store(store.pool).apply(first)]);
    expect(results.sort()).toEqual(["duplicate", "written"]);
    expect((await row()).probe_pass_streak).toBe(1);
    const restarted = Store.connect(probeUrl);
    try { expect(await restarted.apply(first)).toBe("duplicate"); } finally { await restarted.close(); }
    // Same second, distinct location: the existing clock-resolution contract allows this pass.
    await apply(pass(false, "sfo3"), 60);
    expect((await row()).state).toBe("up");
    expect(await store.apply(first)).toBe("duplicate");
  });

  it("serializes competing homes so concurrent failures open one incident and two passes close it", async () => {
    await Promise.all([apply(down()), apply({ first: fail("sfo3"), confirm: fail() })]);
    expect(await incidents()).toHaveLength(1);
    await Promise.all([apply(pass(), 60), apply(pass(false, "sfo3"), 60)]);
    expect((await row()).state).toBe("up");
    expect((await incidents())[0].timeline.filter((x: { text: string }) => x.text === "Two checks passed, incident closed")).toHaveLength(1);
  });

  it("a steady fast pass and a steady degraded slow pass update no row", async () => {
    await apply(pass());
    const first = await row();
    expect(await apply(pass(), 60)).toBe("unchanged");
    expect(await row()).toEqual(first);
    for (let i = 2; i <= 4; i++) await apply(pass(true), i * 60);
    const degraded = await row();
    expect(await apply(pass(true), 300)).toBe("unchanged");
    expect(await row()).toEqual(degraded);
  });

  it("a formerly harmless pass resent after newer counting cannot reset a slow streak", async () => {
    await apply(pass());
    const noop = report(pass(false, "sfo3"), 60);
    expect(await store.apply(noop)).toBe("unchanged");
    await apply(pass(true), 120);
    expect(await new Store(store.pool).apply(noop)).toBe("moved");
    expect((await row()).probe_slow_streak).toBe(1);
  });

  it("keeps the last 20 failures only", async () => {
    for (let i = 0; i < 25; i++) {
      await apply({ first: { ...fail(), failure: { kind: "timeout", message: `#${i}` } } }, 300 + i);
    }
    const rows = await admin.query("select message from public.check_failures where monitor_id = $1 order by at desc", [mon.id]);
    expect(rows.rows).toHaveLength(20);
    expect(rows.rows[0].message).toBe("#24");
    expect(rows.rows[19].message).toBe("#5");
  });

  it("writes nothing for a monitor paused or deleted after a check began", async () => {
    await admin.query("select public.pause_monitor($1, $2, null, null)", [ws, mon.id]);
    expect(await apply(down())).toBe("paused");
    expect(await apply(pass())).toBe("paused");
    expect((await row()).state).toBeNull();
    for (const table of ["incidents", "transitions", "check_failures"]) {
      expect((await admin.query(`select 1 from public.${table} where monitor_id = $1`, [mon.id])).rows).toHaveLength(0);
    }
    await admin.query("delete from public.monitors where id = $1", [mon.id]);
    expect(await apply(down())).toBe("paused");
  });

  it("opens the secret headers the dashboard sealed, and gives none for a value that won't open", async () => {
    const key = randomBytes(32);
    const keyed = new Store(store.pool, key);
    await admin.query("insert into public.monitor_secrets (monitor_id, workspace_id, name, sealed) values ($1, $2, 'X-Api-Key', $3)", [
      mon.id,
      ws,
      seal("k-123", headerContext(mon.id, "X-Api-Key"), key),
    ]);
    const load = async (s: Store) => (await s.loadMonitors()).find((m) => m.id === mon.id)!;
    expect((await load(keyed)).headers).toEqual({ "X-Api-Key": "k-123" });
    // Without the key, or under another one, the monitor isn't given half its headers.
    expect((await load(store)).headers).toBeNull();
    expect((await load(new Store(store.pool, randomBytes(32)))).headers).toBeNull();
    // A value sealed for another header doesn't open under this one's name.
    await admin.query("update public.monitor_secrets set sealed = $2 where monitor_id = $1", [mon.id, seal("k-123", headerContext(mon.id, "Other"), key)]);
    expect((await load(keyed)).headers).toBeNull();
    await admin.query("delete from public.monitor_secrets where monitor_id = $1", [mon.id]);
    expect((await load(store)).headers).toEqual({});
  });

  it("rolls back counters, ordering and every effect when one fails, then accepts the retry", async () => {
    await apply(pass());
    const before = await row();
    const broken = down();
    broken.confirm!.snippet = "x".repeat(301); // Fails after the row update and the first failure insert.
    await expect(apply(broken, 60)).rejects.toThrow();
    expect(await row()).toEqual(before);
    expect(await incidents()).toHaveLength(0);
    expect((await admin.query("select * from public.check_failures where monitor_id = $1", [mon.id])).rows).toHaveLength(0);
    expect(await apply(down(), 60)).toBe("written");
    expect((await row()).state).toBe("down");
  });

  it("flushes rollups in one function call and merges a window written twice", async () => {
    const row = { monitorId: mon.id, location: "tor1", windowStart: at, checks: 4, failures: 1, p50Ms: 100, p95Ms: 300, maxMs: 300 };
    await store.flushRollups([row, { ...row, location: "sfo3", p50Ms: null, p95Ms: null, maxMs: null, failures: 4 }, { ...row, monitorId: "mon_gone" }]);
    await store.flushRollups([{ ...row, checks: 2, failures: 0, p50Ms: 400, p95Ms: 500, maxMs: 900 }]);
    const rows = await admin.query("select location, checks, failures, p50_ms, p95_ms, max_ms from public.rollups_5m where monitor_id = $1 order by location", [mon.id]);
    expect(rows.rows).toEqual([
      { location: "sfo3", checks: 4, failures: 4, p50_ms: null, p95_ms: null, max_ms: null },
      // p50 weighted by passing checks: (100·3 + 400·2) / 5 = 220.
      { location: "tor1", checks: 6, failures: 1, p50_ms: 220, p95_ms: 500, max_ms: 900 },
    ]);
    expect((await admin.query("select 1 from public.rollups_5m where monitor_id = 'mon_gone'")).rows).toHaveLength(0);
    expect((await admin.query("select windows, checks, failures from public.rollups_1d where monitor_id = $1", [mon.id])).rows)
      .toEqual([{ windows: 1, checks: 10, failures: 5 }]);
  });

  it("refuses mismatched flush arrays atomically", async () => {
    await expect(store.pool.query("select public.probe_flush_rollups($1,$2,$3,$4,$5,$6,$7,$8)",
      [[mon.id], [], [new Date(at * 1000).toISOString()], [1], [0], [1], [1], [1]]))
      .rejects.toMatchObject({ code: "22023", message: "probe_rollup_arrays_invalid" });
    expect((await admin.query("select 1 from public.rollups_5m where monitor_id = $1", [mon.id])).rows).toEqual([]);
  });
});
