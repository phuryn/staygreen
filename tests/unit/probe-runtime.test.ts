import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RollupRow } from "../../probe/rollup";
import { sendReports, type Report } from "../../probe/peer";
import { Probe, supabaseBackoff, type ProbeOptions, type ProbeStore } from "../../probe/runtime";
import { BOOTSTRAP_URL, Rdap, type DomainResult } from "../../src/checks/rdap";
import { ranked } from "../../probe/schedule";
import { configOf, judge, plan } from "../../probe/heartbeat";
import { fresh, step, type Effect, type MonitorState } from "../../probe/state";
import type { HeartbeatJudged, HeartbeatMonitor, Monitor, ProbeRow } from "../../probe/store";
import { Canary } from "../../probe/canary";
import { askConfirm } from "../../probe/peer";
import { SERVICE_KEY } from "@/lib/service-monitor";

/* Two probes in one process, a target on this machine that can be taken down, and a store that
   records what the probes write. The clock is the test's, stepped one second at a time, so an
   hour of checks runs in seconds. This is stage 2.2's done-when, minus the real database: every
   monitor is checked from both locations, a target taken down opens one incident confirmed from
   the other location, and two passes close it. */

const SECRET = "runtime-test-secret-of-32-characters!";

let target: http.Server;
let targetUrl = "";
let up = true;
let lastKey: string | undefined;
let hold: Promise<void> | null = null;

