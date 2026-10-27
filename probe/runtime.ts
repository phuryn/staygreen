import type { Server } from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Assertion } from "../src/checks/assertions";
import { checkCert } from "../src/checks/cert";
import { checkDns, type Ask, type DnsRecord } from "../src/checks/dns";
import { checkHttp } from "../src/checks/http";
import { checkStripe, type StripeRuntime } from "../src/checks/stripe";
import { checkSupabase } from "../src/checks/supabase";
import { serviceFetch, type ServiceFetch } from "../src/checks/service-fetch";
import { SERVICE_KEY, type StripeConfig, type SupabaseConfig } from "../src/lib/service-monitor";
import { checkTcp } from "../src/checks/tcp";
import type { AddressGuard, CheckResult } from "../src/checks/types";
import { Rdap, asciiHost, guardedFetch } from "../src/checks/rdap";
import { DOMAIN_LOOK_SEC, domainLeader, domainPass, type DomainStore } from "./domains";
import { askConfirm, peerServer, sendReports, type Report } from "./peer";
import { merged, Rollups, WINDOW_SEC, type RollupRow } from "./rollup";
import { confirmersFor, eligible, hash32, nextDue, ranked, TimerWheel, type ProbeInfo } from "./schedule";
import { DEADLINE_MARGIN_MS, plan } from "./heartbeat";
import { needsConfirmation, type Located } from "./state";
import type { Applied, HeartbeatJudged, HeartbeatMonitor, Monitor, ProbeRow } from "./store";
import { monitorDefaults } from "../src/lib/monitor-defaults";
import { Canary } from "./canary";

/* One probe: the timer wheel, the checks, confirmation, delivery to the store for monitors it is
   home for, and the rollups of its own checks (`schedule.ts` explains who does what).

   A check's life: it comes due on the wheel, runs (at most `maxInFlight` at once), and lands in
   this location's rollup. A failure that needs a second location is re-checked at once by the
   next location in the ranking that answers, or by this probe itself after a pause when no other
   location is live; when others are live and none answers within 30 s, it stays unconfirmed.
   A second look waits for no ordinary check: it takes the next free slot, in the order the
   second looks asked. The outcome
   then goes to the monitor's home, batched once a second, and only the home
   hands the outcome to the store, which steps the locked monitor row.

   A heartbeat is never checked: the receiver records its pings (`ingest/`), and its home judges
   them. The home learns of a ping from the 30-second refresh, which reads every heartbeat's
   newest ping times, so a ping is judged within about 30 seconds of arriving; a deadline (an
   expected run plus its grace, or a `/start` plus the max run time) sits on the same timer
   wheel as the checks, in memory only, and is judged 5 seconds after it falls. Each judgement
   steps the row through the store (`judgeHeartbeat`), under the same lock and reducer as an
   outcome. A ping that lands while no probe is live stays recorded, and the first home to come
   back judges it, and every deadline that passed meanwhile, in order (`heartbeat.ts`).

   A window is written when it closes, so a monitor's numbers reach the dashboard 5 to 10 minutes
   after its first check. A version this probe loaded as unchecked is the exception: the moment
   its first check here completes, that monitor's window so far is written on its own, and the
   window starts counting again from nothing, so its close adds only what came after. That is one
   extra write per new (or edited, or resumed) monitor and location, never one per check.

   The fleet's leader also looks up the domains of the SSL monitors' hosts once a day
   (`domains.ts`). */

export type ProbeStore = {
  heartbeat(p: ProbeRow): Promise<void>;
  /** Out of the live set at once, so a planned restart doesn't leave the others asking a probe
      that won't answer for the two minutes a heartbeat stays live. */
  leave(id: string): Promise<void>;
  liveProbes(): Promise<ProbeRow[]>;
  loadMonitors(): Promise<Monitor[]>;
  flushRollups(rows: RollupRow[]): Promise<void>;
  /** Step the current row under its lock, with version, ordering and replay fences. */
  apply(report: Report): Promise<Applied>;
  /** Heartbeats, for a store that has them (the in-memory stores of the tests and the benchmark
      don't): their settings and what has arrived, and one judgement of the next due event. */
  loadHeartbeats?(): Promise<HeartbeatMonitor[]>;
  judgeHeartbeat?(monitorId: string, location: string): Promise<HeartbeatJudged>;
  /** Domain registrations, for a store that has them (`domains.ts`). */
  loadDomains?: DomainStore["loadDomains"];
  recordDomain?: DomainStore["recordDomain"];
};

