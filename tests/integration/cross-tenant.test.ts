import { afterAll, beforeAll, expect, it } from "vitest";
import { limits } from "@/lib/plans";
import {
  clientFor,
  describeTarget,
  expectOk,
  expectRefused,
  Fixtures,
  fkViolation,
  heartbeatMonitor,
  hex,
  httpMonitor,
  NOT_FOUND,
  readTarget,
  savePageArgs,
} from "../support/integration";

/* Cross-tenant, at the database (`docs/TESTS.md § Required for every feature
   that touches data`). Two workspaces, A and B. Every SQL function that takes a
   workspace id and a resource id is called with A's workspace id and B's
   resource, by its real argument names, and must refuse: the not-found PT404 for
   a function that scopes its own lookup, the composite foreign key's 23503 for
   one that writes a row pointing at B's. Each refusal is asserted by status,
   SQLSTATE and message together, and B's rows are compared before and after the
   whole file, so a refusal that still wrote something fails too.

   The functions, from `supabase/migrations/`: create_monitor, delete_monitor,
   pause_monitor, resume_monitor, ack_incident, save_incident_note,
   create_status_page, save_status_page, delete_app, update_monitor. Rotating a heartbeat and
   deleting a note or a status page are not functions; they are statements
   inside Server Actions, covered through the actions in `actions.test.ts`. */

const target = readTarget();

const TABLES = ["apps", "monitors", "monitor_secrets", "incidents", "incident_notes", "status_pages", "page_components", "component_monitors"] as const;