beforeAll(async () => {
  target = http.createServer(async (req, res) => {
    if (req.url?.endsWith("/hold") && hold) await hold;
    lastKey = req.headers["x-api-key"] as string | undefined;
    // A monitor's new address answers whatever the old one does: `?new` always, `?gone` never.
    if (req.url?.endsWith("?gone")) res.writeHead(503).end("gone");
    else if (up || req.url?.endsWith("?new")) res.writeHead(200).end("fine");
    else res.writeHead(503).end('{"error":"db down","token":"abc"}');
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/health`;
});

afterAll(() => new Promise((r) => target.close(r)));

type StoredMonitor = Monitor & MonitorState & { since: number | null; outcomeAt: number | null; locations: string[]; countingVersion: string };

class FakeStore implements ProbeStore {
  live: ProbeRow[] = [];
  monitors: StoredMonitor[] = [];
  applied: { monitorId: string; effects: Effect[]; atSec: number }[] = [];
  rollups: RollupRow[] = [];
  /** Incidents as the real store keeps them: one open per monitor, closed by a transition out of
      down. */
  open = new Set<string>();
  closes: { monitorId: string; atSec: number }[] = [];
  left: string[] = [];
  /** Heartbeats, writes and leaving, in the order they landed. */
  log: string[] = [];
  beatGate: Promise<void> | null = null;
  /** Holds a read after it has looked at the rows, as a slow query would. */
  loadGate: Promise<void> | null = null;
  loadError = false;
  async heartbeat() {
    if (this.beatGate) await this.beatGate;
    this.log.push("beat");
  }
  async leave(id: string) {
    this.log.push("leave");
    this.left.push(id);
    this.live = this.live.filter((p) => p.id !== id);
  }
  async liveProbes() {
    return this.live;
  }
  async loadMonitors() {
    if (this.loadError) throw Error("Database unavailable");
    const rows = this.monitors.map(({ state, slowStreak: _slow, passStreak: _pass, failStreak: _fail,
      since, outcomeAt, locations, countingVersion: _version, ...m }) => {
      if (m.type !== "supabase") return m;
      const failures = this.effects("record_failure").filter(e => e.monitorId === m.id && e.kind === "record_failure");
      const latest = failures.filter(e => e.atSec >= (since ?? Infinity)).at(-1);
      const incident = this.open.has(m.id) ? this.effects("open_incident").filter(e => e.monitorId === m.id).at(-1) : undefined;
      return { ...m, config: { ...m.config, __state: state,
        __failureStatus: latest?.kind === "record_failure" ? latest.result.status : null,
        __incidentStatus: incident?.kind === "open_incident" ? incident.evidence.status : null, __outcomeAt: outcomeAt } };
    });
    if (this.loadGate) await this.loadGate;
    return rows;
  }
  async flushRollups(rows: RollupRow[]) {
    // As Postgres does: one upsert can't name a key twice ("ON CONFLICT DO UPDATE command cannot
    // affect row a second time"), and the whole batch fails.
    const keys = rows.map((r) => `${r.monitorId}|${r.location}|${r.windowStart}`);
    if (new Set(keys).size !== keys.length) throw new Error("ON CONFLICT DO UPDATE command cannot affect row a second time");
    this.rollups.push(...rows);
  }
  async apply(r: Report) {
    // This fake owns the counters, like the locked row. SQL locking/reset/ordering is proved in
    // probe-store.test.ts; this harness makes the scheduler, checks and peer delivery real.
    const row = this.monitors.find((x) => x.id === r.monitorId);
    if (!row || row.paused) return "paused" as const;
    if (row.countingVersion !== row.version) {
      Object.assign(row, fresh(row.state), { countingVersion: row.version, outcomeAt: null, locations: [] });
    }
    if (row.version !== r.version || (row.since !== null && r.atSec < row.since) ||
        (row.outcomeAt !== null && r.atSec < row.outcomeAt)) return "moved" as const;
    if (row.outcomeAt === r.atSec && row.locations.includes(r.outcome.first.location)) return "duplicate" as const;
    const { next, effects } = step(row.type, row, r.outcome);
    const changed = next.state !== row.state || next.slowStreak !== row.slowStreak ||
      next.passStreak !== row.passStreak || next.failStreak !== row.failStreak;
    if (!changed && !effects.length) return "unchanged" as const;
    this.log.push("apply");
    this.applied.push({ monitorId: row.id, effects, atSec: r.atSec });
    Object.assign(row, next, { outcomeAt: r.atSec, locations: row.outcomeAt === r.atSec ? [...row.locations, r.outcome.first.location] : [r.outcome.first.location] });
    for (const e of effects) {
      if (e.kind === "transition") {
        row.since = r.atSec;
        if (e.from === "down" && this.open.delete(row.id)) this.closes.push({ monitorId: row.id, atSec: r.atSec });
      }
      if (e.kind === "open_incident") this.open.add(row.id);
    }
    return "written" as const;
  }
  effects(kind: Effect["kind"]) {
    return this.applied.flatMap((a) => a.effects.filter((e) => e.kind === kind).map((e) => ({ ...e, monitorId: a.monitorId, atSec: a.atSec })));
  }
}

const monitor = (id: string): StoredMonitor => ({
  ...fresh(),
  outcomeAt: null,
  locations: [],
  countingVersion: "1",
  id,
  workspaceId: "ws_test",
  name: `Monitor ${id}`,
  type: "http",
  target: targetUrl,
  intervalSec: 60,
  config: { method: "GET", expect: "2xx", keyword: null, slowMs: 3000, timeoutSec: 5, assertions: [] },
  state: null,
  paused: false,
  builder: false,
  headers: {},
  version: "1",
  since: null,
});

let clock = 1_800_000_000;
let probes: Probe[] = [];

async function fleet(store: FakeStore, locations: string[], extra: Partial<ProbeOptions> = {}) {
  probes = locations.map(
    (location) =>
      new Probe({
        self: { id: `${location}-a`, location, builderOnly: false, url: "http://127.0.0.1:0" },
        secret: SECRET,
        store,
        port: 0,
        host: "127.0.0.1",
        now: () => clock,
        recheckAfterSec: 0,
        spreadMs: 0,
        checks: { allow: () => true },
        timers: false,
        ...extra,
      }),
  );
  for (const p of probes) await p.start();
  store.live = probes.map((p) => ({ ...p.o.self, url: `http://127.0.0.1:${p.port}` }));
  for (const p of probes) await p.beat();
}

/** Steps the clock, runs every probe's due checks and delivers their reports. */
async function runFor(seconds: number, refresh = false) {
  for (let i = 0; i < seconds; i++) {
    clock++;
    for (const p of probes) p.tick();
    for (const p of probes) await p.idle();
    if (refresh && clock % 30 === 0) for (const p of probes) await p.refresh().catch(() => {});
    for (const p of probes) await p.sendOutbox();
    for (const p of probes) await p.idle();
  }
}

afterEach(async () => {
  for (const p of probes) await p.stop();
  probes = [];
  up = true;
});

const supabaseMonitor = (id = "mon_supabase_backoff"): StoredMonitor => ({
  ...monitor(id), type: "supabase", intervalSec: 180, unchecked: true,
  config: { projectUrl: "https://abcdefghijklmnopqrst.supabase.co", databaseRead: "" },
  headers: { [SERVICE_KEY]: "sb_publishable_abcdefghijklmnop123456789" },
});

describe("Supabase refusal backoff from recorded state", () => {
  let clockBefore: number;
  beforeAll(() => { clockBefore = clock; });
  afterAll(() => { clock = clockBefore; });
  it.each([400, 401, 403, 404, 499])("backs off status %s only while down, from either incident or latest failure", status => {
    const m = supabaseMonitor();
    for (const source of ["__failureStatus", "__incidentStatus"]) {
      for (const state of [null, "up", "degraded", "down"]) {
        expect(supabaseBackoff({ ...m, config: { ...m.config, __state: state, [source]: status } })).toBe(state === "down");
      }
    }
    for (const status of [undefined, 200, 301, 429, 500, 503]) {
      expect(supabaseBackoff({ ...m, config: { ...m.config, __state: "down", __failureStatus: status } })).toBe(false);
    }
  });

  it.each(["passing", "silent"])("keeps the plan interval when one location refuses and its peer is %s", async peer => {
    const store = new FakeStore();
    const m = supabaseMonitor();
    m.state = "up";
    store.monitors = [m];
    await fleet(store, ["tor1", "sfo3"]);
    const home = probes.find(p => p.o.self.id === ranked(m.id, store.live)[0].id)!;
    const other = probes.find(p => p !== home)!;
    const times: number[] = [];
    home.o.checks!.serviceFetch = async () => { times.push(clock); return { status: 401, body: "{}" }; };
    other.o.checks!.serviceFetch = async () => ({ status: 200, body: '{"version":"v2"}' });
    if (peer === "silent") other.monitors.delete(m.id); // Live peer, but /confirm answers 404.
    for (let i = 0; i < 720; i++) {
      await runFor(1);
      if (clock % 30 === 0) await home.refresh();
    }
    expect(m.state).toBe("up");
    expect(store.open.size).toBe(0);
    expect(times.length).toBeGreaterThanOrEqual(2);
    expect(times[1] - times[0]).toBeLessThanOrEqual(360);
    expect(home.wheel.when(m.id)! - clock).toBeLessThanOrEqual(360);
  });

  it.each([{ locations: ["tor1"] }, { locations: ["tor1", "sfo3"] }])("backs off after confirmation with locations $locations and shares the allowance with second looks", async ({ locations }) => {
    const store = new FakeStore();
    const m = supabaseMonitor();
    store.monitors = [m];
    const times: number[] = [];
    await fleet(store, locations, { checks: { serviceFetch: async () => {
      times.push(clock); return { status: 403, body: "{}" };
    } } });
    await runFor(400, true);
    expect(m.state).toBe("down");
    expect(times).toHaveLength(2); // Initial failure and the ordinary confirmation (solo included).
    const before = store.applied.length;
    for (const p of probes) {
      expect(await p.runCheck(p.monitors.get(m.id)!, true)).toBeNull();
      expect(p.wheel.when(m.id)!).toBeGreaterThanOrEqual(times[1] + 1800);
    }
    expect(store.applied).toHaveLength(before); // No synthetic cached failure.
    await runFor(1300, true);
    expect(times).toHaveLength(2);
    await runFor(500, true);
    expect(times.length).toBeGreaterThan(2); // Refusals are actually retried, never frozen.
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(1800);
  });

  it("recovers on the next allowed checks even across a failed database refresh, then detects another outage", async () => {
    const store = new FakeStore();
    const m = supabaseMonitor();
    store.monitors = [m];
    let healthy = false;
    let requests = 0;
    await fleet(store, ["tor1", "sfo3"], { checks: { serviceFetch: async () => {
      requests++; return { status: healthy ? 200 : 401, body: '{"version":"v2"}' };
    } } });
    await runFor(400, true);
    expect(m.state).toBe("down");
    expect(requests).toBe(2);
    store.loadError = true;
    await expect(probes[0].refresh()).rejects.toThrow("Database unavailable");
    healthy = true;
    await runFor(1300, true);
    expect(requests).toBe(2);
    await runFor(500, true);
    expect(m.state).toBe("up");
    expect(store.closes).toHaveLength(1); // Two real passes through the ordinary reducer.
    expect(requests).toBe(6); // Auth and Storage once at each location.
    store.loadError = false;
    for (const p of probes) await p.refresh();
    await runFor(400, true);
    expect(requests).toBeGreaterThan(6);
    healthy = false;
    await runFor(400, true);
    expect(m.state).toBe("down");
    expect(store.effects("open_incident")).toHaveLength(2);
  });

  it("reconstructs the delay after a restart and lets a verified save start immediately", async () => {
    const store = new FakeStore();
    const m = supabaseMonitor();
    store.monitors = [m];
    let requests = 0;
    let healthy = false;
    const checks = { serviceFetch: async () => {
      requests++; return { status: healthy ? 200 : 401, body: '{"version":"v2"}' };
    } };
    await fleet(store, ["tor1"], { checks });
    await runFor(400, true);
    expect(m.state).toBe("down");
    for (const p of probes) await p.stop();
    probes = [];
    await fleet(store, ["tor1"], { checks });
    await runFor(600, true);
    expect(requests).toBe(2);
    // The verified save resets state and version; old failure history is still present.
    healthy = true;
    Object.assign(m, fresh(), { version: "2", outcomeAt: null, since: null, unchecked: true });
    await probes[0].refresh();
    await runFor(10, true);
    expect(m.state).toBe("up");
    expect(requests).toBe(4);
  });

  it("bounds a restart after a recovery pass whose outcome was replaced by a peer failure", async () => {
    const store = new FakeStore();
    const m = supabaseMonitor();
    store.monitors = [m];
    const failure = { ok: false, ms: 1, status: 401, failure: { kind: "status" as const, message: "Auth refused" } };
    await store.apply({ monitorId: m.id, version: m.version, atSec: clock - 2000,
      outcome: { first: { ...failure, location: "tor1" }, confirm: { ...failure, location: "sfo3" } } });
    await store.apply({ monitorId: m.id, version: m.version, atSec: clock - 60,
      outcome: { first: { ok: true, ms: 1, location: "tor1" } } });
    await store.apply({ monitorId: m.id, version: m.version, atSec: clock - 30,
      outcome: { first: { ...failure, location: "sfo3" } } });
    expect(m.state).toBe("down");
    expect(m.passStreak).toBe(1);
    let requests = 0;
    await fleet(store, ["tor1"], { checks: { serviceFetch: async () => {
      requests++; return { status: 200, body: '{"version":"v2"}' };
    } } });
    await runFor(1700, true);
    expect(requests).toBe(0);
    await runFor(200, true);
    expect(requests).toBeGreaterThanOrEqual(2);
    expect(m.state).toBe("up");
  });
});

describe("two probes", () => {
  it("suppresses isolated failures in reports, first writes, rollups and peer confirmations, then recovers", async () => {
    const previousClock = clock;
    try {
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_canary"), unchecked: true }];
    let reachable = false;
    const canary = new Canary(async () => Array(5).fill(reachable), () => clock * 1000);
    up = false;
    await fleet(store, ["tor1"], { canary });
    await runFor(120);
    await probes[0].flush();
    expect(store.effects("open_incident")).toHaveLength(0);
    expect(store.effects("record_failure")).toHaveLength(0);
    expect(store.rollups).toHaveLength(0);
    expect(probes[0].health()).toMatchObject({ ready: false, canary: { status: "isolated" } });
    expect(await askConfirm(SECRET, { id: "tor1-a", url: `http://127.0.0.1:${probes[0].port}` }, "mon_canary", "1")).toBeNull();
    expect(probes[0].counts.confirms).toBe(0); // Neither self-confirm nor peer confirmation escapes the veto.
    reachable = true;
    clock += 11;
    await canary.test();
    await runFor(120);
    expect(store.effects("open_incident")).toHaveLength(1);
    expect(probes[0].health().canary?.status).toBe("healthy");
    } finally { clock = previousClock; }
  });
  it("while isolated, a new failing monitor waits for its turn instead of a quick check every refresh, and gets it once the network is back", async () => {
    // Review 67: each discarded first check cleared its quick slot, so every refresh asked again.
    const previousClock = clock;
    try {
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_isolated"), intervalSec: 21_600, unchecked: true }];
    let reachable = false;
    const canary = new Canary(async () => Array(5).fill(reachable), () => clock * 1000);
    up = false;
    await fleet(store, ["tor1"], { canary });
    for (let i = 0; i < 8; i++) {
      await runFor(30);
      await probes[0].refresh();
    }
    expect(probes[0].counts.checks).toBeLessThanOrEqual(1);
    const before = probes[0].counts.checks;
    reachable = true;
    clock += 11;
    await canary.test();
    await probes[0].refresh();
    await runFor(15);
    expect(probes[0].counts.checks).toBeGreaterThan(before);
    } finally { clock = previousClock; }
  });

  it("contacts Supabase again for a solo confirmation after one refused read", async () => {
    const store = new FakeStore();
    const m = { ...monitor("mon_supabase"), type: "supabase" as const, unchecked: true,
      config: { projectUrl: "https://abcdefghijklmnopqrst.supabase.co", databaseRead: "" },
      headers: { [SERVICE_KEY]: "sb_publishable_abcdefghijklmnop123456789" } };
    store.monitors = [m];
    let requests = 0;
    await fleet(store, ["tor1"], { checks: { serviceFetch: async () => {
      requests++;
      return requests === 1 ? { status: 401, body: "{}" } : { status: 200, body: '{"version":"v2"}' };
    } } });
    await runFor(10);
    expect(requests).toBe(3); // First refusal, then real Auth and Storage reads.
    expect(store.open.size).toBe(0);
    expect(m.config).not.toHaveProperty("__runtime.rejected");
  });

  it("check every monitor once a minute, alternating locations, and home each one once", async () => {
    const store = new FakeStore();
    store.monitors = ["mon_a", "mon_b", "mon_c", "mon_d"].map(monitor);
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(600);
    const checks = probes.map((p) => p.counts.checks);
    expect(checks[0] + checks[1]).toBeGreaterThanOrEqual(4 * 9);
    expect(checks[0] + checks[1]).toBeLessThanOrEqual(4 * 10);
    expect(Math.min(...checks)).toBeGreaterThanOrEqual(16);
    // Every monitor reached `up` exactly once, written by its home.
    const ups = store.effects("transition");
    expect(ups.map((e) => e.monitorId).sort()).toEqual(["mon_a", "mon_b", "mon_c", "mon_d"]);
    for (const m of store.monitors) expect(m.state).toBe("up");
    for (const p of probes) expect("states" in p).toBe(false);
  });

  it("check a monitor that has no state yet within seconds, not at its turn hours away, then keep its turns", async () => {
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_fresh"), intervalSec: 21_600, unchecked: true }, { ...monitor("mon_seen"), intervalSec: 21_600 }];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(10);
    expect(store.monitors.map((m) => m.state)).toEqual(["up", null]);
    const first = probes[0].counts.checks + probes[1].counts.checks;
    expect(first).toBe(1);
    await runFor(600);
    expect(probes[0].counts.checks + probes[1].counts.checks).toBe(first);
  });

  it("give a version one quick first check, however often a refresh still reads it as unchecked", async () => {
    // The worst case: a first check that writes nothing (unconfirmed, or a DNS failure waiting
    // for its second), so every refresh loads the monitor as unchecked again.
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_blip"), intervalSec: 21_600, unchecked: true }];
    await fleet(store, ["tor1", "sfo3"]);
    for (let i = 0; i < 8; i++) {
      await runFor(30);
      for (const p of probes) await p.refresh();
    }
    expect(probes[0].counts.checks + probes[1].counts.checks).toBe(1);
    // An edit is a new version, which gets its own.
    store.monitors[0].version = "2";
    for (const p of probes) await p.refresh();
    await runFor(15);
    expect(probes[0].counts.checks + probes[1].counts.checks).toBe(2);
  });

  it("open one incident when the target goes down, confirmed from the other location, and close it after two passes", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(180);
    expect(store.monitors[0].state).toBe("up");

    up = false;
    const downAt = clock;
    await runFor(300);
    const opened = store.effects("open_incident");
    expect(opened).toHaveLength(1);
    const evidence = (opened[0] as Extract<Effect, { kind: "open_incident" }>).evidence;
    expect(new Set(evidence.locations)).toEqual(new Set(["tor1", "sfo3"]));
    expect(evidence.snippet).toBe('{"error":"db down","token":"•••"}');
    expect(opened[0].atSec - downAt).toBeLessThanOrEqual(60);
    expect(store.monitors[0].state).toBe("down");
    expect(store.closes).toHaveLength(0);

    up = true;
    const upAt = clock;
    await runFor(180);
    const closed = store.closes;
    expect(closed).toHaveLength(1);
    // The second pass after the fix closes it: two intervals at most.
    expect(closed[0].atSec - upAt).toBeLessThanOrEqual(120);
    expect(store.monitors[0].state).toBe("up");
    expect(store.effects("open_incident")).toHaveLength(1);
  });

  it("confirm from itself after a pause when it is the only location left", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    await runFor(120);
    up = false;
    await runFor(120);
    const opened = store.effects("open_incident");
    expect(opened).toHaveLength(1);
    expect((opened[0] as Extract<Effect, { kind: "open_incident" }>).evidence.locations).toEqual(["tor1", "tor1"]);
  });

  it("leave a failure unconfirmed when the other location doesn't answer, rather than confirm it from here", async () => {
    const store = new FakeStore();
    store.monitors = ["mon_a", "mon_b", "mon_c", "mon_d", "mon_e", "mon_f"].map(monitor);
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    // sfo3 stops answering without leaving, as in a crash, so it stays in the live set for the
    // two minutes its last heartbeat lasts.
    const [nyc, sfo] = probes;
    const live = store.live;
    await sfo.stop();
    store.live = live;
    probes = [nyc];
    up = false;
    await runFor(240);
    expect(nyc.counts.unconfirmed).toBeGreaterThan(0);
    expect(store.effects("open_incident")).toHaveLength(0);
    expect(store.effects("transition").filter((e) => e.kind === "transition" && e.to === "down")).toHaveLength(0);
  });

  it("leave the live set on a planned stop, so the next beat confirms from itself instead of waiting two minutes", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    const [nyc, sfo] = probes;
    await sfo.stop();
    probes = [nyc];
    expect(store.left).toEqual(["sfo3-a"]);
    await nyc.beat();
    expect(nyc.peers.map((p) => p.id)).toEqual(["tor1-a"]);
    up = false;
    await runFor(120);
    expect(store.effects("open_incident")).toHaveLength(1);
    expect(nyc.counts.unconfirmed).toBe(0);
  });

  it("finish and write its own checks before it leaves on a planned stop, before handing ownership over", async () => {
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_a"), target: targetUrl.replace(/\/health$/, "/hold") }];
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    store.log = [];
    let open!: () => void;
    hold = new Promise((r) => (open = r));
    let started: Promise<void>[] = [];
    for (let i = 0; i < 120 && started.length === 0; i++) {
      clock++;
      started = nyc.tick();
    }
    expect(started).toHaveLength(1);
    const stopping = nyc.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.left).toEqual([]);
    open();
    await stopping;
    probes = [];
    hold = null;
    expect(store.log).toEqual(["apply", "leave"]);
  });

  it("wait for a heartbeat already on its way before it leaves, so the heartbeat can't bring it back", async () => {
    const store = new FakeStore();
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    store.log = [];
    let open!: () => void;
    store.beatGate = new Promise((r) => (open = r));
    const beating = nyc.beat();
    const stopping = nyc.stop();
    await new Promise((r) => setTimeout(r, 50));
    expect(store.left).toEqual([]);
    open();
    await Promise.all([beating, stopping]);
    probes = [];
    expect(store.log).toEqual(["beat", "leave"]);
  });

  it("start again from the row another probe wrote, so the next outage still opens", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    await runFor(120);
    up = false;
    await runFor(120);
    expect(store.effects("open_incident")).toHaveLength(1);
    // A probe that also took itself for home, in an overlapping handover, saw the recovery and
    // wrote it; this home never saw those recovery checks.
    up = true;
    store.monitors[0].state = "up";
    store.open.delete("mon_a");
    await nyc.refresh();
    up = false;
    await runFor(120);
    expect(store.effects("open_incident")).toHaveLength(2);
  });

  it("start again from the row another probe wrote, so an incident it opened still closes", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    await runFor(120);
    // The overlapping home saw the outage and opened the incident; this home never saw it.
    store.monitors[0].state = "down";
    store.open.add("mon_a");
    await nyc.refresh();
    await runFor(180);
    expect(store.closes).toHaveLength(1);
    expect(store.monitors[0].state).toBe("up");
  });

  it("count nothing checked against the old address once the owner changes it mid-incident, and check the new one from the next refresh", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    await runFor(120);
    up = false;
    await runFor(120);
    expect(store.effects("open_incident")).toHaveLength(1);
    // Saving a new address clears the state, closes the incident (`update_monitor`, 010) and moves
    // the row's version. Until its next refresh the probe still checks the old address, which is
    // still down.
    store.monitors[0] = { ...store.monitors[0], target: `${targetUrl}?new`, state: null, version: "2" };
    store.open.delete("mon_a");
    await runFor(120);
    expect(store.effects("open_incident")).toHaveLength(1);
    expect(store.monitors[0].state).toBeNull();
    expect(nyc.counts.moved).toBeGreaterThan(0);
    // The new address answers; from the refresh on, it is what's checked and counted.
    up = true;
    await nyc.refresh();
    await runFor(120);
    expect(store.monitors[0].state).toBe("up");
    expect(store.effects("open_incident")).toHaveLength(1);
  });

  it("count nothing another probe checked against the old version once the home holds the new one", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    const home = probes.find((p) => p.o.self.id === ranked("mon_a", store.live)[0].id)!;
    store.monitors[0] = { ...store.monitors[0], target: `${targetUrl}?new`, state: null, version: "2" };
    await home.refresh();
    // The old address goes down; the other probe hasn't refreshed and still checks it.
    up = false;
    const failures = store.effects("record_failure").length;
    await runFor(180);
    expect(store.effects("record_failure")).toHaveLength(failures);
    expect(store.effects("open_incident")).toHaveLength(0);
    expect(home.counts.moved).toBeGreaterThan(0);
    expect(store.monitors[0].state).toBe("up");
  });

  it("confirm a failure only from a probe that checked the same version", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    const home = probes.find((p) => p.o.self.id === ranked("mon_a", store.live)[0].id)!;
    const other = probes.find((p) => p !== home)!;
    // The new address is down, and so is the old one the other probe still checks: its second
    // look would be at the wrong address, so it gives none.
    store.monitors[0] = { ...store.monitors[0], target: `${targetUrl}?gone`, state: null, version: "2" };
    await home.refresh();
    up = false;
    await runFor(180);
    expect(store.effects("open_incident")).toHaveLength(0);
    // Once both hold the new version, the outage is confirmed.
    await other.refresh();
    await runFor(180);
    expect(store.effects("open_incident")).toHaveLength(1);
    expect(store.monitors[0].state).toBe("down");
  });

  it("hands a newer report to the store even when its cached config still has an old version and pause", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    const [home] = probes;
    home.monitors.set("mon_a", { ...home.monitors.get("mon_a")!, paused: true });
    store.monitors[0].version = "2";
    const peer = store.live[0];
    const failed = { ok: false, ms: 1, location: "sfo3", failure: { kind: "status" as const, message: "failed" } };
    expect(await sendReports(SECRET, peer, [{ monitorId: "mon_a", version: "2", atSec: clock,
      outcome: { first: failed, confirm: { ...failed, location: "tor1" } } }])).toBe(true);
    await home.idle();
    expect(store.monitors[0].state).toBe("down");
    for (const offset of [1, 2]) {
      expect(await sendReports(SECRET, peer, [{ monitorId: "mon_a", version: "2", atSec: clock + offset,
        outcome: { first: { ok: true, ms: 1, location: "sfo3" } } }])).toBe(true);
      await home.idle();
    }
    expect(store.monitors[0].state).toBe("up");
    expect(store.closes).toHaveLength(1);
  });

  it("start a monitor's streaks again when the owner edits it, so one pass of the new version doesn't close", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    await runFor(120);
    up = false;
    await runFor(120);
    expect(store.open.has("mon_a")).toBe(true);
    // One pass of two; then the owner changes the keyword, which leaves the state alone.
    up = true;
    let n = nyc.counts.checks;
    while (nyc.counts.checks < n + 1) await runFor(1);
    expect(store.monitors[0].passStreak).toBe(1);
    store.monitors[0] = { ...store.monitors[0], version: "2" };
    await nyc.refresh();
    n = nyc.counts.checks;
    while (nyc.counts.checks < n + 1) await runFor(1);
    expect(store.open.has("mon_a")).toBe(true);
    while (nyc.counts.checks < n + 2) await runFor(1);
    expect(store.open.has("mon_a")).toBe(false);
  });

  it("count no pass older than the outage it would close, including the first recovery pass", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    up = false;
    await runFor(180);
    expect(store.monitors[0].state).toBe("down");
    const home = probes.find((p) => p.o.self.id === ranked("mon_a", store.live)[0].id)!;
    const row = store.live.find((p) => p.id === home.o.self.id)!;
    // A pass from before the outage, whose report failed to send and is sent again now.
    const late = { monitorId: "mon_a", version: "1", atSec: store.monitors[0].since! - 30, outcome: { first: { ok: true, ms: 5, location: "sfo3" } } };
    expect(await sendReports(SECRET, row, [late])).toBe(true);
    await home.idle();
    expect(home.counts.moved).toBeGreaterThan(0);
    expect(store.monitors[0].passStreak).toBe(0);
  });

  it("count nothing older than the state the row has been in since, so a recovery another home wrote stays", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    await runFor(120);
    expect(store.monitors[0].state).toBe("up");
    // Another home's recovery is written as of two minutes from now, so the failure this one
    // sees next, and confirms from itself, is older than it.
    store.monitors[0].since = clock + 120;
    up = false;
    const before = nyc.counts.checks;
    while (nyc.counts.checks < before + 2) await runFor(1);
    expect(store.effects("open_incident")).toHaveLength(0);
    expect(nyc.counts.moved).toBeGreaterThan(0);
  });

  it("step the current row when the cached configuration predates an outage, and close only after two passes", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    // Seeded from a degraded row; then another home's confirmed failure landed.
    store.monitors[0].state = "degraded";
    await nyc.refresh();
    store.monitors[0].state = "down";
    store.open.add("mon_a");
    // Check by check, not by the clock: where the first one lands in its minute is the hash's.
    while (nyc.counts.checks < 1) await runFor(1);
    expect(store.open.has("mon_a")).toBe(true);
    expect(store.monitors[0].state).toBe("down");
    while (nyc.counts.checks < 2) await runFor(1);
    expect(store.open.has("mon_a")).toBe(false);
    expect(store.monitors[0].state).toBe("up");
  });

  it("ignore a refresh that a later one overtook, so an older row isn't put back", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    await runFor(120);
    // An edit overtakes a slow configuration read. State is never loaded into the probe.
    store.monitors[0].state = "down";
    let open!: () => void;
    store.loadGate = new Promise((r) => (open = r));
    const older = nyc.refresh();
    store.loadGate = null;
    store.monitors[0].state = "up";
    store.monitors[0].version = "2";
    await nyc.refresh();
    open();
    await older;
    expect(store.monitors[0].state).toBe("up");
    expect(nyc.monitors.get("mon_a")?.version).toBe("2");
  });

  it("leave counting in the store when a refresh read before a write lands afterwards", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1"]);
    const [nyc] = probes;
    await runFor(120);
    let open!: () => void;
    store.loadGate = new Promise((r) => (open = r));
    const refreshing = nyc.refresh();
    store.loadGate = null;
    up = false;
    await runFor(120);
    expect(store.monitors[0].state).toBe("down");
    open();
    await refreshing;
    expect(store.monitors[0].state).toBe("down");
  });

  it("take an outcome sent twice once, so a resent report can't count as the second pass", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    up = false;
    await runFor(180);
    expect(store.monitors[0].state).toBe("down");

    const home = probes.find((p) => p.o.self.id === ranked("mon_a", store.live)[0].id)!;
    const row = store.live.find((p) => p.id === home.o.self.id)!;
    // A second no real check has used, so only the resend can be a duplicate.
    const report = { monitorId: "mon_a", version: "1", atSec: clock + 1, outcome: { first: { ok: true, ms: 5, location: "sfo3" } } };
    expect(await sendReports(SECRET, row, [report])).toBe(true);
    expect(await sendReports(SECRET, row, [report])).toBe(true);
    await home.idle();
    expect(home.counts.duplicates).toBe(1);
    expect(store.monitors[0].passStreak).toBe(1);
    expect(store.closes).toHaveLength(0);
  });

  it("open nothing on a monitor paused since the last refresh", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    // Paused in the dashboard; the probes haven't refreshed yet.
    store.monitors[0].paused = true;
    up = false;
    await runFor(180);
    expect(store.effects("open_incident")).toHaveLength(0);
    expect(store.monitors[0].state).toBe("up");
  });

  it("cover a probe that dropped out, and the new home takes its state from the row", async () => {
    const store = new FakeStore();
    store.monitors = ["mon_a", "mon_b", "mon_c", "mon_d", "mon_e", "mon_f"].map(monitor);
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(180);
    const [nyc, sfo] = probes;
    await sfo.stop();
    probes = [nyc];
    store.live = store.live.filter((p) => p.id === nyc.o.self.id);
    await nyc.beat();
    const before = nyc.counts.checks;
    await runFor(300);
    // Every monitor, every minute, from the one probe left.
    expect(nyc.counts.checks - before).toBeGreaterThanOrEqual(6 * 4);
    for (const m of store.monitors) expect(m.state).toBe("up");
    // Taking over wrote nothing: the state didn't change.
    expect(store.effects("transition")).toHaveLength(6);
  });

  it("write rollups of its own location's checks when windows close", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(700);
    for (const p of probes) await p.flush();
    const rows = store.rollups;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.location))).toEqual(new Set(["tor1", "sfo3"]));
    for (const r of rows) {
      expect(r.windowStart % 300).toBe(0);
      expect(r.failures).toBe(0);
      expect(r.p50Ms).not.toBeNull();
    }
  });

  it("send a monitor's secret headers, and leave one whose headers wouldn't open unchecked", async () => {
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_a"), headers: { "x-api-key": "k-123" } }, { ...monitor("mon_b"), headers: null }];
    await fleet(store, ["tor1", "sfo3"]);
    lastKey = undefined;
    await runFor(120);
    expect(lastKey).toBe("k-123");
    expect(probes.reduce((n, p) => n + p.counts.checks, 0)).toBe(2);
    for (const p of probes) expect(p.health().unreadable).toBe(1);
    expect(store.effects("transition").map((e) => e.monitorId)).toEqual(["mon_a"]);
  });

  it("stop checking a monitor that is paused or deleted, at the next refresh", async () => {
    const store = new FakeStore();
    store.monitors = [monitor("mon_a"), monitor("mon_b")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    store.monitors[0].paused = true;
    store.monitors = [store.monitors[0]];
    for (const p of probes) await p.refresh();
    const before = probes.map((p) => p.counts.checks);
    await runFor(300);
    expect(probes.map((p) => p.counts.checks)).toEqual(before);
    for (const p of probes) expect(p.wheel.size).toBe(0);
  });

  it("confirm from itself when the other location answers that it can't open the monitor's headers", async () => {
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_a"), headers: { "x-api-key": "k-123" } }];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    // sfo3 runs with a CREDENTIALS_KEY that doesn't open this monitor's header.
    const [nyc, sfo] = probes;
    sfo.monitors.set("mon_a", { ...sfo.monitors.get("mon_a")!, headers: null });
    up = false;
    await runFor(240);
    const opened = store.effects("open_incident");
    expect(opened).toHaveLength(1);
    expect((opened[0] as Extract<Effect, { kind: "open_incident" }>).evidence.locations).toEqual(["tor1", "tor1"]);
    expect(nyc.counts.unconfirmed).toBe(0);
  });

  it("leave a failure unconfirmed when the other location hasn't loaded the monitor yet, or still has it paused", async () => {
    const store = new FakeStore();
    // Monitors tor1 is home for, so a failure it confirmed from itself would be written.
    const ids = Array.from({ length: 40 }, (_, i) => `mon_${i}`);
    const homedAt = (id: string) => ranked(id, [{ id: "tor1-a" }, { id: "sfo3-a" }] as ProbeRow[])[0].id;
    const [resumed, created] = ids.filter((id) => homedAt(id) === "tor1-a");
    store.monitors = [monitor(resumed)];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(120);
    const [nyc, sfo] = probes;
    // The owner resumed one and added another; tor1 has refreshed and sfo3 hasn't yet.
    sfo.monitors.set(resumed, { ...sfo.monitors.get(resumed)!, paused: true });
    store.monitors.push(monitor(created));
    await nyc.refresh();
    up = false;
    await runFor(240);
    expect(nyc.counts.unconfirmed).toBeGreaterThan(0);
    expect(store.effects("open_incident")).toHaveLength(0);
  });

  it("put second looks ahead of the checks already waiting for a slot, first come first served", async () => {
    const store = new FakeStore();
    await fleet(store, ["tor1"]);
    const probe = new Probe({ ...probes[0].o, port: 0, maxInFlight: 1 });
    let open!: () => void;
    hold = new Promise((r) => (open = r));
    const order: string[] = [];
    const busy = probe.runCheck({ ...monitor("mon_hold"), target: targetUrl.replace(/\/health$/, "/hold") });
    const ordinary = probe.runCheck(monitor("mon_a")).then(() => order.push("ordinary"));
    const first = probe.runCheck(monitor("mon_b"), true).then(() => order.push("second look 1"));
    const second = probe.runCheck(monitor("mon_c"), true).then(() => order.push("second look 2"));
    open();
    await Promise.all([busy, ordinary, first, second]);
    hold = null;
    expect(order).toEqual(["second look 1", "second look 2", "ordinary"]);
  });
});

