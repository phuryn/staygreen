import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentQuery } from "../support/agent-db";
import { AgentError, inputs, MCP_TOOLS, outputs, toolNames, type AgentPrincipal, type ToolName } from "@/lib/agent-contract";
import { FREE } from "@/lib/plans";
import { describeDbError } from "@/lib/db-errors";
const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), own: vi.fn(), check: vi.fn(), run: vi.fn(), budget: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => mocks }));
vi.mock("@/lib/workspace", () => ({ resolveApp: mocks.own, resolveMonitor: mocks.own, resolveIncident: mocks.own }));
vi.mock("@/lib/agent-auth", () => ({ spendAgentBudget: mocks.budget }));
vi.mock("@/lib/env", () => ({ env: () => ({ API_TOKEN_PEPPER: "pepper", APP_URL: "https://staygreen.test" }) }));
vi.mock("@/lib/credentials", () => ({ seal: () => "sealed-credential" }));
vi.mock("@/lib/heartbeat", () => ({ newHeartbeat: async () => ({ hash: "a".repeat(64), sealed: "sealed-heartbeat" }), openHeartbeat: () => "https://in.test/ping/new-credential" }));
vi.mock("@/lib/targets", () => ({ checkTarget: mocks.check }));
vi.mock("@/lib/monitor-test", () => ({ runTest: mocks.run, TEST_DEADLINE_MS: 25000 }));
vi.mock("@/checks/cert", () => ({ checkCert: vi.fn(async () => ({ ok: true, ms: 1 })) }));
vi.mock("@/checks/http", () => ({ checkHttp: vi.fn(async () => ({ ok: true, ms: 1 })) }));
vi.mock("@/checks/rdap", async importOriginal => ({ ...await importOriginal<typeof import("@/checks/rdap")>(), guardedFetch: () => async () => ({ error: "Fixture unavailable" }) }));
import { agentMonitorRow, executeAgentTool, normalizeAppUrl, safeTarget } from "@/lib/agent-service";
const app = "app_" + "a".repeat(24), mon = "mon_" + "a".repeat(24), inc = "inc_" + "a".repeat(24);
const workspace = { id: "ws_a", clerk_org_id: "org_a" };
const p: AgentPrincipal = { workspace, actor: "a".repeat(64), client: "Client", auth: "oauth", scope: "write", entitlements: FREE };
const request_id = "658f56b4-56d0-4af0-80c3-b435ce2ab311";
it("accepts a full nameserver set through the agent contract and shared monitor parser", () => {
  const input = { request_id, app, type: "dns", target: "example.com", config: { record: "NS", expected: "NS2.EXAMPLE.NET. ns1.example.net" } };
  expect(inputs.create_monitor.safeParse(input).success).toBe(true);
  expect(agentMonitorRow(inputs.create_monitor.parse(input)).config).toMatchObject({ record: "NS", name: "example.com", expected: "ns1.example.net, ns2.example.net" });
});
const at = "2026-10-23T00:00:00.000Z";
const monitor = { id: mon, app_id: app, name: "Website", type: "http", target: "https://example.com/?key=secret", interval_sec: 180, state: "up", paused_at: null, paused_until: null, probe_outcome_at: at, target_host: "example.com", cert_host: "example.com", cert_expires_at: null, heartbeat_token_sealed: "never-return-this" };
const calls: { table: string; q: ReturnType<typeof agentQuery> }[] = [];
const rows: Record<string, unknown> = {
  monitors: [monitor], apps: [{ id: app, name: "Website" }], page_components: [{ id: "cmp", page_id: "pg", name: "Website", in_app: true }], component_monitors: [{ component_id: "cmp", monitor_id: mon }], status_pages: [{ id: "pg", app_id: app }],
  incidents: [{ id: inc, monitor_id: mon, title: "Down", opened_at: at, resolved_at: null, timeline: [{ t: at, text: "Opened" }], evidence: { locations: ["tor1", "sfo3", "unknown"], assertion: "$.ok", snippet: "Bearer abcdefghijklmnop" } }], agent_requests: null,
};
const examples: Record<ToolName, unknown> = {
  scan_app: { url: "https://example.com" },
  list_monitors: {}, get_status: {}, get_uptime: {}, get_response_times: { monitor: mon }, get_incidents: {}, get_ssl_and_domain_expiry: {},
  provision_app: { request_id, url: "https://example.com", crons_from: [{ name: "Backup", schedule: "0 0 * * *" }] },
  create_monitor: { request_id, app, type: "http", target: "https://example.com" }, pause: { request_id, monitor: mon, minutes: 10 }, draft_incident_update: { request_id, incident: inc, text: "Investigating" },
};
beforeEach(() => {
  vi.clearAllMocks(); calls.length = 0;
  mocks.own.mockResolvedValue({ workspace }); mocks.check.mockResolvedValue({ ok: true }); mocks.run.mockResolvedValue({ ok: true, at: Date.parse(at) });
  mocks.from.mockImplementation(table => { const q = agentQuery(Object.hasOwn(rows, table) ? rows[table] : []); calls.push({ table, q }); return q; });
  mocks.rpc.mockImplementation(async (name, a) => {
    if (name === "admit_scan") return { data: 0 };
    if (name === "agent_check_times") return { data: [{ id: mon, at, precision: "5m_window_start" }] };
    if (name === "agent_published_notes") return { data: [{ id: "note", incident_id: inc, state: "investigating", body: "Known issue", published_at: at }] };
    if (name === "workspace_domains") return { data: [{ host: "example.com", status: "found", expires_at: null }] };
    if (name === "agent_history") return { data: [{ id: mon, uptime_pct: null, downtime_minutes: 0, covered_minutes: 0, incident_count: 0, daily: [] }] };
    if (name === "agent_response_times") return { data: [{ at, location: "tor1", p50_ms: 200, p95_ms: 350 }] };
    if (a.p_tool === "provision_app") return { data: { app, created: true, monitors: [{ id: mon, type: "http", name: "Website" }], heartbeats: [{ monitor: mon, name: "Backup", sealed: "sealed-heartbeat" }], slug: "website", skipped: [] } };
    if (a.p_tool === "create_monitor") return { data: { monitor: mon, first_check: a.p_payload.first_check } };
    if (a.p_tool === "pause") return { data: { monitors: [mon], paused_until: at } };
    return { data: { draft: "note", incident: inc, published: false, secret: "never-return-this" } };
  });
});