export type ProbeOptions = {
  self: ProbeRow;
  secret: string;
  store: ProbeStore;
  /** Where the peer server listens; `self.url` is how the others reach it. */
  port: number;
  host?: string;
  maxInFlight?: number;
  /** Seconds to wait before re-checking a failure from here when no other location is live. */
  recheckAfterSec?: number;
  now?: () => number;
  /** For tests and the benchmark: an address guard that admits a local target, its CA, and a
      DNS resolver that isn't the network. */
  checks?: { allow?: AddressGuard; ca?: string | Buffer; dnsAsk?: Ask; serviceFetch?: ServiceFetch };
  /** The checks due in one second start spread across it, each at its own offset, so a second
      never begins with every handshake at once. Tests set 0. */
  spreadMs?: number;
  /** Seconds between the background jobs; tests drive them by hand instead (`timers: false`). */
  timers?: boolean;
  /** How the leader reads RDAP: the guarded network fetch by default; a test passes one over
      recorded answers, or false for none. */
  rdap?: Rdap | false;
  /** The process installs the real canary; tests inject recorded network answers. */
  canary?: Canary;
  release?: string;
};

const FLUSH_GRACE_SEC = 5;
/** When a monitor version began, in epoch seconds: a version is its row's `updated_at` in whole
 *  microseconds (`probe_load_monitors`). Anything else (the tests' "1", "2") reads as the start of
 *  time, so a new version drops every window held for the old one. */
export function versionSec(version: string): number {
  const us = Number(version);
  return /^\d{16}$/.test(version) && Number.isSafeInteger(us) ? us / 1e6 : -Infinity;
}
const MAX_OUTBOX = 50_000;
/** A failure is confirmed from a second location within 30 s (`spec.md § 2`), however many are asked. */
const CONFIRM_WITHIN_MS = 30_000;
const SUPABASE_REFUSAL_SEC = 30 * 60;

/** Scheduling only: a refusal is the status already kept on the latest failure or open
 * incident. An unconfirmed refusal while up needs no backoff; 429 is temporary throttling,
 * not a refused key/read. Recovery leaves down through the ordinary reducer. */
export function supabaseBackoff(m: Monitor): boolean {
  const refusal = (s: unknown) => typeof s === "number" && s >= 400 && s < 500 && s !== 429;
  return m.type === "supabase" && m.config.__state === "down"
    && (refusal(m.config.__failureStatus) || refusal(m.config.__incidentStatus));
}
/** Events one heartbeat judges in a row before giving the others a turn. */
const JUDGE_BATCH = 50;

export class Probe {
  readonly monitors = new Map<string, Monitor>();
  readonly heartbeats = new Map<string, HeartbeatMonitor>();
  peers: ProbeRow[] = [];
  readonly wheel: TimerWheel;
  readonly rollups: Rollups;
  private unflushed: RollupRow[] = [];
  private outbox: Report[] = [];
  private inFlight = 0;
  private waiting: (() => void)[] = [];
  private waitingUrgent: (() => void)[] = [];
  private running = new Set<Promise<unknown>>();
  private timers: NodeJS.Timeout[] = [];
  private server?: Server;
  private lag = monitorEventLoopDelay({ resolution: 20 });
  private startedAt: number;
  readonly counts = { checks: 0, confirms: 0, unconfirmed: 0, reported: 0, applied: 0, duplicates: 0, moved: 0, judged: 0, firstWrites: 0, domains: 0, errors: 0 };
  private readonly rdap: Rdap | null;
  private stopping = false;
  private lastFlushAt: number | null = null;
  /** Request start times, including second looks. Scheduling data stays in memory; after a
      restart the feed reconstructs a conservative bound from failures and the counted outcome. */
  private serviceChecked = new Map<string, { version: string; at: number }>();

