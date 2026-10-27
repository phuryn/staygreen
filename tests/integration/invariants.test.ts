import { afterAll, beforeAll, expect, it } from "vitest";
import { limits } from "@/lib/plans";
import {
  checkViolation,
  clientFor,
  describeTarget,
  dnsMonitor,
  expectOk,
  expectRefused,
  Fixtures,
  heartbeatMonitor,
  hex,
  httpMonitor,
  NOT_FOUND,
  raised,
  readTarget,
  refusalOf,
  testOrgId,
  testSealed,
  testTokenHash,
  uniqueViolation,
} from "../support/integration";

/* The once-only actions, idempotency and the invariants the schema holds
   itself (`docs/TESTS.md § Required for every feature that touches data`;
   `AGENTS.md § 1.1`: invariants are database constraints, not application code;
   `§ 2.8`). Each is driven through the real function where one exists, twice or
   concurrently, and the row is read back to show the second call changed nothing. */

const target = readTarget();

const TABLES = ["apps", "monitors", "monitor_secrets", "incidents", "incident_notes", "status_pages", "page_components", "component_monitors"] as const;

describeTarget("invariants: once-only actions, idempotency and the schema's own guarantees", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);
  let W: { id: string };
  let app: { id: string };

  beforeAll(async () => {
    W = await fx.workspace();
    app = await fx.app(W.id);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  // ── workspaces ──────────────────────────────────────────────────────────────

  it("ensure_workspace returns the same row for the same organization, and a new org gets a new one", async () => {
    const org = (await db.from("workspaces").select("clerk_org_id").eq("id", W.id).single()).data!.clerk_org_id;
    const again = expectOk(await db.rpc("ensure_workspace", { p_clerk_org_id: org }));
    expect(again.id).toBe(W.id);
    const other = await fx.workspace();
    expect(other.id).not.toBe(W.id);
  });

  it("ensure_workspace under a race: five concurrent first visits create one workspace", async () => {
    const org = testOrgId();
    const results = await Promise.all(Array.from({ length: 5 }, () => db.rpc("ensure_workspace", { p_clerk_org_id: org })));
    const ids = results.map((r) => r.data?.id).filter(Boolean) as string[];
    fx.workspaces.push(...new Set(ids));
    expect(results.map((r) => refusalOf(r))).toEqual(Array.from({ length: 5 }, () => ({ status: 200, code: undefined, message: undefined })));
    expect(new Set(ids).size).toBe(1);
    const rows = await db.from("workspaces").select("id").eq("clerk_org_id", org);
    expect(rows.data).toEqual([{ id: ids[0] }]);
  });

  it("ensure_workspace refuses a missing organization and a malformed one", async () => {
    expectRefused(await db.rpc("ensure_workspace", { p_clerk_org_id: null }), { status: 400, code: "22004", message: "organization_required" });
    expectRefused(await db.rpc("ensure_workspace", { p_clerk_org_id: "org_itest_has_underscores" }), checkViolation("workspaces", "workspaces_clerk_org_id_check"));
  });

  // ── incidents ───────────────────────────────────────────────────────────────

  it("ack_incident acknowledges once: a second acknowledgement changes nothing", async () => {
    const mon = await fx.monitor(dnsMonitor(W.id, app.id));
    const inc = await fx.incident(W.id, mon.id);
    const first = expectOk(await db.rpc("ack_incident", { p_workspace_id: W.id, p_incident_id: inc.id, p_via: "itest" }));
    expect(first.acked_at).not.toBeNull();
    expect(first.timeline.map((e: any) => e.text)).toEqual(["Acknowledged from itest"]);
    const second = expectOk(await db.rpc("ack_incident", { p_workspace_id: W.id, p_incident_id: inc.id, p_via: "itest again" }));
    expect(second).toEqual(first);
  });

  it("ack_incident under a race: five concurrent acknowledgements write one timeline entry", async () => {
    const mon = await fx.monitor(dnsMonitor(W.id, app.id));
    const inc = await fx.incident(W.id, mon.id);
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => db.rpc("ack_incident", { p_workspace_id: W.id, p_incident_id: inc.id, p_via: `racer ${i}` })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const row = (await db.from("incidents").select("acked_at, timeline").eq("id", inc.id).single()).data!;
    expect(row.timeline).toHaveLength(1);
    expect(new Set(results.map((r) => r.data.acked_at))).toEqual(new Set([row.acked_at]));
  });

  it("allows one open incident per monitor, and a new one once the first is resolved", async () => {
    const mon = await fx.monitor(dnsMonitor(W.id, app.id));
    const first = await fx.incident(W.id, mon.id);
    expectRefused(
      await db.from("incidents").insert({ workspace_id: W.id, monitor_id: mon.id, title: "itest second open", severity: "down" }).select("id"),
      uniqueViolation("incidents_one_open_per_monitor"),
    );
    const resolved = await db.from("incidents").update({ resolved_at: new Date().toISOString() }).eq("id", first.id).select("id");
    expect(resolved.data).toHaveLength(1);
    await fx.incident(W.id, mon.id);
  });

  // ── notes ───────────────────────────────────────────────────────────────────

  it("a published note never goes back to draft, and publishing it again keeps its first published_at", async () => {
    const mon = await fx.monitor(dnsMonitor(W.id, app.id));
    const inc = await fx.incident(W.id, mon.id);
    const draft = await fx.note(W.id, inc.id, false, "itest first words");
    expect({ status: draft.status, published_at: draft.published_at }).toEqual({ status: "draft", published_at: null });
    const args = (body: string, publish: boolean) => ({
      p_workspace_id: W.id,
      p_incident_id: inc.id,
      p_note_id: draft.id,
      p_state: "monitoring",
      p_body: body,
      p_publish: publish,
      p_author_user_id: null,
      p_author_client: "itest",
    });
    const published = expectOk(await db.rpc("save_incident_note", args("itest published words", true)));
    expect(published.status).toBe("published");
    expectRefused(await db.rpc("save_incident_note", args("itest back to draft", false)), raised("note_published"));
    const republished = expectOk(await db.rpc("save_incident_note", args("itest corrected words", true)));
    expect({ status: republished.status, published_at: republished.published_at, body: republished.body }).toEqual({
      status: "published",
      published_at: published.published_at,
      body: "itest corrected words",
    });
    expectRefused(await db.rpc("save_incident_note", { ...args("itest", true), p_publish: null }), { status: 400, code: "22004", message: "publish_required" });
  });

  // ── monitors ────────────────────────────────────────────────────────────────

  it("delete_monitor acts once: the second delete is not found", async () => {
    const mon = await fx.monitor(dnsMonitor(W.id, app.id));
    expectOk(await db.rpc("delete_monitor", { p_workspace_id: W.id, p_monitor_id: mon.id }), 204);
    expectRefused(await db.rpc("delete_monitor", { p_workspace_id: W.id, p_monitor_id: mon.id }), NOT_FOUND);
  });

  it("delete_monitor under a race: deleting a host's last two HTTP monitors at once leaves no SSL monitor on it", async () => {
    const host = `itest-${hex(4)}.example.com`;
    const [m1, m2] = [await fx.monitor(httpMonitor(W.id, app.id, host)), await fx.monitor(httpMonitor(W.id, app.id, host))];
    const ssl = async () => (await db.from("monitors").select("id").eq("workspace_id", W.id).eq("type", "ssl").eq("auto", true).eq("target_host", host)).data;
    expect(await ssl()).toHaveLength(1);
    const results = await Promise.all([m1, m2].map((m) => db.rpc("delete_monitor", { p_workspace_id: W.id, p_monitor_id: m.id })));
    for (const r of results) expectOk(r, 204);
    expect(await ssl()).toEqual([]);
  });

  it("pause_monitor takes a window of 1 to 43,200 minutes, or none until resumed, and refuses anything else", async () => {
    const mon = await fx.monitor(dnsMonitor(W.id, app.id));
    const pause = (minutes: number | null) => db.rpc("pause_monitor", { p_workspace_id: W.id, p_monitor_id: mon.id, p_minutes: minutes, p_reason: "  itest  " });
    for (const bad of [0, -1, 43201]) expectRefused(await pause(bad), raised("pause_window_invalid"));
    for (const ok of [1, 43200]) {
      const row = expectOk(await pause(ok));
      expect(Date.parse(row.paused_until) - Date.parse(row.paused_at)).toBe(ok * 60_000);
      expect(row.pause_reason).toBe("itest");
    }
    const open = expectOk(await pause(null));
    expect({ until: open.paused_until, paused: open.paused_at !== null }).toEqual({ until: null, paused: true });
    const resumed = expectOk(await db.rpc("resume_monitor", { p_workspace_id: W.id, p_monitor_id: mon.id }));
    expect({ paused_at: resumed.paused_at, paused_until: resumed.paused_until, pause_reason: resumed.pause_reason }).toEqual({ paused_at: null, paused_until: null, pause_reason: null });
  });

  it("a heartbeat always carries a token hash, nothing else may, and no two monitors share one", async () => {
    expectRefused(await db.rpc("create_monitor", heartbeatMonitor(W.id, app.id, limits.free, { p_heartbeat_token_hash: null, p_heartbeat_token_sealed: null })), checkViolation("monitors", "monitors_heartbeat_token"));
    expectRefused(await db.rpc("create_monitor", dnsMonitor(W.id, app.id, limits.free, { p_heartbeat_token_hash: testTokenHash() })), checkViolation("monitors", "monitors_heartbeat_token"));
    const hb = await fx.monitor(heartbeatMonitor(W.id, app.id));
    expectRefused(
      await db.rpc("create_monitor", heartbeatMonitor(W.id, app.id, limits.free, { p_heartbeat_token_hash: hb.heartbeat_token_hash })),
      uniqueViolation("monitors_heartbeat_token_hash_key"),
    );
  });

  it("a sealed ping URL sits only beside a hash, and only in the sealed shape", async () => {
    expectRefused(await db.rpc("create_monitor", dnsMonitor(W.id, app.id, limits.free, { p_heartbeat_token_sealed: testSealed() })), checkViolation("monitors", "monitors_heartbeat_sealed"));
    // The plaintext token is not a sealed value, and is refused rather than stored.
    expectRefused(await db.rpc("create_monitor", heartbeatMonitor(W.id, app.id, limits.free, { p_heartbeat_token_sealed: hex(32) })), checkViolation("monitors", "monitors_heartbeat_sealed"));
    // A row from before the sealed copy holds none, and is still a heartbeat.
    const old = await fx.monitor(heartbeatMonitor(W.id, app.id, limits.free, { p_heartbeat_token_sealed: null }));
    expect(old.heartbeat_token_sealed).toBeNull();
  });

  it("rotating a heartbeat token retires the old hash: the monitor holds one hash, and the old one finds nothing", async () => {
    const hb = await fx.monitor(heartbeatMonitor(W.id, app.id));
    const old = hb.heartbeat_token_hash as string;
    const next = testTokenHash();
    // The statement `rotateHeartbeat` runs (`actions.ts`); the action itself is driven in `actions.test.ts`.
    const rotated = await db.from("monitors").update({ heartbeat_token_hash: next }).eq("id", hb.id).eq("workspace_id", W.id).eq("type", "heartbeat").select("id");
    expect(rotated.data).toEqual([{ id: hb.id }]);
    expect((await db.from("monitors").select("id").eq("heartbeat_token_hash", old)).data).toEqual([]);
    expect((await db.from("monitors").select("id").eq("heartbeat_token_hash", next)).data).toEqual([{ id: hb.id }]);
  });

  // ── deletion ────────────────────────────────────────────────────────────────

  it("deleting a workspace deletes everything it owns, sealed secrets included", async () => {
    const ws = await fx.workspace();
    const a = await fx.app(ws.id);
    const host = `itest-${hex(4)}.example.com`;
    const http = await fx.monitor(httpMonitor(ws.id, a.id, host, limits.free, { p_secrets: [{ name: "Authorization", sealed: `v1.${hex(8)}.${hex(16)}` }] }));
    const hb = await fx.monitor(heartbeatMonitor(ws.id, a.id));
    const inc = await fx.incident(ws.id, http.id);
    await fx.note(ws.id, inc.id, false);
    await fx.note(ws.id, inc.id, true);
    const page = await fx.page(ws.id, a.id);
    await fx.savePage(page as never, [{ name: "api", monitorIds: [http.id] }, { name: "cron", monitorIds: [hb.id] }]);

    const counts = async () => {
      const out: Record<string, number> = {};
      for (const table of TABLES) {
        const res = await db.from(table).select("*", { count: "exact", head: true }).eq("workspace_id", ws.id);
        if (res.error) throw new Error(`count ${table}: ${res.error.code}`);
        out[table] = res.count ?? -1;
      }
      return out;
    };
    expect(await counts()).toEqual({ apps: 1, monitors: 3, monitor_secrets: 1, incidents: 1, incident_notes: 2, status_pages: 1, page_components: 2, component_monitors: 2 });

    const deleted = await db.from("workspaces").delete().eq("id", ws.id).select("id");
    expect(deleted.data).toEqual([{ id: ws.id }]);
    expect(await counts()).toEqual({ apps: 0, monitors: 0, monitor_secrets: 0, incidents: 0, incident_notes: 0, status_pages: 0, page_components: 0, component_monitors: 0 });
  });
});