describe("the public tool contract", () => {
  function described(schema: Record<string, unknown>, path: string) {
    for (const [name, value] of Object.entries((schema.properties ?? {}) as Record<string, Record<string,unknown>>)) {
      expect(value.description, `${path}.${name}`).toBeTypeOf("string");
      expect(String(value.description).length, `${path}.${name}`).toBeGreaterThan(8);
      described(value, `${path}.${name}`);
    }
    if (schema.items) described(schema.items as Record<string,unknown>, path + "[]");
    for (const field of ["anyOf", "oneOf", "allOf"]) for (const s of (schema[field] ?? []) as Record<string,unknown>[]) described(s, path);
  }
  it("describes every argument recursively and publishes titles, output schemas and truthful annotations", () => {
    expect(MCP_TOOLS).toHaveLength(11);
    for (const tool of MCP_TOOLS) {
      expect(tool.title.length).toBeGreaterThan(4); expect(tool.description.length).toBeGreaterThan(80);
      described(tool.inputSchema, tool.name); expect(tool.outputSchema.type).toBe("object");
      expect(tool.annotations.readOnlyHint).toBe(!["provision_app", "create_monitor", "pause", "draft_incident_update"].includes(tool.name));
      expect(tool.annotations.destructiveHint).toBe(tool.name === "pause");
    }
  });
  it.each(toolNames)("validates the real %s handler result against its published schema", async name => {
    const result = await executeAgentTool(p, name, examples[name]);
    expect(outputs[name].safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/never-return-this|sealed-heartbeat|sealed-credential|DigitalOcean|tor1|sfo3|\?key=secret/);
    for (const c of calls.filter(c => c.table !== "agent_requests")) expect(c.q.eq).toHaveBeenCalledWith("workspace_id", workspace.id);
    if (name === "get_incidents") expect(result.incidents).toEqual([expect.objectContaining({ locations: ["Toronto, Canada", "San Francisco, US"], timeline: [{ at, text: "Opened" }] })]);
    if (name === "list_monitors") expect(result.monitors).toEqual([expect.objectContaining({ last_check: at, last_check_precision: "5m_window_start" })]);
    if (name === "draft_incident_update") expect(result).toMatchObject({ published: false, approval_url: `https://staygreen.test/app/incidents/${inc}` });
  });
  it("clamps Free history and translates requested cities to internal ids only at the query boundary", async () => {
    const r = await executeAgentTool(p, "get_response_times", { monitor: mon, window: "1y", location: "Toronto, Canada" });
    expect(r).toMatchObject({ window: "30d", resolution: "1h" });
    expect(mocks.rpc).toHaveBeenCalledWith("agent_response_times", expect.objectContaining({ p_days: 30, p_location: "tor1", p_workspace_id: workspace.id }));
  });
  it("returns the next monitor cursor and applies expired pauses before filtering", async () => {
    mocks.from.mockImplementation(() => agentQuery([monitor, { ...monitor, id: "mon_" + "b".repeat(24), paused_at: at, paused_until: "2000-01-01T00:00:00Z" }]));
    const r = await executeAgentTool(p, "list_monitors", { status: "up", limit: 1 });
    expect(r.next_cursor).toBe(mon); expect(r.monitors).toHaveLength(1);
  });
  it("admits scan_app per workspace credential without reading or saving workspace data", async () => {
    await executeAgentTool({ ...p, scope: "read" }, "scan_app", examples.scan_app);
    const first = mocks.rpc.mock.calls.find(c => c[0] === "admit_scan")![1].p_key;
    expect(first).toMatch(/^agent:[a-f0-9]{64}$/); expect(mocks.from).not.toHaveBeenCalled();
    mocks.rpc.mockClear();
    await executeAgentTool({ ...p, workspace: { id: "ws_other", clerk_org_id: "org_other" } }, "scan_app", examples.scan_app);
    expect(mocks.rpc.mock.calls.find(c => c[0] === "admit_scan")![1].p_key).not.toBe(first);
    mocks.rpc.mockResolvedValue({ data: 120 });
    await expect(executeAgentTool(p, "scan_app", examples.scan_app)).rejects.toMatchObject({ status: 429, retryAfter: 120 });
  });
  it.each(["create_monitor", "provision_app", "pause", "draft_incident_update"] as ToolName[])("rejects a read credential for %s before writes or network tests", async name => {
    await expect(executeAgentTool({ ...p, scope: "read" }, name, examples[name])).rejects.toMatchObject({ status: 403 });
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled(); expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each(["get_status", "get_uptime", "get_response_times", "pause", "draft_incident_update", "create_monitor"] as ToolName[])("conceals another workspace's id from %s", async name => {
    mocks.own.mockResolvedValue({ workspace: { id: "other", clerk_org_id: "org_other" } });
    const args = name === "get_status" ? { app } : name === "get_uptime" ? { monitor: mon } : examples[name];
    await expect(executeAgentTool(p, name, args)).rejects.toMatchObject({ status: 404 }); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("refuses private targets before tests and writes", async () => {
    mocks.check.mockResolvedValue({ ok: false });
    await expect(executeAgentTool(p, "create_monitor", examples.create_monitor)).rejects.toMatchObject({ code: "private_target" });
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("reports plan_limit without exposing database errors, including everything not created", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "heartbeat_limit" } });
    await expect(executeAgentTool(p, "provision_app", examples.provision_app)).rejects.toMatchObject({ code: "plan_limit", details: { not_created: ["app", "status page", "http", "heartbeat"] } });
  });
  it.each(["example.com", `${"preview-".repeat(6)}branch.preview.example.com`])("leaves default-name allocation to the transaction for %s, including another URL on that host", async host => {
    for (const [index, path] of ["", "/docs"].entries()) {
      await executeAgentTool(p, "provision_app", { request_id: index ? "658f56b4-56d0-4af0-80c3-b435ce2ab312" : request_id, url: `https://${host}${path}` });
      expect(mocks.rpc).toHaveBeenLastCalledWith("agent_write", expect.objectContaining({
        p_workspace_id: workspace.id, p_payload: expect.objectContaining({ url: `https://${host}${path}`, name: null, name_base: host }),
      }));
    }
  });
  it("preserves a caller's explicit name", async () => {
    await executeAgentTool(p, "provision_app", { request_id, url: "https://example.com", name: "My app" });
    expect(mocks.rpc).toHaveBeenLastCalledWith("agent_write", expect.objectContaining({ p_payload: expect.objectContaining({ name: "My app" }) }));
  });
  it.each([
    ["provision_app", "https"], ["create_monitor", "https"],
    ["provision_app", "http"], ["create_monitor", "http"],
  ] as const)("%s refuses an over-80-character %s hostname before budgets, network tests or writes", async (tool, scheme) => {
    const host = `${"a".repeat(61)}.preview.example.com`;
    expect(host).toHaveLength(81);
    for (const name of [undefined, "Explicit name"]) {
      const address = `${scheme}://${host}/docs`;
      const args = tool === "provision_app" ? { request_id, url: address, name } : { request_id, app, type: "http", target: address, name };
      await expect(executeAgentTool(p, tool, args)).rejects.toMatchObject({
        status: 400, code: "invalid_arguments", message: "Use a URL whose hostname is at most 80 characters.",
      });
    }
    expect(mocks.budget).not.toHaveBeenCalled(); expect(mocks.check).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["provision_app", "create_monitor"] as const)("%s accepts a hostname at the 80-character boundary", async tool => {
    const host = `${"a".repeat(60)}.preview.example.com`;
    expect(host).toHaveLength(80);
    const address = `https://${host}`;
    const args = tool === "provision_app" ? { request_id, url: address } : { request_id, app, type: "http", target: address };
    await executeAgentTool(p, tool, args);
    expect(mocks.rpc).toHaveBeenCalledWith("agent_write", expect.objectContaining({ p_tool: tool }));
  });
  it.each([
    { code: "23505", constraint: "apps_workspace_name_key", status: 409, publicCode: "name_conflict" },
    { code: "23514", constraint: "apps_name_check", status: 400, publicCode: "invalid_arguments" },
  ])("turns $constraint into the dashboard's refusal and allows a corrected request", async ({ code, constraint, status, publicCode }) => {
    const error = { code, message: `violates constraint "${constraint}"`, details: "Private database row" };
    mocks.rpc.mockResolvedValueOnce({ error });
    await expect(executeAgentTool(p, "provision_app", { request_id, url: "https://example.com", name: "Taken" })).rejects.toMatchObject({
      status, code: publicCode, message: describeDbError(error, { entitlements: FREE }),
    });
    // A refusal committed no receipt; corrected inputs can now create the app.
    await expect(executeAgentTool(p, "provision_app", { request_id, url: "https://example.com", name: "Available" })).resolves.toMatchObject({ created: true });
  });
  it.each(["23505", "23514", "22023", "P0001", "42883"])("does not tell an agent to replay permanent database failure %s", async code => {
    mocks.rpc.mockResolvedValue({ error: { code, message: "Private database detail" } });
    const failure = await executeAgentTool(p, "provision_app", examples.provision_app).catch(e => e);
    expect(failure).toBeInstanceOf(AgentError);
    expect(failure.status).not.toBe(503);
    expect(failure.message).not.toMatch(/Retry|Private database detail/);
  });
  it.each(["", "08006", "40001", "40P01", "53300", "57014", "57P01", "PGRST003"])("keeps safe replay guidance for transient database failure %s", async code => {
    mocks.rpc.mockResolvedValueOnce({ error: { code, message: "Private database detail" } });
    await expect(executeAgentTool(p, "provision_app", examples.provision_app)).rejects.toMatchObject({
      status: 503, message: "The operation could not be completed. Retry with the same request_id.",
    });
    await expect(executeAgentTool(p, "provision_app", examples.provision_app)).resolves.toMatchObject({ created: true });
  });
  it("replays the actor's receipt without new network calls; a changed request conflicts", async () => {
    await executeAgentTool(p, "pause", examples.pause);
    const args = mocks.rpc.mock.calls[0][1];
    mocks.from.mockReturnValue(agentQuery({ tool: "pause", input_hash: args.p_input_hash, result: { monitors: [mon], paused_until: at } }));
    mocks.rpc.mockClear();
    expect(await executeAgentTool(p, "pause", examples.pause)).toMatchObject({ paused_until: at });
    await expect(executeAgentTool(p, "pause", { request_id, monitor: mon, minutes: 11 })).rejects.toMatchObject({ status: 409 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects unknown fields and never allows publication or cross-type configuration", async () => {
    for (const extra of [{ publish: true }, { note_id: "existing" }, { workspace_id: "other" }]) await expect(executeAgentTool(p, "draft_incident_update", { ...(examples.draft_incident_update as object), ...extra })).rejects.toThrow();
    await expect(executeAgentTool(p, "pause", { request_id, monitor: mon, minutes: 1441 })).rejects.toThrow();
    expect(() => agentMonitorRow({ request_id, app, type: "http", target: "https://example.com", config: { key: "secret" } })).toThrow(AgentError);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("normalizes app URLs and never shows saved heartbeat URLs or legacy query credentials", () => {
    expect(normalizeAppUrl("https://EXAMPLE.com:443/")).toBe("https://example.com");
    expect(() => normalizeAppUrl("https://user:secret@example.com")).toThrow();
    expect(safeTarget("heartbeat", "https://in.test/secret")).toBe("Scheduled job");
    expect(safeTarget("http", "https://user:secret@example.com/path?key=secret#secret")).toBe("https://example.com/path");
  });
});