  constructor(readonly o: ProbeOptions) {
    this.wheel = new TimerWheel(this.now() - 1);
    this.rollups = new Rollups(o.self.location);
    this.startedAt = this.now();
    this.rdap = o.rdap === false ? null : (o.rdap ?? new Rdap(guardedFetch({ allow: o.checks?.allow, ca: o.checks?.ca })));
  }

  now(): number {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  async start(): Promise<void> {
    this.lag.enable();
    await this.o.store.heartbeat(this.o.self);
    this.peers = await this.o.store.liveProbes();
    await this.refresh();
    if (this.o.canary) await this.o.canary.test(true);
    this.server = peerServer(this.o.secret, {
      confirm: (id, version) => this.confirmHere(id, version),
      report: (reports) => this.receive(reports),
      health: () => this.health(),
    });
    await new Promise<void>((resolve) => this.server!.listen(this.o.port, this.o.host ?? "0.0.0.0", resolve));
    if (this.o.timers === false) return;
    const every = (sec: number, fn: () => Promise<unknown> | void) =>
      this.timers.push(
        setInterval(() => {
          Promise.resolve(fn()).catch(() => this.counts.errors++);
        }, sec * 1000),
      );
    every(1, () => {
      this.tick();
    });
    every(1, () => this.sendOutbox());
    every(15, () => this.beat());
    every(30, () => this.refresh());
    every(30, () => this.flush());
    every(10, () => this.o.canary?.test());
  }

  /** A planned stop hands its monitors over only once it has nothing left to write. It takes no
      more confirmations or reports, finishes its own checks and writes them as their home, and
      only then leaves the live set.
      While it drains, the others get no answer from it, so their failures stay unconfirmed:
      nothing opens that shouldn't, and their reports wait for the next home. Whatever still
      overlaps (a request already being read when the server closed, a drain that outlasts the
      two minutes a heartbeat stays live) is serialized by the monitor row lock. */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    const closed = new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await this.idle();
    await this.sendOutbox();
    await this.idle();
    this.unflushed.push(...this.rollups.drain());
    await this.flush().catch(() => this.counts.errors++);
    await this.o.store.leave(this.o.self.id).catch(() => this.counts.errors++);
    this.lag.disable();
    await closed;
  }

  /** The port the peer server is bound to (the one asked for, or the one picked for port 0). */
  get port(): number {
    const a = this.server?.address();
    return a && typeof a === "object" ? a.port : this.o.port;
  }

