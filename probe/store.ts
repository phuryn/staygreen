import pg from "pg";
import { isLocationId, locations } from "../src/lib/plans";
import { headerContext, open } from "../src/lib/seal";
import type { RollupRow } from "./rollup";
import type { ProbeInfo } from "./schedule";
import { configOf, judge, plan, type HeartbeatConfig, type HeartbeatRow, type Ping } from "./heartbeat";
import { fresh, step, type CheckedType, type Evidence, type Located, type MonitorState, type State } from "./state";
import type { Report } from "./peer";
import type { DomainResult } from "../src/checks/rdap";
import type { DomainRow } from "./domains";
import { affectedStripeEvents, judgeStripe, type StripeObservation, type StripeRuntime } from "../src/checks/stripe";
import { type StripeConfig } from "../src/lib/service-monitor";

/* Every database operation goes through a bounded probe_* function. The login inherits only
   those functions from `probe`, with no table grants or BYPASSRLS. The reducer stays here,
   between the lock and commit functions in one transaction. A steady pass updates nothing;
   windows flush in one array call, never a row per check or a row to schedule one.

   Heartbeats take the same path with their own lock and commit (migration 019): `judgeHeartbeat`
   locks the row, asks `heartbeat.ts` for the next event in what the receiver recorded, steps the
   same reducer, and commits the state, its effects and the row's cursor together.

   An SSL check's certificate (expiry and issuer) rides the same commit as a `cert` effect, only
   when it differs from what the locked row holds for its host (migration 020), so a steady pass
   still writes nothing. The leader's domain lookups have their own two functions
   (`loadDomains`, `recordDomain`). */

export type Monitor = {
  id: string;
  workspaceId: string;
  name: string;
  type: CheckedType;
  target: string;
  intervalSec: number;
  config: Record<string, unknown>;
  paused: boolean;
  /** Builder monitors may be checked from `fra1` and prefer it to confirm. The plan is the one the
      workspace's members last showed with a verified session (`probe_builder_workspaces`), since a
      probe has no session to ask Clerk with. */
  builder: boolean;
  /** The secret headers an HTTP check sends, opened. Null when one wouldn't open (the probe's
      `CREDENTIALS_KEY` isn't the dashboard's): the monitor isn't checked rather than checked
      without its credentials, which would fail it as a 401 from every location. */
  headers: Record<string, string> | null;
  /** The row's `updated_at` in microseconds. Every dashboard edit, pause and resume moves it, and
      the probe never writes it, so it names the version of the monitor a check ran against. */
  version: string;
  /** No outcome counted for this version yet: new, or just edited. Its home checks it once within
      seconds instead of waiting for its turn, which for an SSL monitor can be hours away. */
  unchecked?: boolean;
};

export type ProbeRow = ProbeInfo & { url: string };

/** A heartbeat as a home schedules it: its settings, version and what has arrived, without the
    payloads, which are read under the lock when an event is judged. */
export type HeartbeatMonitor = {
  id: string;
  workspaceId: string;
  config: HeartbeatConfig;
  version: string;
  paused: boolean;
  row: HeartbeatRow;
};

/** What one judgement did: `written` with the runs to count, or `unchanged` (nothing due) with
    the next deadline, or `paused` (paused, deleted, or no longer a heartbeat). */
export type HeartbeatJudged = { applied: "written" | "unchanged" | "paused"; runs: { at: number; ok: boolean }[]; due: number | null };

const ms = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

function pingOf(at: unknown, payload: unknown, note: unknown): Ping | null {
  const t = ms(at);
  if (t === null) return null;
  const p = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  return { at: t, payload: p, note: typeof note === "string" ? note : null };
}

/** A row of `probe_load_heartbeats` or `probe_lock_heartbeat` as `heartbeat.ts` reads it. */
function heartbeatRowOf(r: Record<string, unknown>): HeartbeatRow {
  return {
    state: (r.state as State | null) ?? null,
    versionAt: Number(r.version_at),
    config: configOf((r.config as Record<string, unknown>) ?? {}),
    ping: pingOf(r.ping_at, r.ping_payload, r.ping_note),
    start: pingOf(r.start_at, r.start_payload, r.start_note),
    fail: pingOf(r.fail_at, r.fail_payload, r.fail_note),
    finishes: Number(r.finishes ?? 0),
    judgedAt: ms(r.judged_at),
    judgedFinishes: Number(r.judged_finishes ?? 0),
    runAt: ms(r.run_at),
  };
}