/* Heartbeats in the runtime: a store that keeps each heartbeat's row and judges it with the same
   `plan`/`judge`/`step` the real `Store.judgeHeartbeat` runs under its lock
   (`tests/integration/heartbeat.test.ts` is that path against Postgres). */
class HeartbeatStore extends FakeStore {
  beats: (HeartbeatMonitor & { judgedBy: string[] })[] = [];
  async loadHeartbeats() {
    return this.beats.map(({ judgedBy: _by, ...h }) => structuredClone(h));
  }
  async judgeHeartbeat(id: string, location: string): Promise<HeartbeatJudged> {
    const h = this.beats.find((b) => b.id === id);
    if (!h || h.paused) return { applied: "paused", runs: [], due: null };
    const { event, due } = plan(h.row, clock * 1000);
    if (!event) return { applied: "unchanged", runs: [], due };
    const j = judge(h.row, event, location);
    const { next, effects } = step("heartbeat", fresh(h.row.state), { first: j.outcome });
    h.row = { ...h.row, state: next.state, ...j.cursor };
    h.judgedBy.push(location);
    this.applied.push({ monitorId: id, effects, atSec: clock });
    return { applied: "written", runs: j.runs, due: null };
  }
  ping(id: string, atSec = clock - 1) {
    const h = this.beats.find((b) => b.id === id)!;
    h.row = { ...h.row, ping: { at: atSec * 1000, payload: {}, note: null }, finishes: h.row.finishes + 1 };
  }
}