  /** Resolves when every check, confirmation and write in flight has finished. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  health() {
    return {
      id: this.o.self.id,
      release: this.o.release ?? null,
      ready: !this.stopping && this.lastFlushAt !== null && this.now() - this.lastFlushAt < 90 &&
        (!this.o.canary || this.o.canary.health().status === "healthy"),
      canary: this.o.canary?.health() ?? null,
      lastFlushAt: this.lastFlushAt,
      location: this.o.self.location,
      uptimeSec: this.now() - this.startedAt,
      monitors: this.monitors.size,
      heartbeats: this.heartbeats.size,
      scheduled: this.wheel.size,
      inFlight: this.inFlight,
      livePeers: this.peers.length,
      liveProbeIds: this.peers.map((p) => p.id),
      homeMonitors: [...this.monitors.values()].filter((m) => !m.paused && this.order(m)[0]?.id === this.o.self.id).length,
      /** Monitors left unchecked because a secret header wouldn't open: a wrong `CREDENTIALS_KEY`. */
      unreadable: [...this.monitors.values()].filter((m) => m.headers === null).length,
      lagP99Ms: Math.round(this.lag.percentile(99) / 1e6),
    };
  }

  // ── who checks what ────────────────────────────────────────────────────────

  order(m: Monitor): ProbeInfo[] {
    return ranked(m.id, eligible(this.peers, m.builder));
  }

  private place(m: Monitor): void {
    if (m.paused || m.headers === null) return this.wheel.cancel(m.id);
    const order = this.order(m);
    const k = order.findIndex((p) => p.id === this.o.self.id);
    if (k < 0) return this.wheel.cancel(m.id);
    // The first slot after the last second the wheel handled, so placing a monitor again in the
    // second it is due, before the tick reaches it, keeps that slot instead of skipping it.
    const due = nextDue(this.wheel.last, m.id, m.intervalSec, k, order.length);
    // A version with no outcome yet is checked once by its home within ten seconds, spread by its
    // id. Once per version in this process: a first check can leave nothing in the row (a failure
    // waiting for its second, one the other location didn't confirm), and that must not become a
    // check every refresh. Its turns follow from there. Not while the canary reads this box as
    // isolated: a failure found then can't count, so hurrying would only repeat the request every
    // refresh. The refresh after the network is back places it.
    const first = m.unchecked && k === 0 && !this.firstChecked.has(`${m.id}@${m.version}`)
      && this.o.canary?.health().status !== "isolated";
    this.wheel.schedule(m.id, Math.max(this.refusalDue(m), first ? Math.min(due, this.wheel.last + 1 + (hash32(m.id) % 10)) : due));
  }

  private refusalDue(m: Monitor): number {
    if (!supabaseBackoff(m)) return -Infinity;
    const local = this.serviceChecked.get(m.id);
    // After a restart use the newest counted outcome across all locations: passes have no
    // failure row, and a later peer failure can replace the pass's location in that outcome.
    // A running process has its own exact start time and needn't delay for another location.
    const last = local?.version === m.version ? local.at
      : typeof m.config.__outcomeAt === "number" ? m.config.__outcomeAt : -Infinity;
    return last + SUPABASE_REFUSAL_SEC;
  }

  /** The live set changed, or a monitor did: every placement and every home is recomputed. */
  private replan(): void {
    for (const m of this.monitors.values()) this.place(m);
    for (const h of this.heartbeats.values()) this.placeHeartbeat(h);
  }

  private isHome(id: string): boolean {
    return ranked(id, eligible(this.peers, false))[0]?.id === this.o.self.id;
  }

  /** Only the home judges a heartbeat. What the last refresh read decides whether something is
      waiting now or when the next deadline falls; the judgement itself reads the locked row. */
  private placeHeartbeat(h: HeartbeatMonitor): void {
    if (h.paused || !this.isHome(h.id)) return this.wheel.cancel(h.id);
    const { event, due } = plan(h.row, this.now() * 1000);
    if (event) void this.judge(h.id);
    else if (due !== null) this.wheel.schedule(h.id, Math.ceil((due + DEADLINE_MARGIN_MS) / 1000));
    else this.wheel.cancel(h.id);
  }

  /** Judge one heartbeat until nothing is due, one event per transaction, counting each run into
      this location's windows; then wait on the wheel for its next deadline. Chained per monitor,
      like outcomes, so a refresh and a deadline never judge it twice at once. */
  judge(id: string): Promise<void> {
    const store = this.o.store;
    if (!store.judgeHeartbeat) return Promise.resolve();
    const prev = this.chains.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        for (let i = 0; i < JUDGE_BATCH; i++) {
          const r = await store.judgeHeartbeat!(id, this.o.self.location);
          for (const run of r.runs) this.rollups.record(id, Math.floor(run.at / 1000), { ok: run.ok, ms: null });
          if (r.applied === "written") {
            this.counts.judged++;
            continue;
          }
          const h = this.heartbeats.get(id);
          if (r.applied === "unchanged" && r.due !== null && h && !h.paused && this.isHome(id)) {
            this.wheel.schedule(id, Math.ceil((r.due + DEADLINE_MARGIN_MS) / 1000));
          }
          return;
        }
        this.wheel.schedule(id, this.wheel.last + 1);
      } catch {
        // Rolled back; the next refresh or deadline judges it again from the durable row.
        this.counts.errors++;
      }
    });
    this.chains.set(id, next);
    void next.finally(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    });
    return this.track(next);
  }

  /** Tracked, so a stop waits for a heartbeat already on its way: one landing after `leave` would
      put this probe back in the live set for two minutes. */
  beat(): Promise<void> {
    return this.track(this.heartbeatAndReplan());
  }

  private async heartbeatAndReplan(): Promise<void> {
    await this.o.store.heartbeat(this.o.self);
    const live = await this.o.store.liveProbes();
    const key = (ps: ProbeRow[]) => ps.map((p) => `${p.id}@${p.url}`).join(",");
    if (key(live) === key(this.peers)) return;
    this.peers = live;
    // Reload configuration when ownership changes; counting is already in the shared row.
    await this.refresh();
  }

  /** Refresh configuration and scheduling evidence, never reducer counters. The generation
      prevents a slow read from replacing a later edit or pause. */
  private refreshes = 0;
  /** `id@version` of each monitor version this probe has given its quick first check. */
  private firstChecked = new Set<string>();
  async refresh(): Promise<void> {
    const call = ++this.refreshes;
    // A heartbeat read that fails (a database without migration 019) never stops the checks:
    // the heartbeats keep what the last read had, and the error is counted.
    const heartbeatsRead = this.o.store.loadHeartbeats
      ? this.o.store.loadHeartbeats().catch(() => {
          this.counts.errors++;
          return null;
        })
      : Promise.resolve([]);
    const [rows, beats] = await Promise.all([this.o.store.loadMonitors(), heartbeatsRead]);
    if (call !== this.refreshes) return;
    if (beats) {
      const beating = new Set(beats.map((h) => h.id));
      for (const h of beats) this.heartbeats.set(h.id, h);
      for (const id of this.heartbeats.keys()) {
        if (beating.has(id)) continue;
        this.heartbeats.delete(id);
        this.wheel.cancel(id);
      }
    }
    const seen = new Set(rows.map((m) => m.id));
    for (const m of rows) {
      // A new version (an edit, a pause, a resume) starts its windows over. What this probe holds
      // for windows that end after the edit is the old version's: an old address's checks, or
      // ones judged by the old settings, which would otherwise reach the rollups as the new
      // version's, its first numbers among them. The database drops the rows of those windows
      // at the edit (020).
      const was = this.monitors.get(m.id);
      if (was && was.version !== m.version) this.forgetWindows(m.id, versionSec(m.version));
      this.monitors.set(m.id, m);
    }
    for (const id of this.monitors.keys()) {
      if (seen.has(id)) continue;
      this.monitors.delete(id);
      this.serviceChecked.delete(id);
      this.wheel.cancel(id);
    }
    this.replan();
    // Not tracked: a stop doesn't wait on a registry. It is asked between lookups, and a write
    // cut off by the store closing is counted and done again by the next leader.
    if (this.o.timers !== false) void this.domains();
  }

  // ── domains ────────────────────────────────────────────────────────────────

  /** When the leader last looked at each host, in seconds by this probe's clock. */
  private domainLooked = new Map<string, number>();
  private domainsRunning = false;

  /** The leader's pass over the SSL monitors' hosts it hasn't looked at within the hour. Every
      refresh asks, so a new host is looked up within one (`domains.ts`). Not the leader, a store
      that keeps no domains, or a pass already running: nothing. */
  async domains(): Promise<void> {
    const store = this.o.store;
    if (!this.rdap || !store.loadDomains || !store.recordDomain || this.domainsRunning || this.stopping) return;
    if (domainLeader(this.peers)?.id !== this.o.self.id) return;
    const now = this.now();
    const hosts = new Set<string>();
    for (const m of this.monitors.values()) {
      if (m.type !== "ssl" || m.paused) continue;
      const host = String(m.config.host ?? m.target).toLowerCase();
      if ((this.domainLooked.get(host) ?? -Infinity) <= now - DOMAIN_LOOK_SEC) hosts.add(host);
    }
    if (hosts.size === 0) return;
    this.domainsRunning = true;
    try {
      const r = await domainPass({ loadDomains: (h) => store.loadDomains!(h), recordDomain: (h, x) => store.recordDomain!(h, x) },
        this.rdap, [...hosts], now * 1000, () => this.stopping);
      // What the pass left (its cap, a registry that asked for less) is looked at next refresh.
      for (const h of hosts) if (!r.deferred.has(asciiHost(h) ?? h)) this.domainLooked.set(h, now);
      this.counts.domains += r.looked;
      this.counts.errors += r.errors;
    } catch {
      // The read failed: nothing was looked up, and the next refresh tries again.
      this.counts.errors++;
    } finally {
      this.domainsRunning = false;
    }
  }

  // ── checks ─────────────────────────────────────────────────────────────────

  /** Second looks wait in a queue of their own, ahead of ordinary checks and first come first
      served: they are about 1% of checks, a queue full of timeouts is exactly when a failure needs
      confirming, and the one that has waited longest is closest to its 30 s. */
  private acquire(urgent: boolean): Promise<void> {
    if (this.inFlight < (this.o.maxInFlight ?? 256)) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => (urgent ? this.waitingUrgent : this.waiting).push(resolve));
  }

  private release(): void {
    const next = this.waitingUrgent.shift() ?? this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }

  async runCheck(m: Monitor, urgent = false): Promise<Located | null> {
    await this.acquire(urgent);
    try {
      const current = this.monitors.get(m.id);
      const scheduled = current?.version === m.version ? current : m;
      // Check after acquiring a slot: a queued ordinary check and a peer's second look must
      // share the same per-location allowance. A skipped check is no result, never evidence.
      if (this.now() < this.refusalDue(scheduled)) return null;
      if (m.type === "supabase") this.serviceChecked.set(m.id, { version: m.version, at: this.now() });
      const c = m.config;
      const opts = { allow: this.o.checks?.allow, ca: this.o.checks?.ca };
      let r: CheckResult;
      if (m.type === "http") {
        r = await checkHttp(
          {
            url: m.target,
            method: (c.method as "GET" | "HEAD" | "POST") ?? "GET",
            body: typeof c.body === "string" ? c.body : undefined,
            expect: String(c.expect ?? "2xx"),
            keyword: (c.keyword as string | null) ?? null,
            slowMs: Number(c.slowMs ?? monitorDefaults.slowMs.http),
            timeoutSec: Number(c.timeoutSec ?? 15),
            assertions: (c.assertions as Assertion[]) ?? [],
            headers: m.headers ?? undefined,
          },
          opts,
        );
      } else if (m.type === "stripe") {
        r = await checkStripe(c as StripeConfig, m.headers?.[SERVICE_KEY] ?? "", { fetch: this.o.checks?.serviceFetch ?? serviceFetch(opts), now: () => this.now() * 1000,
          runtime: c.__runtime as StripeRuntime, recovering: c.__state === "down" });
      } else if (m.type === "supabase") {
        r = await checkSupabase(c as SupabaseConfig, m.headers?.[SERVICE_KEY] ?? "", { fetch: this.o.checks?.serviceFetch ?? serviceFetch(opts) });
      } else if (m.type === "tcp") {
        r = await checkTcp({ host: String(c.host), port: Number(c.port), tls: c.tls === true, slowMs: Number(c.slowMs ?? monitorDefaults.slowMs.tcp) }, opts);
      } else if (m.type === "ssl") {
        r = await checkCert({ host: String(c.host ?? m.target), port: c.port === undefined ? undefined : Number(c.port) }, opts);
      } else {
        r = await checkDns({ record: c.record as DnsRecord, name: String(c.name), expected: String(c.expected) }, this.o.checks?.dnsAsk);
      }
      this.counts.checks++;
      // Refuse before every path that can record a failure: rollups, early first writes,
      // reports, self-rechecks and incoming confirmations all pass here. Successful checks
      // remain useful evidence during isolation and need no network-health veto.
      if (!r.ok && this.o.canary && !(await this.o.canary.admitFailure())) return null;
      // A check of a version replaced while it ran counts for neither: its window now belongs to
      // the new version (`forgetWindows`).
      if (this.monitors.get(m.id)?.version === m.version) this.rollups.record(m.id, this.now(), r);
      return { ...r, location: this.o.self.location };
    } finally {
      this.release();
      const current = this.monitors.get(m.id);
      if (m.type === "supabase" && current) this.place(current);
    }
  }

  /** Everything due by now, started; their next slots placed first, so a slow check never
      delays its own next one. */
  tick(): Promise<void>[] {
    const started: Promise<void>[] = [];
    const spread = this.o.spreadMs ?? 1000;
    for (const id of this.wheel.advance(this.now())) {
      if (this.heartbeats.has(id)) {
        started.push(this.judge(id));
        continue;
      }
      const m = this.monitors.get(id);
      if (!m || m.paused || m.headers === null) continue;
      // This version's first check from here, whichever turn it came on.
      const first = m.unchecked === true && !this.firstChecked.has(`${m.id}@${m.version}`);
      if (m.unchecked) this.firstChecked.add(`${m.id}@${m.version}`);
      this.place(m);
      const delay = spread > 0 ? hash32(`${m.id}/offset`) % spread : 0;
      const run = delay > 0 ? new Promise((r) => setTimeout(r, delay)).then(() => this.checkAndReport(m, first)) : this.checkAndReport(m, first);
      started.push(this.track(run));
    }
    return started;
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.running.add(p);
    p.finally(() => this.running.delete(p)).catch(() => {});
    return p;
  }

  private async checkAndReport(m: Monitor, firstHere = false): Promise<void> {
    const atSec = this.now();
    try {
      const first = await this.runCheck(m);
      if (!first) {
        // An isolated network, or a Supabase refusal's backoff, supplied no first observation. The next refresh can schedule the
        // quick first check again; do not make a new six-hour monitor wait six hours for it.
        if (firstHere) this.firstChecked.delete(`${m.id}@${m.version}`);
        return;
      }
      // Before the second look a failure waits for: the window says what was seen here, now.
      if (firstHere) void this.track(this.writeFirst(m.id));
      const confirm = needsConfirmation(m.type, first) ? await this.confirm(m) : undefined;
      // A confirmed failure needs both checks; a failure nobody else could look at stays
      // unconfirmed, and the state machine counts it as nothing.
      // Supabase's persisted observation time bounds both requests, including time in the
      // queue and the second look, so a restart cannot retry earlier than either location did.
      this.deliver({ monitorId: m.id, version: m.version, outcome: { first, ...(confirm ? { confirm } : {}) },
        atSec: m.type === "supabase" ? this.now() : atSec });
    } catch {
      this.counts.errors++;
    }
  }

  /** The second look at a failure: from each other live location in turn until one answers.
      From here, after a pause, only when no other location can look: none is live, or every one
      answered that it can't open this monitor's headers. A peer that doesn't answer (restarting,
      refusing the signature, or not yet holding the monitor as this probe does) is not the same as
      no peer, and a failure only this box can see must not be confirmed by this box. */
  private async confirm(m: Monitor): Promise<Located | undefined> {
    this.counts.confirms++;
    const others = confirmersFor(this.order(m), this.o.self.id, m.builder);
    const fromHere = async () => {
      await new Promise((resolve) => setTimeout(resolve, (this.o.recheckAfterSec ?? 20) * 1000));
      return (await this.runCheck(m, true)) ?? undefined;
    };
    if (others.length === 0) return fromHere();
    const deadline = Date.now() + CONFIRM_WITHIN_MS;
    let declined = 0;
    for (const peer of others) {
      const row = this.peers.find((p) => p.id === peer.id);
      const left = deadline - Date.now();
      if (left <= 0) break;
      const r = row && (await askConfirm(this.o.secret, row, m.id, m.version, left));
      if (r === "declined") declined++;
      else if (r) return r;
    }
    if (declined === others.length) return fromHere();
    this.counts.unconfirmed++;
    return undefined;
  }

  /** A peer's request for a second look. No answer for a monitor not loaded yet, paused, or held
      here as another version than the asker checked: a second look at another address or config
      would confirm nothing about the first. `cannot` for one whose secret headers won't open
      here: without them the check would fail, and confirm a failure that isn't there. */
  private async confirmHere(monitorId: string, version: string): Promise<Located | "cannot" | null> {
    const m = this.monitors.get(monitorId);
    if (!m || m.paused || m.version !== version) return null;
    if (m.headers === null) return "cannot";
    return this.track(this.runCheck(m, true));
  }

  // ── outcomes and the state machine ─────────────────────────────────────────

  private deliver(r: Report): void {
    const m = this.monitors.get(r.monitorId);
    if (!m) return;
    if (this.order(m)[0]?.id === this.o.self.id) void this.track(this.applyOutcome(r));
    else if (this.outbox.length < MAX_OUTBOX) this.outbox.push(r);
  }

  /** Reports for other homes, sent once a second. The home is looked up again at sending, so a
      report for a probe that has since dropped out goes to the monitor's new home. */
  async sendOutbox(): Promise<void> {
    if (this.outbox.length === 0) return;
    // In check order: a report that failed to send goes back behind newer ones, and a home steps
    // the state machine in the order reports arrive.
    const batch = this.outbox.sort((a, b) => a.atSec - b.atSec);
    this.outbox = [];
    const byHome = new Map<string, Report[]>();
    for (const r of batch) {
      const m = this.monitors.get(r.monitorId);
      const home = m && this.order(m)[0];
      if (!home) continue;
      if (home.id === this.o.self.id) {
        void this.track(this.applyOutcome(r));
        continue;
      }
      byHome.set(home.id, [...(byHome.get(home.id) ?? []), r]);
    }
    await Promise.all(
      [...byHome].map(async ([id, reports]) => {
        const row = this.peers.find((p) => p.id === id);
        if (row && (await sendReports(this.o.secret, row, reports))) this.counts.reported += reports.length;
        else this.outbox.push(...reports.slice(0, MAX_OUTBOX - this.outbox.length));
      }),
    );
  }

  private receive(reports: Report[]): void {
    for (const r of reports) {
      if (typeof r?.monitorId === "string" && typeof r.version === "string" && Number.isInteger(r.atSec) && typeof r.outcome?.first?.location === "string") this.deliver(r);
    }
  }

  /** Preserve this home's arrival order while writes await a connection. Other homes serialize
      on the row lock. A refresh cannot affect an outcome already sent to the store. */
  private chains = new Map<string, Promise<void>>();

  private applyOutcome(r: Report): Promise<void> {
    const prev = this.chains.get(r.monitorId) ?? Promise.resolve();
    const next = prev.then(async () => {
      try {
        // Even a report newer than our cached configuration goes to the row: its version, pause,
        // state and counters decide. A stale cache cannot reject a valid recovery or invent one.
        const done = await this.o.store.apply(r);
        if (done === "moved") this.counts.moved++;
        else if (done === "duplicate") this.counts.duplicates++;
        else if (done === "written" || done === "unchanged") this.counts.applied++;
      } catch {
        // The transaction rolled back; the next outcome still starts from the durable row.
        this.counts.errors++;
      }
    });
    this.chains.set(r.monitorId, next);
    void next.finally(() => {
      if (this.chains.get(r.monitorId) === next) this.chains.delete(r.monitorId);
    });
    return next;
  }

  // ── rollups ────────────────────────────────────────────────────────────────

  /** A new monitor's window so far, written now rather than when the window closes. A write that
      fails waits with the closed windows for the next flush, which merges it the same way. */
  private async writeFirst(monitorId: string): Promise<void> {
    const rows = this.rollups.take(monitorId);
    if (rows.length === 0) return;
    try {
      await this.o.store.flushRollups(rows);
      this.lastFlushAt = this.now();
      this.counts.firstWrites++;
    } catch {
      this.unflushed.push(...rows);
      this.counts.errors++;
    }
  }

  async flush(): Promise<void> {
    const rows = merged([...this.unflushed, ...this.rollups.closed(this.now(), FLUSH_GRACE_SEC)]);
    this.unflushed = [];
    try {
      await this.o.store.flushRollups(rows);
      this.lastFlushAt = this.now();
    } catch (err) {
      // Kept with whatever failed while this one was out (a first write), not in place of it.
      this.unflushed = rows.concat(this.unflushed);
      throw err;
    }
  }

  /** The monitor's windows that end after `sinceSec`, dropped from memory and from the writes
      waiting to be retried. */
  private forgetWindows(monitorId: string, sinceSec: number): void {
    this.rollups.forget(monitorId, sinceSec);
    this.unflushed = this.unflushed.filter((r) => r.monitorId !== monitorId || r.windowStart + WINDOW_SEC <= sinceSec);
  }
}
