import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { probeDatabase } from "../support/probe-database";
import { rpcFromPg, type Rpc } from "../../src/lib/alerts/rpc";
import { seal } from "../../src/lib/seal";
import { channelContext } from "../../src/lib/alerts/channel-input";

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
if (!url) console.warn('[integration] SKIPPED "channels 028": no local PROBE_DATABASE_URL; no database reached.');
if (url && !/^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) throw Error("Channels tests require a local database");
const suite = url ? describe : describe.skip;
const hex = () => randomBytes(12).toString("hex");

suite("028 channel routing and the real restricted sender", () => {
  let fixture: Awaited<ReturnType<typeof probeDatabase>>;
  let sender: pg.Pool;
  let rpc: Rpc;
  let admin: pg.Pool;
  let ws: string, other: string, app: string, otherApp: string, mon: string, email: string;
  let slack: string, discord: string, webhook: string;
  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;
  const one = async (sql: string, args: unknown[] = []) => (await q(sql, args))[0];
  const route = (monitor: string | null, severity: string, channels: string[] | null, feature = true, appId = app) =>
    admin.query("select public.set_alert_routing($1,$2,$3,$4,$5,$6)", [ws, appId, monitor, severity, channels, feature]);
  const incident = async (severity = "down") => (await one("insert into public.incidents(workspace_id,monitor_id,title,severity,evidence) values($1,$2,'API failure',$3,'{}') returning id", [ws, mon, severity])).id as string;
  const event = async (id: string, kind = "opened") => (await one("select id from public.alert_events where incident_id=$1 and kind=$2", [id, kind])).id as string;
  const claim = (eventId: string, name = "claim-test") => rpc("alert_claim_channels", { p_claim: name, p_limit: 100, p_lease_sec: 300, p_event_id: eventId }) as Promise<Record<string, unknown>[]>;
  const mark = (id: string, provider = "123.456", name = "claim-test") => rpc("alert_mark", { p_id: id, p_claim: name, p_status: "sent", p_provider_id: provider, p_detail: null, p_retry_sec: null, p_redirected: false });
  beforeAll(async () => {
    fixture = await probeDatabase(url, "alert_sender"); admin = fixture.admin;
    sender = new pg.Pool({ connectionString: fixture.probeUrl }); rpc = rpcFromPg(sender, "alert_sender");
  });
  beforeEach(async () => {
    ws = (await one("insert into public.workspaces(clerk_org_id) values($1) returning id", [`org_channels${hex()}`])).id;
    other = (await one("insert into public.workspaces(clerk_org_id) values($1) returning id", [`org_channels${hex()}`])).id;
    app = (await one("insert into public.apps(workspace_id,name) values($1,'Main') returning id", [ws])).id;
    otherApp = (await one("insert into public.apps(workspace_id,name) values($1,'Other') returning id", [other])).id;
    mon = (await one("insert into public.monitors(workspace_id,app_id,type,name,target,target_host,interval_sec,config) values($1,$2,'http','API','https://example.com','example.com',60,'{}') returning id", [ws, app])).id;
    email = (await one("select id from public.alert_channels where workspace_id=$1 and audience='members'", [ws])).id;
    for (const kind of ["slack", "discord", "webhook"]) {
      const id = `chan_${hex()}`;
      await q("insert into public.alert_channels(id,workspace_id,kind,label,sealed,confirmed_at) values($1,$2,$3,$3,$4,now())", [id, ws, kind, seal("credential-not-for-snapshots", channelContext(ws, id), randomBytes(32))]);
      if (kind === "slack") slack = id; else if (kind === "discord") discord = id; else webhook = id;
    }
  });
  afterEach(async () => { await admin.query("delete from public.workspaces where id=any($1)", [[ws, other]]); });
  afterAll(async () => { await sender?.end(); await fixture?.close(); });

  it("defaults to app channels, supports monitor overrides, and routes warnings separately", async () => {
    await route(null, "all", [slack]);
    await route(null, "warning", [email]);
    const down = await incident();
    expect((await one("select public.alert_route_matches($1,$2) v", [slack, down])).v).toBe(true);
    expect((await one("select public.alert_route_matches($1,$2) v", [email, down])).v).toBe(false);
    await q("update public.incidents set resolved_at=now() where id=$1", [down]);
    const warn = await incident("degraded");
    expect((await one("select public.alert_route_matches($1,$2) v", [email, warn])).v).toBe(true);
    await route(mon, "all", [discord]);
    expect((await one("select public.alert_route_matches($1,$2) v", [discord, warn])).v).toBe(true);
    expect((await one("select public.alert_route_matches($1,$2) v", [email, warn])).v).toBe(false);
    await route(mon, "warning", [webhook]);
    expect((await one("select public.alert_route_matches($1,$2) v", [discord, warn])).v).toBe(false);
    await route(mon, "warning", null); await route(mon, "all", null);
    expect((await one("select public.alert_route_matches($1,$2) v", [email, warn])).v).toBe(true);
  });

  it("saving no channels removes the rule and restores app defaults or legacy exclusions", async () => {
    await route(null, "all", [slack]);
    await route(mon, "all", [discord]);
    const inc = await incident();
    await route(mon, "all", []);
    expect(await q("select id from public.alert_routes where monitor_id=$1", [mon])).toEqual([]);
    expect((await one("select public.alert_route_matches($1,$2) v", [slack, inc])).v).toBe(true);
    expect((await one("select public.alert_route_matches($1,$2) v", [discord, inc])).v).toBe(false);

    await q("insert into public.alert_exclusions(channel_id,workspace_id,app_id) values($1,$2,$3)", [webhook, ws, app]);
    await route(null, "all", []);
    expect(await q("select id from public.alert_routes where app_id=$1", [app])).toEqual([]);
    expect((await one("select public.alert_route_matches($1,$2) v", [email, inc])).v).toBe(true);
    expect((await one("select public.alert_route_matches($1,$2) v", [webhook, inc])).v).toBe(false);
  });

  it.each(["monitor warning", "monitor all", "app warning", "app all"])("removing the last channel from %s falls through to the next rule", async (scope) => {
    const monitor = scope.startsWith("monitor") ? mon : null;
    const severity = scope.endsWith("warning") ? "warning" : "all";
    if (scope === "monitor warning") await route(mon, "all", [slack]);
    if (scope === "monitor all") await route(null, "warning", [slack]);
    if (scope === "app warning") await route(null, "all", [slack]);
    // With no explicit fallback, the original exclusions still decide the audience.
    await q("insert into public.alert_exclusions(channel_id,workspace_id,app_id) values($1,$2,$3)", [webhook, ws, app]);
    await route(monitor, severity, [discord]);
    const inc = await incident("degraded");
    expect((await one("select public.alert_route_matches($1,$2) v", [slack, inc])).v).toBe(false);
    await q("delete from public.alert_channels where id=$1", [discord]);
    // The FK removed the channel link, not the rule: even a leftover empty rule must be skipped.
    expect(await q("select id from public.alert_routes where app_id=$1 and monitor_id is not distinct from $2 and severity=$3", [app, monitor, severity])).toHaveLength(1);
    expect((await one("select public.alert_route_matches($1,$2) v", [slack, inc])).v).toBe(true);
    expect((await one("select public.alert_route_matches($1,$2) v", [webhook, inc])).v).toBe(false);
    const ev = await event(inc);
    await rpc("alert_expand", { p_event_id: ev, p_members: [] });
    const deliveries = await claim(ev);
    expect(deliveries.map((d) => (d.channel as { id: string }).id)).toEqual([slack]);
    expect(deliveries[0].why).toBeNull();
  });

  it("deleting an app moves its shared host's SSL monitor and monitor rule to the surviving app", async () => {
    const survivor = (await one("insert into public.apps(workspace_id,name) values($1,'Survivor') returning id", [ws])).id;
    await q("insert into public.monitors(workspace_id,app_id,type,name,target,target_host,interval_sec) values($1,$2,'http','Other API','https://example.com/health','example.com',60)", [ws, survivor]);
    const ssl = (await one("insert into public.monitors(workspace_id,app_id,type,name,target,target_host,interval_sec,auto) values($1,$2,'ssl','Certificate','example.com','example.com',3600,true) returning id", [ws, app])).id;
    await route(null, "all", [email]);
    await route(null, "all", [webhook], true, survivor);
    await route(ssl, "warning", [slack]);
    const rule = (await one("select id from public.alert_routes where monitor_id=$1", [ssl])).id;
    const inc = (await one("insert into public.incidents(workspace_id,monitor_id,title,severity,evidence) values($1,$2,'Certificate expiring','degraded','{}') returning id", [ws, ssl])).id;

    await q("select public.delete_app($1,$2)", [ws, app]);
    expect(await q("select id from public.apps where id=$1", [app])).toEqual([]);
    expect(await q("select id,app_id from public.monitors where id=$1", [ssl])).toEqual([{ id: ssl, app_id: survivor }]);
    expect(await q("select id,app_id from public.alert_routes where monitor_id=$1", [ssl])).toEqual([{ id: rule, app_id: survivor }]);
    expect(await q("select channel_id from public.alert_route_channels where route_id=$1", [rule])).toEqual([{ channel_id: slack }]);
    expect((await one("select public.alert_route_matches($1,$2) v", [slack, inc])).v).toBe(true);
    expect((await one("select public.alert_route_matches($1,$2) v", [webhook, inc])).v).toBe(false);
    await q("select public.delete_app($1,$2)", [ws, survivor]);
    expect(await q("select id from public.monitors where id=$1", [ssl])).toEqual([]);
    expect(await q("select id from public.alert_routes where id=$1", [rule])).toEqual([]);
    expect(await q("select channel_id from public.alert_route_channels where route_id=$1", [rule])).toEqual([]);
  });

  it("refuses foreign app/monitor/channel ids, missing allowance and Free severity rules", async () => {
    const foreign = (await one("select id from public.alert_channels where workspace_id=$1", [other])).id;
    await expect(route(null, "all", [foreign])).rejects.toMatchObject({ code: "PT404" });
    await expect(route(mon, "all", [slack], true, otherApp)).rejects.toMatchObject({ code: "PT404" });
    await expect(route(null, "warning", [slack], false)).rejects.toMatchObject({ code: "P0001" });
    await expect(admin.query("select public.set_alert_routing($1,$2,null,'all',$3,null)", [ws, app, [slack]])).rejects.toMatchObject({ code: "22004" });
    await route(null, "all", [slack], false);
    const id = (await one("select id from public.alert_routes where app_id=$1", [app])).id;
    await expect(admin.query("insert into public.alert_route_channels(route_id,workspace_id,channel_id) values($1,$2,$3)", [id, ws, foreign])).rejects.toMatchObject({ code: "23503" });
  });

  it("expands once, excludes new transports from legacy claims and gives only one worker each receipt", async () => {
    await route(null, "all", [slack, discord, webhook]);
    const ev = await event(await incident());
    const pending = await rpc("alert_pending_events", { p_limit: 10, p_event_id: ev }) as { needsMembers: boolean }[];
    expect(pending[0].needsMembers).toBe(false);
    await Promise.all([rpc("alert_expand", { p_event_id: ev, p_members: null }), rpc("alert_expand", { p_event_id: ev, p_members: null })]);
    expect(await rpc("alert_claim", { p_claim: "old-worker", p_limit: 100, p_lease_sec: 300, p_event_id: ev })).toEqual([]);
    const batches = await Promise.all([claim(ev, "worker-one"), claim(ev, "worker-two")]);
    expect(batches.flat()).toHaveLength(3);
    expect(new Set(batches.flat().map((d) => d.id)).size).toBe(3);
    expect((await q("select id from public.alert_deliveries where event_id=$1", [ev]))).toHaveLength(3);
  });

  it("holds recovery until opening settles, then supplies its thread timestamp", async () => {
    await route(null, "all", [slack]);
    const inc = await incident(), ev = await event(inc);
    await rpc("alert_expand", { p_event_id: ev, p_members: null });
    const opened = await claim(ev);
    await q("update public.monitors set state='up', state_since=now() where id=$1", [mon]);
    await q("update public.incidents set resolved_at=now() where id=$1", [inc]);
    const recovery = await event(inc, "resolved");
    await rpc("alert_expand", { p_event_id: recovery, p_members: null });
    expect(await claim(recovery)).toEqual([]);
    await mark(String(opened[0].id));
    expect((await claim(recovery))[0].parentProviderId).toBe("123.456");
  });

  it("rechecks routes before send and never exposes credentials or saved payloads in snapshots", async () => {
    await route(null, "all", [webhook]);
    const ev = await event(await incident());
    await rpc("alert_expand", { p_event_id: ev, p_members: null });
    await route(null, "all", [slack]);
    expect((await claim(ev))[0].why).toBe("excluded");
    const overview = (await one("select public.alert_overview($1,100) v", [ws])).v;
    const snap = (await one("select public.workspace_snapshot($1) v", [ws])).v;
    for (const v of [overview, snap]) expect(JSON.stringify(v)).not.toMatch(/sealed|webhook_body|state_hash|credential-not-for-snapshots|v1\./);
  });

  it("freezes the webhook body before sending; attempts survive a crash and a stale owner cannot prepare", async () => {
    await route(null, "all", [webhook]);
    const ev = await event(await incident()); await rpc("alert_expand", { p_event_id: ev, p_members: null });
    const d = (await claim(ev))[0];
    const prepare = (body: string, owner = "claim-test") => rpc("alert_prepare_webhook", { p_id: d.id, p_claim: owner, p_body: body });
    expect(await prepare('{"id":"original"}')).toMatchObject({ body: '{"id":"original"}', attempts: 1 });
    await q("update public.alert_deliveries set claimed_at=now()-interval '6 minutes' where id=$1", [d.id]);
    expect((await claim(ev, "new-owner"))[0]).toMatchObject({ inDoubt: true, webhookAttempts: 1, webhookBody: '{"id":"original"}' });
    expect(await prepare("{}", "claim-test")).toBeNull();
    expect(await prepare('{"id":"changed"}', "new-owner")).toMatchObject({ body: '{"id":"original"}', attempts: 2 });
    await expect(sender.query("select * from public.alert_channels")).rejects.toMatchObject({ code: "42501" });
  });

  it("consumes Slack state once only for its original user and workspace, within ten minutes", async () => {
    const state = randomBytes(32).toString("hex");
    await q("insert into public.slack_installs(state_hash,workspace_id,user_id) values($1,$2,'user_owner')", [state, ws]);
    const consume = (workspace: string, user: string) => one("select public.consume_slack_install($1,$2,$3) v", [state, workspace, user]);
    expect((await consume(other, "user_owner")).v).toBe(false);
    expect((await consume(ws, "user_other")).v).toBe(false);
    expect((await consume(ws, "user_owner")).v).toBe(true);
    expect((await consume(ws, "user_owner")).v).toBe(false);
    await q("insert into public.slack_installs(state_hash,workspace_id,user_id,created_at) values($1,$2,'user_owner',now()-interval '11 minutes')", [state, ws]);
    expect((await consume(ws, "user_owner")).v).toBe(false);
  });
});
