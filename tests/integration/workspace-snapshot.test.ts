import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/* `workspace_snapshot` (migration 022, with 024's alert lists) against a real Postgres with every migration applied
   (`probe/README.md` § A local Postgres): the dashboard's whole snapshot in one call, which must
   return what the twelve reads it replaced returned and nothing more. Two workspaces are filled
   with a row in every table the snapshot reads, including every column it must leave behind (a
   heartbeat's token hash and sealed copy, the probes' counters, a header's sealed value, image
   bytes), and the call for one returns only that one's rows, only the allowed columns, in the
   page's order. `PROBE_DATABASE_URL` names the local database; missing, the file skips and says
   so. It writes its own two workspaces and deletes them. */

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
const local = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
if (url && !local) throw new Error("PROBE_DATABASE_URL must name a Postgres on this machine (127.0.0.1 or localhost)");

const suite = url ? describe : describe.skip;
if (!url) console.warn('[integration] SKIPPED "workspace snapshot": PROBE_DATABASE_URL is not set. Nothing in this file reached a database.');

const hex = (n: number) => randomBytes(n).toString("hex");

/** The columns the dashboard reads of a monitor (`MONITOR_COLUMNS` before 022): never the token's
 *  hash or sealed copy, never the probes' own counters. */
const MONITOR_KEYS = [
  "id", "workspace_id", "app_id", "type", "name", "target", "target_host", "interval_sec", "config", "auto",
  "state", "state_since", "paused_at", "paused_until", "pause_reason", "created_at", "updated_at",
  "cert_host", "cert_expires_at", "cert_issuer", "service_status",
].sort();

type Snapshot = Record<string, Record<string, unknown>[]> & { history: { today: string; monitors: { id: string }[] } };