/** What the incident screen reads from `evidence` (`src/lib/workspace.ts`). */
function evidenceJson(m: Pick<Monitor, "type" | "target" | "config">, e: Evidence) {
  const c = m.config;
  const request =
    m.type === "http"
      ? `${String(c.method ?? "GET")} ${m.target}`
      : m.type === "tcp"
        ? `TCP ${String(c.host ?? m.target)}:${String(c.port ?? "")}`
        : m.type === "ssl"
          ? `TLS ${String(c.host ?? m.target)}:443`
          : m.type === "stripe" ? "Stripe account webhook deliveries"
            : m.type === "supabase" ? `Supabase project ${m.target}`
              : `${String(c.record ?? "")} ${String(c.name ?? m.target)}`;
  return {
    request,
    summary: e.failure?.message ?? "",
    ...(e.status !== undefined ? { status: e.status } : {}),
    ...(e.assertion ? { assertion: `${e.assertion.path} ${e.assertion.op} ${e.assertion.expected}`.trim(), got: e.assertion.got ?? "" } : {}),
    locations: e.locations,
    snippet: e.snippet ?? "",
  };
}

/** `unchanged` includes a steady pass: even its ordering marker needs no write. */
export type Applied = "written" | "unchanged" | "paused" | "moved" | "duplicate";

/** The certificate an SSL outcome read, from whichever of its checks reached one (the second
    look, when the first broke off before a handshake): expiry in epoch seconds, and issuer. */
export function certOf(outcome: Report["outcome"]): { expiresAt: string; expiresAtSec: number; issuer: string | null } | null {
  for (const r of [outcome.confirm, outcome.first]) {
    const d = r?.detail;
    const t = typeof d?.expiresAt === "string" ? Date.parse(d.expiresAt) : NaN;
    if (!Number.isFinite(t)) continue;
    const issuer = typeof d?.issuer === "string" && d.issuer.trim() ? d.issuer.trim().slice(0, 200) : null;
    return { expiresAt: new Date(t).toISOString(), expiresAtSec: Math.floor(t / 1000), issuer };
  }
  return null;
}

const place = (loc: string) => (isLocationId(loc) ? locations[loc].city : loc);

export class Store {
  /** `credentialsKey` opens the secret headers the dashboard sealed (`src/lib/seal.ts`).
      `workspaces`, when given, is the only workspaces whose monitors this probe checks: the
      development probes check the owner's, never the rows the test suites create and delete in
      the same project (`docs/environments.md`, Probes). Production passes none. */
  constructor(
    readonly pool: pg.Pool,
    private credentialsKey?: Buffer,
    private workspaces?: readonly string[],
    private probeId?: string,
  ) {}

  static connect(url: string, credentialsKey?: Buffer, workspaces?: readonly string[], probeId?: string): Store {
    return new Store(new pg.Pool({ connectionString: url, max: 4, idleTimeoutMillis: 30_000 }), credentialsKey, workspaces, probeId);
  }

  private openHeaders(monitorId: string, sealed: { name: string; sealed: string }[]): Record<string, string> | null {
    const headers: Record<string, string> = {};
    for (const s of sealed) {
      if (!this.credentialsKey) return null;
      try {
        headers[s.name] = open(s.sealed, headerContext(monitorId, s.name), this.credentialsKey);
      } catch {
        return null;
      }
    }
    return headers;
  }

  close(): Promise<void> {
    return this.pool.end();
  }

  async heartbeat(p: ProbeRow): Promise<void> {
    await this.pool.query(
      "select public.probe_heartbeat($1, $2, $3, $4)",
      [p.id, p.location, p.builderOnly, p.url],
    );
  }