const beat = (id: string): HeartbeatMonitor & { judgedBy: string[] } => {
  const config = configOf({ schedule: "*/5 * * * *", tz: "UTC", graceMin: 1, maxRunMin: 30 });
  return {
    id, workspaceId: "ws_test", config, version: "1", paused: false, judgedBy: [],
    row: { state: null, versionAt: (clock - 3600) * 1000, config, ping: null, start: null, fail: null, finishes: 0,
      judgedAt: null, judgedFinishes: 0, runAt: null },
  };
};

describe("a heartbeat's home", () => {
  it("judges a ping once, at the heartbeat's home only, as soon as a refresh shows it, and leaves one nobody pinged alone", async () => {
    const store = new HeartbeatStore();
    store.beats.push(beat("hb_pinged"), beat("hb_silent"));
    store.ping("hb_pinged");
    await fleet(store, ["tor1", "sfo3"]);
    for (const p of probes) await p.idle();
    const [pinged, silent] = store.beats;
    const home = ranked("hb_pinged", store.live)[0];
    expect(pinged.judgedBy).toEqual([home.location]);
    expect(pinged.row.state).toBe("up");
    // Ten minutes and two missed deadlines' worth of ticks: a heartbeat that never pinged is No
    // ping yet, not down.
    await runFor(600);
    expect(silent.judgedBy).toEqual([]);
    expect(silent.row.state).toBeNull();
  });

  it("waits on the wheel for a deadline, opens on the missed run, counts it in its own windows, and closes on the next ping", async () => {
    const store = new HeartbeatStore();
    store.beats.push(beat("hb_nightly"));
    store.ping("hb_nightly");
    await fleet(store, ["tor1", "sfo3"]);
    for (const p of probes) await p.idle();
    const h = store.beats[0];
    expect(h.row.state).toBe("up");
    const home = probes.find((p) => p.o.self.location === h.judgedBy[0])!;
    const due = home.wheel.when("hb_nightly")!;
    expect(due).toBeGreaterThan(clock);
    expect(due - clock).toBeLessThanOrEqual(6 * 60 + 35);
    await runFor(due - clock - 1);
    expect(h.row.state).toBe("up");
    await runFor(1);
    for (const p of probes) await p.idle();
    expect(h.row.state).toBe("down");
    expect(store.effects("open_incident").map((e) => e.monitorId)).toEqual(["hb_nightly"]);
    const windows = home.rollups.drain().filter((r) => r.monitorId === "hb_nightly");
    expect(windows.reduce((n, r) => n + r.failures, 0)).toBe(1);
    expect(windows.every((r) => r.p50Ms === null)).toBe(true);
    store.ping("hb_nightly");
    await home.refresh();
    await home.idle();
    expect(h.row.state).toBe("up");
    expect(store.effects("transition").at(-1)).toMatchObject({ from: "down", to: "up" });
  });
});