suite("workspace snapshot", () => {
  let admin: pg.Pool;
  const ws: string[] = [];
  const ids: Record<string, Record<string, string>> = {};

  /** One workspace with a row in every table the snapshot reads; `tag` keeps names apart. */
  async function fill(tag: string) {
    const q = async (sql: string, args: unknown[]) => (await admin.query(sql, args)).rows[0];
    const w = (await q("insert into public.workspaces (clerk_org_id) values ($1) returning id", [`org_snap${tag}${hex(6)}`])).id;
    ws.push(w);
    const a1 = (await q("insert into public.apps (workspace_id, name, created_at) values ($1, $2, now() - interval '2 days') returning id", [w, `${tag} first`])).id;
    const a2 = (await q("insert into public.apps (workspace_id, name, created_at) values ($1, $2, now() - interval '1 day') returning id", [w, `${tag} second`])).id;
    const http = (await q(`insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, config, state, state_since,
        probe_slow_streak, probe_outcome_at, created_at)
      values ($1, $2, 'http', $3, 'https://example.com/health', 'example.com', 180, '{"method":"GET"}', 'up', now(), 2, now(), now() - interval '2 days')
      returning id`, [w, a1, `${tag} health`])).id;
    const beat = (await q(`insert into public.monitors (workspace_id, app_id, type, name, target, interval_sec, config, heartbeat_token_hash,
        heartbeat_token_sealed, created_at)
      values ($1, $2, 'heartbeat', $3, 'in.staygreen.io', 60, '{"schedule":"0 6 * * *"}', $4, 'v1.sealedtoken.mac', now() - interval '1 day')
      returning id`, [w, a2, `${tag} nightly`, hex(32)])).id;
    await q("insert into public.monitor_secrets (monitor_id, workspace_id, name, sealed) values ($1, $2, 'Authorization', 'v1.sealedvalue.mac') returning monitor_id", [http, w]);
    const inc = (await q(`insert into public.incidents (workspace_id, monitor_id, title, severity, opened_at)
      values ($1, $2, $3, 'down', now() - interval '1 hour') returning id`, [w, http, `${tag} outage`])).id;
    const old = (await q(`insert into public.incidents (workspace_id, monitor_id, title, severity, opened_at, resolved_at)
      values ($1, $2, $3, 'degraded', now() - interval '3 days', now() - interval '2 days') returning id`, [w, http, `${tag} slow`])).id;
    const note = (await q(`insert into public.incident_notes (workspace_id, incident_id, state, body, author_client)
      values ($1, $2, 'investigating', $3, 'itest') returning id`, [w, inc, `${tag} looking`])).id;
    const page = (await q(`insert into public.status_pages (workspace_id, app_id, slug, name)
      values ($1, $2, $3, $4) returning id`, [w, a1, `snap-${tag}-${hex(4)}`, `${tag} status`])).id;
    const c1 = (await q("insert into public.page_components (workspace_id, page_id, name, position) values ($1, $2, 'second', 1) returning id", [w, page])).id;
    const c0 = (await q("insert into public.page_components (workspace_id, page_id, name, position) values ($1, $2, 'first', 0) returning id", [w, page])).id;
    await q("insert into public.component_monitors (workspace_id, component_id, monitor_id) values ($1, $2, $3) returning component_id", [w, c0, http]);
    const asset = (await q(`insert into public.page_assets (id, workspace_id, page_id, kind, mime, content)
      values ($1, $2, $3, 'logo', 'image/png', '\\x89504e47') returning id`, [`asset_${hex(16)}`, w, page])).id;
    const logo = (await q(`insert into public.app_logos (id, workspace_id, app_id, mime, content)
      values ($1, $2, $3, 'image/png', '\\x89504e47') returning id`, [`asset_${hex(16)}`, w, a1])).id;
    await q(`insert into public.heartbeat_latest (monitor_id, workspace_id, ping_at, ping_payload, ping_note, start_at, start_payload, fail_at,
        fail_payload, rate_minute, rate_ping)
      values ($1, $2, now(), '{"rows":3}', 'truncated', now() - interval '1 minute', '{"started":true}', now() - interval '1 hour',
        '{"error":"boom"}', date_trunc('minute', now()), 1) returning monitor_id`, [beat, w]);
    // A bound Telegram chat (its chat id stays behind), an address still waiting for its
    // confirmation (its hash stays behind), and two receipts of the outage's opening: one sent,
    // which the snapshot carries, and one still due, which it doesn't.
    const chat = (await q(`insert into public.alert_channels (workspace_id, kind, label, chat_id, confirmed_at)
      values ($1, 'telegram', $2, 4242, now() - interval '1 day') returning id`, [w, `${tag} chat`])).id;
    const waiting = (await q(`insert into public.alert_channels (workspace_id, kind, audience, address, confirm_hash, confirm_sent_at)
      values ($1, 'email', 'address', $2, $3, now()) returning id`, [w, `${tag}-${hex(3)}@example.com`, hex(32)])).id;
    const opened = (await q("select id from public.alert_events where incident_id = $1 and kind = 'opened'", [inc])).id;
    const sent = (await q(`insert into public.alert_deliveries (workspace_id, event_id, event, incident_id, channel_id, recipient, status, sent_at, provider_id)
      values ($1, $2, 'opened', $3, $4, 'channel', 'sent', now(), 'tg-1') returning id`, [w, opened, inc, chat])).id;
    const due = (await q(`insert into public.alert_deliveries (workspace_id, event_id, event, incident_id, channel_id, recipient)
      values ($1, $2, 'opened', $3, $4, 'channel') returning id`, [w, opened, inc, waiting])).id;
    ids[tag] = { w, a1, a2, http, beat, inc, old, note, page, c0, c1, asset, logo, chat, waiting, sent, due };
  }

  const snapshot = async (workspaceId: string): Promise<Snapshot> =>
    (await admin.query("select public.workspace_snapshot($1) as s", [workspaceId])).rows[0].s;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, max: 2 });
    await fill("a");
    await fill("b");
  });

  afterAll(async () => {
    try {
      if (ws.length) await admin.query("delete from public.workspaces where id = any($1)", [ws]);
    } finally {
      await admin?.end();
    }
  });

  it("returns one workspace's rows and no other's, in the order each page read them", async () => {
    const s = await snapshot(ids.a.w);
    const of = (list: Record<string, unknown>[], key = "id") => list.map((r) => r[key]);
    expect(of(s.apps)).toEqual([ids.a.a1, ids.a.a2]);
    expect(of(s.monitors)).toEqual([ids.a.http, ids.a.beat]);
    expect(of(s.monitor_secrets, "monitor_id")).toEqual([ids.a.http]);
    // Newest first, as the incident list reads.
    expect(of(s.incidents)).toEqual([ids.a.inc, ids.a.old]);
    expect(of(s.incident_notes)).toEqual([ids.a.note]);
    expect(of(s.status_pages)).toEqual([ids.a.page]);
    expect(of(s.page_components)).toEqual([ids.a.c0, ids.a.c1]);
    expect(of(s.component_monitors, "monitor_id")).toEqual([ids.a.http]);
    expect(of(s.page_assets)).toEqual([ids.a.asset]);
    expect(of(s.app_logos)).toEqual([ids.a.logo]);
    expect(of(s.heartbeat_latest, "monitor_id")).toEqual([ids.a.beat]);
    // The members' channel, made with the workspace, then the two this file added.
    expect(of(s.alert_channels).slice(1)).toEqual([ids.a.chat, ids.a.waiting]);
    expect(s.alert_channels[0].audience).toBe("members");
    // Only the settled receipt: what is still due isn't an "Alerts sent" line yet.
    expect(of(s.alert_deliveries)).toEqual([ids.a.sent]);
    expect(s.history.monitors.map((m) => m.id).sort()).toEqual([ids.a.http, ids.a.beat].sort());
    const everything = JSON.stringify(s);
    for (const id of Object.values(ids.b)) expect(everything).not.toContain(id);
  });

  it("carries only the columns the dashboard read: no token, no sealed value, no image bytes", async () => {
    const s = await snapshot(ids.a.w);
    for (const m of s.monitors) expect(Object.keys(m).sort()).toEqual(MONITOR_KEYS);
    expect(Object.keys(s.monitor_secrets[0]).sort()).toEqual(["monitor_id", "name"]);
    expect(Object.keys(s.page_assets[0]).sort()).toEqual(["id", "kind", "page_id"]);
    expect(Object.keys(s.app_logos[0]).sort()).toEqual(["app_id", "id"]);
    expect(Object.keys(s.component_monitors[0]).sort()).toEqual(["component_id", "monitor_id"]);
    expect(Object.keys(s.heartbeat_latest[0]).sort()).toEqual(["fail_at", "judged_at", "monitor_id", "ping_at", "ping_payload", "run_at", "start_at"]);
    // Never a chat id, a confirmation's hash or a recipient.
    for (const c of s.alert_channels) expect(Object.keys(c).sort()).toEqual(["address", "audience", "confirmed_at", "id", "kind", "label"]);
    expect(Object.keys(s.alert_deliveries[0]).sort()).toEqual(["channel_id", "created_at", "event", "id", "incident_id", "sent_at", "status"]);
    const everything = JSON.stringify(s);
    for (const secret of ["sealedtoken", "sealedvalue", "truncated", "started", "boom", "89504e47"]) expect(everything).not.toContain(secret);
  });

  it("reads every column of the tables the dashboard selected whole, as PostgREST returned them", async () => {
    const s = await snapshot(ids.a.w);
    const columns = async (table: string) =>
      (await admin.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table])).rows.map((r) => r.column_name).sort();
    for (const [key, table] of [["apps", "apps"], ["incidents", "incidents"], ["incident_notes", "incident_notes"], ["status_pages", "status_pages"], ["page_components", "page_components"]] as const) {
      expect(Object.keys(s[key][0]).sort()).toEqual(await columns(table));
    }
    // Times arrive in the ISO form `Date.parse` reads, as PostgREST's did.
    expect(Number.isFinite(Date.parse(String(s.apps[0].created_at)))).toBe(true);
  });

  it("carries workspace_domains's own answer under `domains`", async () => {
    const s = await snapshot(ids.a.w);
    const direct = (await admin.query("select coalesce(jsonb_agg(to_jsonb(d) order by d.host), '[]'::jsonb) as d from public.workspace_domains($1) d", [ids.a.w])).rows[0].d;
    expect(s.domains).toEqual(direct);
  });

  it("carries workspace_history's own answer under `history`", async () => {
    const s = await snapshot(ids.a.w);
    const direct = (await admin.query("select public.workspace_history($1) as h", [ids.a.w])).rows[0].h;
    expect(s.history).toEqual(direct);
  });

  it("answers an unknown workspace with nothing in every list", async () => {
    const s = await snapshot(`ws_${hex(12)}`);
    for (const key of ["apps", "monitors", "monitor_secrets", "incidents", "incident_notes", "status_pages", "page_components", "component_monitors", "page_assets", "app_logos", "heartbeat_latest", "domains", "alert_channels", "alert_deliveries"]) {
      expect(s[key]).toEqual([]);
    }
    expect(s.history.monitors).toEqual([]);
  });

  it("runs for the server's key and nobody else", async () => {
    const as = async (role: string) => {
      const client = await admin.connect();
      try {
        await client.query("begin");
        await client.query(`set local role ${role}`);
        await client.query("select public.workspace_snapshot($1)", [ids.a.w]);
        return "ran";
      } catch (e) {
        return (e as { code?: string }).code;
      } finally {
        await client.query("rollback");
        client.release();
      }
    };
    expect(await as("service_role")).toBe("ran");
    expect(await as("anon")).toBe("42501");
    expect(await as("authenticated")).toBe("42501");
  });
});