  async leave(id: string): Promise<void> {
    await this.pool.query("select public.probe_leave($1)", [id]);
  }

  async liveProbes(): Promise<ProbeRow[]> {
    const { rows } = await this.pool.query("select * from public.probe_live()");
    return rows.map((r) => ({ id: r.id, location: r.location, builderOnly: r.builder_only, url: r.url }));
  }

  async loadMonitors(): Promise<Monitor[]> {
    const [ordinary, services, builders] = await Promise.all([
      this.pool.query("select * from public.probe_load_monitors($1::text[])", [this.workspaces ?? null]),
      this.pool.query("select * from public.probe_load_service_monitors($1::text[])", [this.workspaces ?? null]),
      this.builderWorkspaces(),
    ]);
    const rows = [...ordinary.rows, ...services.rows];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      type: r.type,
      target: r.target,
      intervalSec: r.interval_sec,
      config: r.config,
      paused: r.paused,
      builder: builders.has(r.workspace_id),
      headers: this.openHeaders(r.id, r.secrets),
      version: r.version,
      unchecked: r.unchecked,
    }));
  }

  /** The Builder workspaces among the ones this probe checks. A database without the function yet
      (a probe deployed before its migration) answers none, which is every monitor as Free: how it
      was before the plan reached the probe. */
  private async builderWorkspaces(): Promise<Set<string>> {
    try {
      const { rows } = await this.pool.query("select workspace_id from public.probe_builder_workspaces($1::text[])", [this.workspaces ?? null]);
      return new Set(rows.map((r) => r.workspace_id as string));
    } catch (error) {
      if ((error as { code?: string }).code === "42883") return new Set();
      throw error;
    }
  }

  async loadHeartbeats(): Promise<HeartbeatMonitor[]> {
    const { rows } = await this.pool.query("select * from public.probe_load_heartbeats($1::text[])", [this.workspaces ?? null]);
    return rows.map((r) => {
      const row = heartbeatRowOf(r);
      return { id: r.id, workspaceId: r.workspace_id, config: row.config, version: r.version, paused: r.paused, row };
    });
  }

  /** Judge one heartbeat's next due event under its lock (`heartbeat.ts`), at the database's
      clock. One event per transaction: a run judged missed and the late ping that recovers it
      are two transitions, and the commit function takes one. The caller repeats until nothing is
      due. Another home that judged first moves the cursor, and the commit refuses this one. */
  async judgeHeartbeat(monitorId: string, location: string): Promise<HeartbeatJudged> {
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const { rows } = await c.query("select * from public.probe_lock_heartbeat($1)", [monitorId]);
      const r = rows[0];
      if (!r || r.paused) {
        await c.query("rollback");
        return { applied: "paused", runs: [], due: null };
      }
      const row = heartbeatRowOf(r);
      const { event, due } = plan(row, Number(r.db_now));
      if (!event) {
        await c.query("rollback");
        return { applied: "unchanged", runs: [], due };
      }
      const judged = judge(row, event, location);
      const before: MonitorState = fresh(row.state);
      const { next, effects } = step("heartbeat", before, { first: judged.outcome });
      const writes = effects.map((e) => {
        if (e.kind === "transition") return { kind: e.kind, from: e.from, to: e.to };
        if (e.kind === "open_incident") return { kind: e.kind, evidence: judged.evidence, timeline: [{ t: iso(event.at), text: judged.opened }] };
        const f: Located = e.result;
        return { kind: e.kind, location: f.location, failureKind: f.failure?.kind ?? "missed", message: (f.failure?.message ?? "").slice(0, 500),
          ms: Math.round(f.ms), snippet: f.snippet ?? null, detail: null };
      });
      const k = judged.cursor;
      await c.query(
        "select public.probe_commit_heartbeat($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)",
        [monitorId, r.version, iso(row.judgedAt), iso(event.at), iso(k.judgedAt), k.judgedFinishes, iso(k.runAt),
          next.state, JSON.stringify(writes)],
      );
      await c.query("commit");
      return { applied: "written", runs: judged.runs, due: null };
    } catch (err) {
      await c.query("rollback").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** One statement per window, including the merge and the daily-tier triggers. */
  async flushRollups(rows: RollupRow[]): Promise<void> {
    // Stores used for a one-off test without a probe identity retain the original API. Only a
    // running registered probe may refresh a dead-man receipt, including on an empty flush.
    if (rows.length === 0 && !this.probeId) return;
    const rounded = (v: number | null) => v === null ? null : Math.round(v);
    await this.pool.query(
      this.probeId
        ? "select public.probe_flush_with_receipt($9, $1::text[], $2::text[], $3::timestamptz[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[])"
        : "select public.probe_flush_rollups($1::text[], $2::text[], $3::timestamptz[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[])",
      [rows.map((r) => r.monitorId), rows.map((r) => r.location),
        rows.map((r) => new Date(r.windowStart * 1000).toISOString()), rows.map((r) => r.checks), rows.map((r) => r.failures),
        rows.map((r) => rounded(r.p50Ms)), rows.map((r) => rounded(r.p95Ms)), rows.map((r) => rounded(r.maxMs)),
        ...(this.probeId ? [this.probeId] : [])],
    );
  }

  /** Read, order, step and write under one monitor lock. The report carries only the version
      that was checked; all configuration used for the decision and evidence comes from the row.

      `probe_outcome_at` is the newest outcome that changed counters or produced effects. Thus
      it includes every counted failure, even while already down. Older reports cannot undo newer
      counting. Locations at that second deduplicate resends across homes and restarts; distinct
      locations in the same second retain arrival order (the accepted clock-skew limitation).

      A no-op needs no marker: replaying it before anything changes is still a no-op; after a
      change, the newer marker or state_since fences it out. No row is updated for a steady pass. */
  async apply(report: Report): Promise<Applied> {
    const { monitorId, version, outcome, atSec } = report;
    const at = new Date(atSec * 1000).toISOString();
    const c = await this.pool.connect();
    try {
      await c.query("begin");
      const { rows } = await c.query(
        "select * from public.probe_lock_monitor($1)",
        [monitorId],
      );
      const row = rows[0];
      if (!row || row.paused) {
        await c.query("rollback");
        return "paused";
      }
      if (row.version !== version || (row.since !== null && atSec < row.since)) {
        await c.query("rollback");
        return "moved";
      }
      if (row.outcome_at !== null && atSec < row.outcome_at) {
        await c.query("rollback");
        return "moved";
      }
      const sameSecond = row.outcome_at === atSec;
      if (sameSecond && row.probe_outcome_locations.includes(outcome.first.location)) {
        await c.query("rollback");
        return "duplicate";
      }
      const before: MonitorState = {
        state: row.state, slowStreak: row.probe_slow_streak,
        passStreak: row.probe_pass_streak, failStreak: row.probe_fail_streak,
      };
      const runtime = (row.config.__runtime ?? {}) as StripeRuntime & { pausedOrDeleted?: boolean };
      let nextRuntime = runtime;
      let judged = outcome;
      const observations: StripeObservation[] = [];
      if (row.type === "stripe") {
        const judge = (r: Located): Located => {
          const observation = r.detail?.observation as StripeObservation | undefined;
          if (!observation) return r;
          observations.push(observation);
          const result = judgeStripe(row.config as StripeConfig, observation, runtime, before.state === "down");
          return { ...result, ms: r.ms, location: r.location };
        };
        judged = { first: judge(outcome.first), ...(outcome.confirm ? { confirm: judge(outcome.confirm) } : {}) };
      }
      if (row.type === "supabase") {
        nextRuntime = {
          pausedOrDeleted: outcome.first.failure?.kind === "project_paused" && outcome.confirm?.failure?.kind === "project_paused" };
      }
      const { next, effects } = step(row.type, before, judged);
      if (observations.length) {
        const outstanding = new Set(observations.flatMap(o => o.events.map(e => e.id)));
        const handled = new Set((runtime.seen ?? []).filter(id => outstanding.has(id)));
        // Only terminal failures in a counted, confirmed outcome have been handled.
        // In-flight and out-of-window events did not count; consuming them would hide
        // a later terminal failure. Neither recovery passes nor one-location noise
        // can add new ids, even while the existing incident is down.
        if (next.state === "down" && !judged.first.ok && judged.confirm && !judged.confirm.ok) {
          for (const observation of observations) {
            for (const event of affectedStripeEvents(row.config as StripeConfig, observation)) {
              if (event.pending === 0) handled.add(event.id);
            }
          }
        }
        nextRuntime = handled.size ? { seen: [...handled].sort() } : {};
      }
      const runtimeChanged = JSON.stringify(runtime) !== JSON.stringify(nextRuntime);
      const changed = next.state !== before.state || next.slowStreak !== before.slowStreak ||
        next.passStreak !== before.passStreak || next.failStreak !== before.failStreak;
      // A database without migration 020 returns no certificate columns, and its commit takes no
      // certificate: none is sent, so an SSL outcome there is written exactly as before.
      const read = row.type === "ssl" && "cert_expires_at" in row ? certOf(outcome) : null;
      const cert = read && (row.cert_host !== row.target_host || row.cert_expires_at === null ||
        Math.floor(row.cert_expires_at) !== read.expiresAtSec || (row.cert_issuer ?? null) !== read.issuer) ? read : null;
      if (!changed && effects.length === 0 && !cert && !runtimeChanged) {
        await c.query("commit");
        return "unchanged";
      }
      const m = { id: row.id, workspaceId: row.workspace_id, name: row.name, type: row.type, target: row.target, config: row.config };
      const writes: Record<string, unknown>[] = effects.map((e) => {
        if (e.kind === "transition") {
          return { ...e, at };
        } else if (e.kind === "open_incident") {
          const [first, second] = e.evidence.locations;
          const timeline = [
            { t: at, text: `Check failed in ${place(first)}` },
            { t: at, text: second ? `Confirmed from ${place(second)}, incident opened` : "Incident opened" },
          ];
          return { kind: e.kind, evidence: evidenceJson(m, e.evidence), timeline };
        } else {
          const r: Located = e.result;
          return { kind: e.kind, location: r.location, failureKind: r.failure?.kind ?? "connect",
            message: (r.failure?.message ?? "").slice(0, 500), status: r.status ?? null,
            ms: r.ms, snippet: r.snippet ?? null, detail: r.detail ?? null };
        }
      });
      if (cert) writes.push({ kind: "cert", expiresAt: cert.expiresAt, issuer: cert.issuer });
      if (runtimeChanged) writes.push({ kind: "service_runtime", runtime: nextRuntime });
      await c.query(
        "select public.probe_commit_monitor($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)",
        [monitorId, version, at, next.state, next.slowStreak, next.passStreak, next.failStreak,
          sameSecond ? [...row.probe_outcome_locations, outcome.first.location] : [outcome.first.location], JSON.stringify(writes)],
      );
      await c.query("commit");
      return "written";
    } catch (err) {
      await c.query("rollback").catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }

  /** Each host's registration row, the longest of its names that has one (migration 020). */
  async loadDomains(hosts: string[]): Promise<DomainRow[]> {
    const { rows } = await this.pool.query("select * from public.probe_load_domains($1::text[])", [hosts]);
    return rows.map((r) => ({ host: r.host, name: r.name, status: r.status, error: r.error ?? null, attemptedAt: Math.round(Number(r.attempted_at) * 1000) }));
  }

  /** One lookup's answer for `host`, under the name it is about. False when no SSL monitor names
      the host any more, and nothing was written. */
  async recordDomain(host: string, r: DomainResult): Promise<boolean> {
    const found = r.status === "found" ? r : null;
    const { rows } = await this.pool.query(
      "select public.probe_record_domain($1, $2, $3, $4, $5, $6) as recorded",
      [host, r.domain, r.status, found?.expiresAt != null ? new Date(found.expiresAt).toISOString() : null,
        found?.registrar ?? null, r.status === "failed" ? r.error.slice(0, 200) : null],
    );
    return rows[0]?.recorded === true;
  }
}