describeTarget("cross-tenant: A's workspace id with B's resources is refused by every function", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);
  const L = limits.free;
  const sharedHost = `itest-${hex(4)}.example.com`;

  let A: { id: string }, B: { id: string };
  let appA: { id: string }, appB: { id: string }, appB2: { id: string };
  let monA: Record<string, any>, monB: Record<string, any>, hbB: Record<string, any>;
  let incA: Record<string, any>, incB: Record<string, any>;
  let noteB: Record<string, any>;
  let pageA: Record<string, any>, pageB: Record<string, any>;
  let before: Record<string, unknown[]>;

  /** Every row B owns, table by table, in a stable order. */
  async function rowsOf(workspaceId: string): Promise<Record<string, unknown[]>> {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const res = await db.from(table).select("*").eq("workspace_id", workspaceId);
      if (res.error) throw new Error(`read ${table}: ${res.error.code}`);
      out[table] = [...(res.data ?? [])].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    }
    return out;
  }

  beforeAll(async () => {
    A = await fx.workspace();
    B = await fx.workspace();
    appA = await fx.app(A.id);
    appB = await fx.app(B.id);
    appB2 = await fx.app(B.id);
    // The same host in both workspaces, so the automatic SSL monitor's per-workspace scope is tested too.
    monA = await fx.monitor(httpMonitor(A.id, appA.id, sharedHost, L));
    monB = await fx.monitor(httpMonitor(B.id, appB.id, sharedHost, L));
    hbB = await fx.monitor(heartbeatMonitor(B.id, appB.id, L));
    incA = await fx.incident(A.id, monA.id);
    incB = await fx.incident(B.id, monB.id);
    await fx.note(A.id, incA.id, false);
    noteB = await fx.note(B.id, incB.id, false, "B's draft, never A's to touch");
    pageA = await fx.page(A.id, appA.id);
    pageB = await fx.page(B.id, appB.id);
    pageA = await fx.savePage(pageA as never, [{ name: "A api", monitorIds: [monA.id] }]);
    pageB = await fx.savePage(pageB as never, [{ name: "B api", monitorIds: [monB.id] }, { name: "B cron", monitorIds: [hbB.id] }]);
    // B pauses its own heartbeat, so A has a paused monitor of B's to try to resume.
    hbB = expectOk(await db.rpc("pause_monitor", { p_workspace_id: B.id, p_monitor_id: hbB.id, p_minutes: null, p_reason: "B paused it" }));
    before = await rowsOf(B.id);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("gives two organizations two workspaces", () => {
    expect(A.id).toMatch(/^ws_[0-9a-f]{24}$/);
    expect(B.id).toMatch(/^ws_[0-9a-f]{24}$/);
    expect(A.id).not.toBe(B.id);
    expect(before.monitors.length).toBe(3); // B's http, its automatic SSL, its heartbeat
  });

  it("delete_monitor refuses B's monitor under A's workspace id", async () => {
    expectRefused(await db.rpc("delete_monitor", { p_workspace_id: A.id, p_monitor_id: monB.id }), NOT_FOUND);
    expectRefused(await db.rpc("delete_monitor", { p_workspace_id: A.id, p_monitor_id: hbB.id }), NOT_FOUND);
  });

  it("update_monitor refuses B's monitors under A's workspace id", async () => {
    const edit = (id: string, target: string, host: string | null, interval: number) => ({
      p_workspace_id: A.id,
      p_monitor_id: id,
      p_name: "A renames B's",
      p_target: target,
      p_target_host: host as string,
      p_interval_sec: interval,
      p_config: {},
      p_secrets: [],
      p_max_assertions: L.assertions,
      p_max_heartbeat_assertions: L.heartbeatAssertions,
      p_per_host: L.perHost as number,
      p_min_interval_sec: L.httpIntervalMin * 60,
    });
    expectRefused(await db.rpc("update_monitor", edit(monB.id, `https://${sharedHost}/a`, sharedHost, L.httpIntervalMin * 60)), NOT_FOUND);
    expectRefused(await db.rpc("update_monitor", edit(hbB.id, "in.staygreen.io", null, 86400)), NOT_FOUND);
  });

  it("delete_app refuses B's apps under A's workspace id", async () => {
    expectRefused(await db.rpc("delete_app", { p_workspace_id: A.id, p_app_id: appB.id }), NOT_FOUND);
    expectRefused(await db.rpc("delete_app", { p_workspace_id: A.id, p_app_id: appB2.id }), NOT_FOUND);
  });

  it("pause_monitor refuses B's monitor under A's workspace id", async () => {
    expectRefused(await db.rpc("pause_monitor", { p_workspace_id: A.id, p_monitor_id: monB.id, p_minutes: 60, p_reason: "itest" }), NOT_FOUND);
    expectRefused(await db.rpc("pause_monitor", { p_workspace_id: A.id, p_monitor_id: monB.id, p_minutes: null, p_reason: null }), NOT_FOUND);
  });

  it("resume_monitor refuses B's paused monitor under A's workspace id, and it stays paused", async () => {
    expect(hbB.paused_at).not.toBeNull();
    expectRefused(await db.rpc("resume_monitor", { p_workspace_id: A.id, p_monitor_id: hbB.id }), NOT_FOUND);
    const still = await db.from("monitors").select("paused_at, pause_reason").eq("id", hbB.id).single();
    expect(still.data).toEqual({ paused_at: hbB.paused_at, pause_reason: "B paused it" });
  });

  it("ack_incident refuses B's incident under A's workspace id", async () => {
    expectRefused(await db.rpc("ack_incident", { p_workspace_id: A.id, p_incident_id: incB.id, p_via: "itest" }), NOT_FOUND);
  });

  it("save_incident_note refuses a new note on B's incident under A's workspace id, draft or published", async () => {
    for (const publish of [false, true]) {
      expectRefused(
        await db.rpc("save_incident_note", {
          p_workspace_id: A.id,
          p_incident_id: incB.id,
          p_note_id: null,
          p_state: "investigating",
          p_body: "A writing on B's incident",
          p_publish: publish,
          p_author_user_id: null,
          p_author_client: "itest",
        }),
        NOT_FOUND,
      );
    }
  });

  it("save_incident_note refuses B's note under A's workspace id, through B's incident or A's own", async () => {
    for (const incidentId of [incB.id, incA.id]) {
      for (const publish of [false, true]) {
        expectRefused(
          await db.rpc("save_incident_note", {
            p_workspace_id: A.id,
            p_incident_id: incidentId,
            p_note_id: noteB.id,
            p_state: "resolved",
            p_body: "A rewriting B's note",
            p_publish: publish,
            p_author_user_id: null,
            p_author_client: "itest",
          }),
          NOT_FOUND,
        );
      }
    }
  });

  it("save_status_page refuses B's page under A's workspace id, and B's components survive", async () => {
    expectRefused(
      await db.rpc("save_status_page", savePageArgs({ ...(pageB as Parameters<typeof savePageArgs>[0]), workspace_id: A.id }, [], { p_slug: `itest-${hex(6)}`, p_name: "taken by A" })),
      NOT_FOUND,
    );
  });

  it("save_status_page refuses binding B's monitor to A's page (the composite foreign key), and A's page is left as it was", async () => {
    const componentsBefore = await db.from("page_components").select("id, name, position").eq("page_id", pageA.id).order("position");
    expectRefused(
      await db.rpc("save_status_page", savePageArgs(pageA as never, [{ name: "stolen", monitorIds: [monB.id] }])),
      fkViolation("component_monitors", "component_monitors_monitor_id_workspace_id_fkey"),
    );
    const componentsAfter = await db.from("page_components").select("id, name, position").eq("page_id", pageA.id).order("position");
    expect(componentsAfter.data).toEqual(componentsBefore.data);
    expect(componentsAfter.data?.map((c) => c.name)).toEqual(["A api"]);
  });

  it("create_monitor refuses B's app under A's workspace id (the composite foreign key)", async () => {
    expectRefused(await db.rpc("create_monitor", httpMonitor(A.id, appB.id, `itest-${hex(4)}.example.com`, L)), fkViolation("monitors", "monitors_app_id_workspace_id_fkey"));
    expectRefused(await db.rpc("create_monitor", heartbeatMonitor(A.id, appB.id, L)), fkViolation("monitors", "monitors_app_id_workspace_id_fkey"));
  });

  it("create_status_page refuses B's app under A's workspace id (the composite foreign key)", async () => {
    expectRefused(
      await db.rpc("create_status_page", {
        p_workspace_id: A.id,
        p_app_id: appB2.id,
        p_slug: `itest-${hex(6)}`,
        p_name: "A's page on B's app",
        p_logo_text: "",
        p_homepage: null,
        p_max_pages: limits.builder.statusPages,
      }),
      fkViolation("status_pages", "status_pages_app_id_workspace_id_fkey"),
    );
  });

  it("gives each workspace its own automatic SSL monitor for a shared host, and deleting A's monitor takes only A's", async () => {
    const ssl = async (ws: string) => (await db.from("monitors").select("id").eq("workspace_id", ws).eq("type", "ssl").eq("auto", true).eq("target_host", sharedHost)).data;
    expect((await ssl(A.id))?.length).toBe(1);
    expect((await ssl(B.id))?.length).toBe(1);
    // A second http monitor in A keeps A's SSL alive past the first delete; the last one takes it.
    const monA2 = await fx.monitor(httpMonitor(A.id, appA.id, sharedHost, L));
    expectOk(await db.rpc("delete_monitor", { p_workspace_id: A.id, p_monitor_id: monA2.id }), 204);
    expect((await ssl(A.id))?.length).toBe(1);
    const lone = await fx.monitor(httpMonitor(A.id, appA.id, sharedHost, L));
    expectOk(await db.rpc("delete_monitor", { p_workspace_id: A.id, p_monitor_id: monA.id }), 204);
    expectOk(await db.rpc("delete_monitor", { p_workspace_id: A.id, p_monitor_id: lone.id }), 204);
    expect(await ssl(A.id)).toEqual([]);
    expect((await ssl(B.id))?.length).toBe(1);
  });

  it("left every row B owns exactly as it was", async () => {
    const after = await rowsOf(B.id);
    expect(after).toEqual(before);
    expect(after.incident_notes).toEqual([expect.objectContaining({ id: noteB.id, status: "draft", body: "B's draft, never A's to touch" })]);
    expect(after.incidents).toEqual([expect.objectContaining({ id: incB.id, acked_at: null })]);
  });
});