describe("a heartbeat read that fails", () => {
  it("never stops the checks: a database without the heartbeat functions still has its monitors checked", async () => {
    const store = new HeartbeatStore();
    store.loadHeartbeats = async () => {
      throw new Error('function public.probe_load_heartbeats(text[]) does not exist');
    };
    store.monitors.push(monitor("mon_checked"));
    await fleet(store, ["tor1"]);
    await runFor(90);
    expect(probes[0].monitors.has("mon_checked")).toBe(true);
    expect(store.applied.some((a) => a.monitorId === "mon_checked")).toBe(true);
    expect(probes[0].counts.errors).toBeGreaterThan(0);
  });
});

describe("a new monitor's first numbers", () => {
  it("write a new monitor's first check at once, and when its window closes only what came after", async () => {
    // At a window's start, so the first check lands mid-window. Last in the file, so moving the
    // shared clock shifts no other test's alignment.
    clock = Math.ceil(clock / 300) * 300;
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_new"), unchecked: true }, monitor("mon_seen")];
    await fleet(store, ["tor1", "sfo3"]);
    await runFor(10);
    for (const p of probes) await p.idle();
    // Ten seconds in, mid-window: the new monitor's window so far is written, with its one check;
    // a monitor checked before waits for its window to close, as ever.
    expect(store.rollups).toEqual([expect.objectContaining({ monitorId: "mon_new", location: expect.any(String), windowStart: clock - 10, checks: 1, failures: 0 })]);
    expect(probes.reduce((n, p) => n + p.counts.firstWrites, 0)).toBe(1);
    // The other location's first check, on its own turn, is its first too. Refreshes that still
    // read the monitor as unchecked write nothing more early: once per version and location.
    for (let i = 0; i < 4; i++) {
      for (const p of probes) await p.refresh();
      await runFor(30);
    }
    for (const p of probes) await p.idle();
    expect(probes.map((p) => p.counts.firstWrites)).toEqual([1, 1]);
    // Everything else flushes at close: no check counted twice, none lost.
    await runFor(600);
    for (const p of probes) {
      await p.idle();
      p.rollups.drain().forEach((r) => store.rollups.push(r));
    }
    const checked = probes.reduce((n, p) => n + p.counts.checks, 0);
    expect(store.rollups.reduce((n, r) => n + r.checks, 0)).toBe(checked);
    // An edit is a new version, unchecked again, which gets its own early write.
    store.monitors[0].version = "2";
    for (const p of probes) await p.refresh();
    await runFor(15);
    for (const p of probes) await p.idle();
    expect(probes.reduce((n, p) => n + p.counts.firstWrites, 0)).toBe(3);
  });

  it("keep a first write that failed for the next flush, which merges it like any window", async () => {
    const store = new FakeStore();
    let refuse = true;
    const write = store.flushRollups.bind(store);
    store.flushRollups = async (rows) => {
      if (refuse) {
        refuse = false;
        throw new Error("connection reset");
      }
      return write(rows);
    };
    store.monitors = [{ ...monitor("mon_new"), intervalSec: 21_600, unchecked: true }];
    await fleet(store, ["tor1"]);
    await runFor(10);
    await probes[0].idle();
    expect(store.rollups).toEqual([]);
    await probes[0].flush();
    expect(store.rollups).toEqual([expect.objectContaining({ monitorId: "mon_new", checks: 1 })]);
  });

  it("send a window once when its first write failed and the database stayed down until it closed", async () => {
    clock = Math.ceil(clock / 300) * 300;
    const start = clock;
    const store = new FakeStore();
    const write = store.flushRollups.bind(store);
    let refused = 0;
    store.flushRollups = async (rows) => {
      if (clock < start + 330) {
        refused++;
        throw new Error("connection reset");
      }
      return write(rows);
    };
    store.monitors = [{ ...monitor("mon_new"), intervalSec: 60, unchecked: true }];
    await fleet(store, ["tor1"]);
    await runFor(360);
    await probes[0].idle();
    // The flush after the window closed: the first write, still waiting, and the rest of its window.
    await probes[0].flush();
    expect(refused).toBe(1);
    // The failed first write and the rest of its window, as one row: nothing counted twice, and
    // later windows keep being written.
    const first = store.rollups.filter((r) => r.monitorId === "mon_new" && r.windowStart === start);
    expect(first).toHaveLength(1);
    expect(first[0].checks).toBeGreaterThan(1);
    await runFor(330);
    await probes[0].idle();
    await probes[0].flush();
    expect(store.rollups.some((r) => r.windowStart === start + 300)).toBe(true);
    probes[0].rollups.drain().forEach((r) => store.rollups.push(r));
    expect(store.rollups.reduce((n, r) => n + r.checks, 0)).toBe(probes[0].counts.checks);
  });

  it("keep a first write that failed while a flush was out and failed too", async () => {
    const store = new FakeStore();
    const write = store.flushRollups.bind(store);
    let release!: () => void;
    let calls = 0;
    store.flushRollups = async (rows) => {
      calls++;
      // The periodic flush: slow, then failed. The first write lands while it is out, and fails.
      if (calls === 1) return new Promise<void>((_, reject) => (release = () => reject(new Error("timed out"))));
      if (calls === 2) throw new Error("connection reset");
      return write(rows);
    };
    store.monitors = [{ ...monitor("mon_new"), intervalSec: 21_600, unchecked: true }];
    await fleet(store, ["tor1"]);
    const out = probes[0].flush();
    await runFor(10);
    await probes[0].idle();
    expect(calls).toBe(2);
    release();
    await expect(out).rejects.toThrow("timed out");
    await probes[0].flush();
    expect(store.rollups).toEqual([expect.objectContaining({ monitorId: "mon_new", checks: 1 })]);
  });

  it("start a monitor's open window over when it changes, so the new version's first numbers are its own", async () => {
    clock = Math.ceil(clock / 300) * 300;
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_edit"), target: `${targetUrl}?gone` }];
    await fleet(store, ["tor1"]);
    // Three minutes of failures into a window that is still open.
    await runFor(200);
    await probes[0].idle();
    expect(probes[0].counts.checks).toBeGreaterThanOrEqual(3);
    expect(store.rollups).toEqual([]);
    // The address is fixed: a new version, unchecked again, whose first check passes.
    Object.assign(store.monitors[0], { target: `${targetUrl}?new`, version: "2", unchecked: true });
    await probes[0].refresh();
    await runFor(15);
    await probes[0].idle();
    expect(store.rollups).toEqual([expect.objectContaining({ monitorId: "mon_edit", checks: 1, failures: 0 })]);
    // Nothing of the old address is left to reach the window when it closes.
    expect(probes[0].rollups.drain()).toEqual([]);
  });

  it("count no check of a version that was replaced while it ran", async () => {
    clock = Math.ceil(clock / 300) * 300;
    up = false;
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const store = new FakeStore();
    store.monitors = [{ ...monitor("mon_slow"), target: targetUrl.replace(/\/health$/, "/hold"), unchecked: true }];
    await fleet(store, ["tor1"]);
    const p = probes[0];
    // Its first check starts and waits at the target, failing once let go.
    for (let i = 0; i < 11; i++) {
      clock++;
      p.tick();
    }
    await new Promise((r) => setTimeout(r, 300));
    Object.assign(store.monitors[0], { target: `${targetUrl}?new`, version: "2" });
    await p.refresh();
    release();
    await p.idle();
    hold = null;
    expect(store.rollups).toEqual([]);
    await runFor(15);
    await p.idle();
    expect(store.rollups).toEqual([expect.objectContaining({ monitorId: "mon_slow", checks: 1, failures: 0 })]);
  });
});

