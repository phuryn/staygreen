import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { probeDatabase, servicePool } from "../support/probe-database";
import { limits } from "@/lib/plans";

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
if (url && !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw Error("Local Postgres only");
if (!url) console.warn('[integration] SKIPPED "agent surface": PROBE_DATABASE_URL is not set; no database was reached.');
const suite = url ? describe : describe.skip;
const id = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;
const L = { ...limits.free, minInterval: 180 };
const B = { ...limits.builder, minInterval: 60, perHost: limits.builder.monitors, supabaseMonitors: limits.builder.monitors };
const actor = "a".repeat(64);
const hash = "b".repeat(64);
const monitor = (type = "http") => ({ id: id("mon"), type, name: type === "heartbeat" ? "Backup" : "Website", target: type === "heartbeat" ? "Backup" : "https://example.com", target_host: type === "heartbeat" ? null : "example.com", interval_sec: type === "heartbeat" ? 86400 : 180,
  config: type === "heartbeat" ? { schedule: "0 0 * * *", tz: "UTC", graceMin: 5, maxRunMin: 60, assertions: [] } : { method: "GET", expect: "2xx", slowMs: 3000, assertions: [] },
  secrets: [], heartbeat_hash: type === "heartbeat" ? randomBytes(32).toString("hex") : null, heartbeat_sealed: type === "heartbeat" ? "v1.YWJj.ZGVm" : null });
suite("agent surface transactions on local Postgres", () => {
  let service: Awaited<ReturnType<typeof probeDatabase>>;
  let probe: Awaited<ReturnType<typeof probeDatabase>>;
  let sql: ReturnType<typeof servicePool>; let probeSql: pg.Pool;
  let ws: string; let other: string; const budgetKeys: string[] = [];
  beforeAll(async () => {
    service = await probeDatabase(url, "service_role"); probe = await probeDatabase(url);
    sql = servicePool(service.probeUrl); probeSql = new pg.Pool({ connectionString: probe.probeUrl });
    const create = async () => (await service.admin.query("insert into public.workspaces(clerk_org_id) values($1) returning id", ["org_agent" + randomBytes(6).toString("hex")])).rows[0].id as string;
    ws = await create(); other = await create();
  });
  beforeEach(async () => {
    for (const table of ["apps", "agent_activity", "agent_requests", "api_tokens"]) await service.admin.query(`delete from public.${table} where workspace_id=any($1)`, [[ws, other]]);
  });
  afterAll(async () => {
    if (service) { await service.admin.query("delete from public.workspaces where id=any($1)", [[ws, other]]); await service.admin.query("delete from public.agent_budgets where key=any($1)", [budgetKeys]); }
    await probeSql?.end(); await sql?.end(); await probe?.close(); await service?.close();
  });
  async function write(tool: string, payload: unknown, options: { workspace?: string; actor?: string; request?: string; hash?: string; scope?: string; limits?: unknown } = {}) {
    return (await sql.query("select public.agent_write($1,$2,$3,$4,$5,$6,$7,$8,$9) as result", [options.workspace ?? ws, options.actor ?? actor, "Test client", options.scope ?? "write", tool, options.request ?? randomUUID(), options.hash ?? hash, JSON.stringify(payload), JSON.stringify(options.limits === undefined ? L : options.limits)])).rows[0].result;
  }
  const setup = (monitors = [monitor()]) => ({ url: "https://example.com", name: "Example", slug: "test-" + randomBytes(8).toString("hex"), monitors, skipped: [] });
  const defaultSetup = (address: string) => ({ ...setup([{ ...monitor(), target: address, target_host: new URL(address).hostname }]), url: address, name: null, name_base: new URL(address).hostname });
  const provision = () => write("provision_app", setup());
  const count = async (table: string) => (await service.admin.query(`select count(*)::int n from public.${table} where workspace_id=$1`, [ws])).rows[0].n;

  it("stores a complete NS baseline through the existing monitor transaction without a schema change", async () => {
    const app = await provision();
    const ns = { ...monitor("dns"), target: "NS example.com", name: "Domain nameservers", interval_sec: 600,
      config: { record: "NS", name: "example.com", expected: "ns1.example.net, ns2.example.net" } };
    await write("create_monitor", { app: app.app, monitor: ns });
    expect((await sql.query("select type,config from public.monitors where id=$1 and workspace_id=$2", [ns.id, ws])).rows).toEqual([{ type: "dns", config: ns.config }]);
    await expect(write("create_monitor", { app: app.app, monitor: { ...ns, id: id("mon") } }, { workspace: other })).rejects.toMatchObject({ code: "PT404" });
  });

  it("creates an app, automatic SSL and page atomically; parallel retries have one receipt and audit row", async () => {
    const payload = setup([monitor(), monitor("heartbeat")]); const request = randomUUID();
    const results = await Promise.all(Array.from({ length: 6 }, () => write("provision_app", payload, { request })));
    expect(results.every(r => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
    expect(results[0]).toMatchObject({ created: true, heartbeats: [{ sealed: "v1.YWJj.ZGVm" }] });
    expect(await count("apps")).toBe(1); expect(await count("monitors")).toBe(3); expect(await count("status_pages")).toBe(1);
    expect(await count("agent_requests")).toBe(1); expect(await count("agent_activity")).toBe(1);
    const exposed = (await sql.query("select m.type from public.component_monitors c join public.monitors m on m.id=c.monitor_id where c.workspace_id=$1", [ws])).rows;
    expect(exposed).toEqual([{ type: "http" }]);
    await expect(write("provision_app", payload, { request, hash: "c".repeat(64) })).rejects.toMatchObject({ code: "PT409" });
  });
  it("serializes different request ids for the same URL without creating duplicate checks or returning old heartbeat credentials", async () => {
    const payload = setup([monitor(), monitor("heartbeat")]);
    const r = await Promise.all(Array.from({ length: 4 }, () => write("provision_app", payload)));
    expect(r.filter(x => x.created)).toHaveLength(1); expect(new Set(r.map(x => x.app)).size).toBe(1);
    expect(r.filter(x => !x.created).every(x => x.heartbeats.length === 0)).toBe(true);
    expect(await count("monitors")).toBe(3);
  });
  it.each(["example.com", `${"preview-".repeat(6)}branch.preview.example.com`])("provisions bounded, distinct names for %s and a second URL on the host, then replays both receipts", async host => {
    const payloads = [defaultSetup(`https://${host}`), defaultSetup(`https://${host}/docs`)];
    const requests = [randomUUID(), randomUUID()];
    const results = [];
    for (const [index, payload] of payloads.entries()) {
      results.push(await write("provision_app", payload, { request: requests[index], limits: B }));
    }
    expect(results.every(r => r.created)).toBe(true);
    expect(new Set(results.map(r => r.app)).size).toBe(2);
    const names = (await sql.query("select name from public.apps where id=any($1) order by name", [results.map(r => r.app)])).rows.map(r => r.name);
    expect(names.sort()).toEqual([host.slice(0, 60), host.slice(0, 56) + " (2)"].sort());
    for (const [index, payload] of payloads.entries()) {
      expect(await write("provision_app", payload, { request: requests[index], limits: B })).toEqual(results[index]);
    }
    const existing = await write("provision_app", defaultSetup(`https://${host}/`), { limits: B });
    expect(existing).toMatchObject({ app: results[0].app, created: false });
    expect(await count("apps")).toBe(2); expect(await count("status_pages")).toBe(2);
    expect(await count("agent_requests")).toBe(3); expect(await count("agent_activity")).toBe(3);
  });
  it("skips case-insensitive dashboard names and allocates names serially for concurrent ports and schemes", async () => {
    await sql.query("select public.create_app($1,$2,$3,$4)", [ws, "EXAMPLE.COM", "https://example.com", B.apps]);
    await sql.query("select public.create_app($1,$2,$3,$4)", [ws, "EXAMPLE.COM (2)", "https://another.example.com", B.apps]);
    // Another workspace's name does not consume this workspace's next suffix.
    await sql.query("select public.create_app($1,$2,$3,$4)", [other, "example.com (3)", "https://other.example.com", B.apps]);
    const results = await Promise.all(["https://example.com/docs", "https://example.com:8443", "http://example.com"].map(address => write("provision_app", defaultSetup(address), { limits: B })));
    expect(results.every(r => r.created)).toBe(true);
    const names = (await sql.query("select name from public.apps where id=any($1) order by name", [results.map(r => r.app)])).rows.map(r => r.name);
    expect(names).toEqual(["example.com (3)", "example.com (4)", "example.com (5)"]);
  });
  it.each([
    { name: "EXAMPLE.COM", code: "23505", constraint: "apps_workspace_name_key" },
    { name: "x".repeat(61), code: "23514", constraint: "apps_name_check" },
  ])("rolls back explicit name refusal $constraint and accepts a correction without a stuck receipt", async ({ name, code, constraint }) => {
    await write("provision_app", defaultSetup("https://example.com"), { limits: B });
    const payload = { ...defaultSetup("https://example.com/docs"), name }; const request = randomUUID();
    await expect(write("provision_app", payload, { request, limits: B })).rejects.toMatchObject({ code, constraint });
    for (const table of ["apps", "status_pages", "agent_requests", "agent_activity"]) expect(await count(table)).toBe(1);
    const corrected = { ...payload, name: "Documentation" };
    const result = await write("provision_app", corrected, { request, hash: "c".repeat(64), limits: B });
    expect(result.created).toBe(true);
    expect(await write("provision_app", corrected, { request, hash: "c".repeat(64), limits: B })).toEqual(result);
    for (const table of ["apps", "status_pages", "agent_requests", "agent_activity"]) expect(await count(table)).toBe(2);
  });
  it("rolls back the entire setup on a quota failure and rejects omitted limits", async () => {
    const payload = setup([monitor(), monitor("heartbeat"), monitor("heartbeat")]);
    await expect(write("provision_app", payload, { limits: { ...L, heartbeats: 1 } })).rejects.toMatchObject({ message: "heartbeat_limit" });
    for (const table of ["apps", "monitors", "status_pages", "agent_requests", "agent_activity"]) expect(await count(table)).toBe(0);
    await expect(write("provision_app", payload, { limits: null })).rejects.toMatchObject({ message: "limits_required" });
  });
  it("scopes every write and does not admit read credentials or unknown verbs", async () => {
    const r = await provision(); const mon = r.monitors.find((m: { type: string }) => m.type === "http").id;
    await expect(write("create_monitor", { app: r.app, monitor: monitor() }, { workspace: other })).rejects.toMatchObject({ code: "PT404" });
    await expect(write("pause", { monitor: mon, minutes: 10 }, { workspace: other })).rejects.toMatchObject({ code: "PT404" });
    await expect(write("pause", { monitor: mon, minutes: 10 }, { scope: "read" })).rejects.toMatchObject({ code: "PT403" });
    await expect(write("delete_monitor", { monitor: mon })).rejects.toMatchObject({ message: "unknown_tool" });
    expect(await count("agent_activity")).toBe(1);
  });
  it("caps pauses, resumes on a deadline and does not extend the deadline on replay", async () => {
    const r = await provision(); const request = randomUUID();
    await expect(write("pause", { app: r.app, minutes: 1441 })).rejects.toMatchObject({ message: "pause_window_invalid" });
    const paused = await write("pause", { app: r.app, minutes: 1440 }, { request });
    expect(paused.monitors).toHaveLength(2);
    expect(await write("pause", { app: r.app, minutes: 1440 }, { request })).toEqual(paused);
    const saved = await sql.query("select paused_until from public.monitors where workspace_id=$1", [ws]);
    expect(saved.rows.every(m => m.paused_until.toISOString() === new Date(paused.paused_until).toISOString())).toBe(true);
  });
  it("only creates drafts, preserves publication and returns latest published notes per incident", async () => {
    const r = await provision(); const mon = r.monitors.find((m: { type: string }) => m.type === "http").id;
    const inc = (await service.admin.query("insert into public.incidents(workspace_id,monitor_id,title,severity) values($1,$2,'Failure','down') returning id", [ws, mon])).rows[0].id;
    await expect(write("draft_incident_update", { incident: inc, text: "x", state: "investigating" }, { workspace: other })).rejects.toMatchObject({ code: "PT404" });
    const r2 = await write("draft_incident_update", { incident: inc, text: "An agent draft", state: "resolved", publish: true });
    expect(r2.published).toBe(false);
    const note = (await sql.query("select status,author_client,author_user_id,published_at from public.incident_notes where id=$1", [r2.draft])).rows[0];
    expect(note).toEqual({ status: "draft", author_client: "Test client", author_user_id: null, published_at: null });
    expect((await sql.query("select public.agent_published_notes($1,$2) notes", [ws, [inc]])).rows[0].notes).toEqual([]);
    await sql.query("select public.save_incident_note($1,$2,null,'identified','Published',true,'user_test',null)", [ws, inc]);
    expect((await sql.query("select public.agent_published_notes($1,$2) notes", [ws, [inc]])).rows[0].notes).toEqual([expect.objectContaining({ body: "Published" })]);
    expect((await sql.query("select public.agent_published_notes($1,$2) notes", [other, [inc]])).rows[0].notes).toEqual([]);
  });
  it("rechecks token revocation in the write transaction and preserves its tombstone", async () => {
    const token = id("tok"); await sql.query("select public.agent_token_create($1,$2,'CI',$3,$4,'write')", [ws, token, randomBytes(12).toString("hex"), hash]);
    const r = await write("provision_app", setup(), { actor: token });
    await sql.query("update public.api_tokens set revoked_at=now() where id=$1", [token]);
    await expect(write("pause", { app: r.app, minutes: 10 }, { actor: token })).rejects.toMatchObject({ code: "PT401" });
    expect(await count("api_tokens")).toBe(1); expect(await count("agent_activity")).toBe(1);
  });
  it("counts the shared workspace budget atomically under concurrent first use and resets after a minute", async () => {
    const key = randomBytes(32).toString("hex"); budgetKeys.push(key);
    const calls = await Promise.all(Array.from({ length: 40 }, () => sql.query("select public.agent_budget($1,30) delay", [key])));
    expect(calls.filter(x => x.rows[0].delay === 0)).toHaveLength(30);
    expect(calls.filter(x => x.rows[0].delay > 0)).toHaveLength(10);
    await sql.query("update public.agent_budgets set started_at=now()-interval '61 seconds' where key=$1", [key]);
    expect((await sql.query("select public.agent_budget($1,30) delay", [key])).rows[0].delay).toBe(0);
    await expect(sql.query("select public.agent_budget($1,null)", [key])).rejects.toMatchObject({ message: "limits_required" });
  });
  it("retains hourly/daily envelopes on insert and update without granting probes table access", async () => {
    const r = await provision(); const mon = r.monitors.find((m: { type: string }) => m.type === "http").id;
    const at = new Date(Math.floor((Date.now()-600000)/300000)*300000).toISOString();
    // Real probe login calls the existing definer flush: the new invoker triggers must
    // work under its owner context without widening the probe login's privileges.
    const flush = (p95: number) => probeSql.query("select public.probe_flush_rollups($1::text[],$2::text[],$3::timestamptz[],$4::int[],$5::int[],$6::int[],$7::int[],$8::int[])", [[mon], ["tor1"], [at], [2], [0], [100], [p95], [p95]]);
    await flush(200); await flush(300);
    // A steady healthy monitor's state marker can be much older than its newest rollup.
    await service.admin.query("update public.monitors set state='up',state_since=now()-interval '1 day',probe_outcome_at=now()-interval '1 day' where id=$1", [mon]);
    const last = (await sql.query("select public.agent_check_times($1) r", [ws])).rows[0].r.find((x: { id: string }) => x.id === mon);
    expect(last.precision).toBe("5m_window_start"); expect(new Date(last.at).toISOString()).toBe(at);
    expect((await sql.query("select public.agent_check_times($1) r", [other])).rows[0].r).toEqual([]);
    expect((await sql.query("select resolution,p50_ms,p95_ms from public.response_rollups where monitor_id=$1 order by resolution", [mon])).rows).toEqual([{ resolution: "1d", p50_ms: 100, p95_ms: 300 }, { resolution: "1h", p50_ms: 100, p95_ms: 300 }]);
    expect((await sql.query("select public.agent_response_times($1,$2,7,null,0,100) r", [ws, mon])).rows[0].r).toHaveLength(1);
    await expect(sql.query("select public.agent_response_times($1,$2,7,null,0,100)", [other, mon])).rejects.toMatchObject({ code: "PT404" });
    await expect(probeSql.query("select * from public.response_rollups")).rejects.toMatchObject({ code: "42501" });
    await expect(probeSql.query("select public.agent_response_times($1,$2,7,null,0,100)", [ws, mon])).rejects.toMatchObject({ code: "42501" });
  });
  it("returns no-data uptime as null and refuses foreign monitor ids", async () => {
    const r = await provision(); const mon = r.monitors[0].id;
    expect((await sql.query("select public.agent_history($1,$2,1,10,null) r", [ws, mon])).rows[0].r).toEqual([expect.objectContaining({ uptime_pct: null, covered_minutes: 0 })]);
    await expect(sql.query("select public.agent_history($1,$2,1,10,null)", [other, mon])).rejects.toMatchObject({ code: "PT404" });
  });
  it("gives no client or worker privileges on agent objects; every new table has deny-all RLS", async () => {
    const names = ["api_tokens", "agent_requests", "agent_activity", "agent_calls", "agent_budgets", "response_rollups"];
    const rows = (await service.admin.query("select c.relname,c.relrowsecurity,(select count(*)::int from pg_policy p where p.polrelid=c.oid) policies from pg_class c where c.relnamespace='public'::regnamespace and c.relname=any($1)", [names])).rows;
    expect(rows).toHaveLength(names.length); expect(rows.every(r => r.relrowsecurity && r.policies === 0)).toBe(true);
    for (const role of ["anon", "authenticated", "probe", "ingest", "alert_sender"]) for (const table of names) {
      expect((await service.admin.query("select has_table_privilege($1,$2,'select,insert,update,delete') yes", [role, "public."+table])).rows[0].yes).toBe(false);
    }
    const fn = (await service.admin.query("select proname,prosecdef,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated from pg_proc where pronamespace='public'::regnamespace and (proname like 'agent_%' or proname='response_rollups_add')")).rows;
    expect(fn.length).toBeGreaterThanOrEqual(8); expect(fn.every(f => !f.prosecdef && !f.anon && !f.authenticated)).toBe(true);
  });
});