describe("the domain leader", () => {
  const recorded = (f: string) => readFileSync(new URL(`../fixtures/rdap/${f}`, import.meta.url), "utf8");

  class DomainFakeStore extends FakeStore {
    reads: string[][] = [];
    recorded: { host: string; r: DomainResult; by?: string }[] = [];
    async loadDomains(hosts: string[]) {
      this.reads.push(hosts);
      return [];
    }
    async recordDomain(host: string, r: DomainResult) {
      this.recorded.push({ host, r });
      return true;
    }
  }

  it("looks up the SSL monitors' domains from one probe only, and each host once an hour", async () => {
    const store = new DomainFakeStore();
    const ssl = (id: string, host: string): StoredMonitor => ({ ...monitor(id), type: "ssl", target: host, intervalSec: 21_600, config: {} });
    store.monitors = [ssl("mon_ssl", "www.askone.org"), ssl("mon_ssl2", "askone.org"), monitor("mon_http")];
    const asked: string[] = [];
    const rdap = new Rdap(async (url) => {
      asked.push(url);
      if (url === BOOTSTRAP_URL) return { status: 200, body: recorded("iana-dns-bootstrap.json") };
      if (url.endsWith("/domain/askone.org")) return { status: 200, body: recorded("askone.org.json") };
      return { status: 400, body: recorded("www.askone.org.400.json") };
    }, { sleep: async () => {} });
    await fleet(store, ["tor1", "sfo3"], { rdap });
    for (const p of probes) await p.domains();
    // One probe read and asked; the other did nothing.
    expect(store.reads).toEqual([["www.askone.org", "askone.org"]]);
    expect(store.recorded.map((x) => [x.host, x.r.status, x.r.domain])).toEqual([["www.askone.org", "found", "askone.org"]]);
    expect(probes.reduce((n, p) => n + p.counts.domains, 0)).toBe(1);
    // Within the hour it doesn't look again; after it, it reads again (and the rows decide).
    for (const p of probes) await p.domains();
    expect(store.reads).toHaveLength(1);
    clock += 3600;
    for (const p of probes) await p.domains();
    expect(store.reads).toHaveLength(2);
  });

  it("looks again at the next refresh at a host a pass left, here behind a registry's 429, and records nothing for it", async () => {
    const store = new DomainFakeStore();
    store.monitors = [{ ...monitor("mon_ssl"), type: "ssl", target: "askone.org", intervalSec: 21_600, config: {} }];
    let limited = true;
    const rdap = new Rdap(async (url) => {
      if (url === BOOTSTRAP_URL) return { status: 200, body: recorded("iana-dns-bootstrap.json") };
      if (limited) return { status: 429, body: "" };
      return { status: 200, body: recorded("askone.org.json") };
    }, { sleep: async () => {} });
    await fleet(store, ["tor1"], { rdap });
    await probes[0].domains();
    expect(store.reads).toHaveLength(1);
    expect(store.recorded).toEqual([]);
    // Not an hour later: the next refresh's pass asks again.
    limited = false;
    await probes[0].domains();
    expect(store.reads).toHaveLength(2);
    expect(store.recorded.map((x) => [x.host, x.r.status])).toEqual([["askone.org", "found"]]);
  });
});
