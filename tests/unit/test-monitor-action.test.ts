import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_BUDGET } from "@/lib/budgets";
import { FREE } from "@/lib/plans";
import { headerContext, seal } from "@/lib/seal";
import { TEST_DEADLINE_MS } from "@/lib/monitor-test";
import type { TestOutcome } from "@/lib/test-result";
import { addMonitor, testMonitor, updateMonitor } from "@/app/(app)/app/actions";

/* `testMonitor` (`docs/flows.md § Testing a monitor`): the real action, permission check, parser
   and sealing; a fake identity, database and runner. The runner itself is
   `monitor-test.test.ts`, against servers on this machine; integration/test-check.test.ts runs
   this action and the budget on the development database. The key is a throwaway made here;
   `CREDENTIALS_KEY` and `.env` are never read. */

const fake = vi.hoisted(() => ({
  member: vi.fn(),
  monitor: vi.fn(),
  app: vi.fn(),
  origin: vi.fn(),
  stored: vi.fn(),
  secrets: vi.fn(),
  rpc: vi.fn(),
  run: vi.fn(),
  key: "",
}));
vi.mock("@/lib/workspace", async (original) => ({
  ...(await original<typeof import("@/lib/workspace")>()),
  memberOrNull: fake.member,
  resolveMonitor: fake.monitor,
  resolveApp: fake.app,
}));
vi.mock("@/lib/request", async (original) => ({ ...(await original<typeof import("@/lib/request")>()), assertSameOrigin: fake.origin }));
vi.mock("@/lib/env", async (original) => ({ ...(await original<typeof import("@/lib/env")>()), env: () => ({ CREDENTIALS_KEY: fake.key }) }));
vi.mock("@/lib/monitor-test", async (original) => ({ ...(await original<typeof import("@/lib/monitor-test")>()), runTest: fake.run }));
vi.mock("@/lib/db", () => ({
  db: () => ({
    from: (table: string) =>
      table === "monitors"
        ? { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: fake.stored }) }) }) }
        : { select: () => ({ eq: () => ({ eq: fake.secrets }) }) },
    rpc: fake.rpc,
  }),
}));

const KEY = randomBytes(32);
const MON = `mon_${"a".repeat(24)}`;
const OTHER_MON = `mon_${"b".repeat(24)}`;
const APP = `app_${"c".repeat(24)}`;
const KEPT = "Bearer kept-value-never-returned";

const ws = { id: "ws_a", clerk_org_id: "org_a" };
const wsB = { id: "ws_b", clerk_org_id: "org_b" };
const admin = { caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" }, workspace: ws, entitlements: FREE };
const NOT_FOUND = { ok: false, reason: "That isn't here any more. Reload the page." };

const draft = (over: Record<string, unknown> = {}) => ({
  type: "http",
  appId: APP,
  name: "",
  url: "https://api.example.com/health",
  method: "GET",
  expect: "2xx",
  keyword: "",
  slowMs: 1500,
  assertions: [],
  headers: [],
  ...over,
});
const passed: TestOutcome = { ok: true, ms: 12, at: 0, timeoutSec: 15, type: "tcp", tcp: { host: "x", port: 1, tls: false } };

const serviceDraft = () => ({ type: "supabase", appId: APP, name: "Project", projectUrl: "https://abcdefghijklmnopqrst.supabase.co", databaseRead: "", key: "sb_publishable_abcdefghijklmnop" });
const servicePass: TestOutcome = { ok: true, ms: 1, at: 0, timeoutSec: 20, type: "supabase", service: { saveable: true, summary: "ok", steps: [] } };

beforeEach(() => {
  vi.clearAllMocks();
  fake.key = KEY.toString("base64url");
  fake.origin.mockResolvedValue(undefined);
  fake.member.mockResolvedValue(admin);
  fake.monitor.mockResolvedValue({ id: MON, workspace: ws });
  fake.app.mockResolvedValue({ id: APP, workspace: ws });
  fake.stored.mockResolvedValue({ data: { type: "http", app_id: APP, auto: false, target: "https://api.example.com/health" }, error: null });
  fake.secrets.mockResolvedValue({ data: [{ name: "Authorization", sealed: seal(KEPT, headerContext(MON, "Authorization"), KEY) }], error: null });
  fake.rpc.mockResolvedValue({ data: { ok: true }, error: null });
  fake.run.mockResolvedValue(passed);
});

describe("testMonitor", () => {
  it("preflights a service on direct save, spends its budget, seals the key and passes explicit quotas", async () => {
    fake.run.mockResolvedValue(servicePass);
    const result = await addMonitor(serviceDraft());
    expect(result.ok).toBe(true);
    expect(fake.run).toHaveBeenCalledTimes(1);
    const [, args] = fake.rpc.mock.calls.find(([name]) => name === "save_service_monitor")!;
    expect(args).toMatchObject({ p_type: "supabase", p_max_monitors: 50, p_max_type: 1, p_per_host: 5, p_interval_sec: 180, p_edit: false });
    expect(args.p_sealed).toMatch(/^v1\./);
    expect(JSON.stringify(args)).not.toContain(serviceDraft().key);
    expect(JSON.stringify(result)).not.toContain(serviceDraft().key);
  });
  it("refuses a failed service save even when a caller skips the form", async () => {
    fake.run.mockResolvedValue({ ...servicePass, ok: false, service: { ...servicePass.service, saveable: false } });
    expect((await addMonitor(serviceDraft())).ok).toBe(false);
    expect(fake.rpc.mock.calls.map(([name]) => name)).toEqual(["spend_budget"]);
  });
  it("does not test, spend, read or save a service belonging to another workspace", async () => {
    fake.monitor.mockResolvedValue({ id: MON, workspace: wsB });
    expect(await updateMonitor(MON, serviceDraft())).toEqual(NOT_FOUND);
    expect(await testMonitor(serviceDraft(), MON)).toEqual(NOT_FOUND);
    fake.app.mockResolvedValue({ id: APP, workspace: wsB });
    expect((await addMonitor(serviceDraft())).ok).toBe(false);
    expect(fake.run).not.toHaveBeenCalled(); expect(fake.rpc).not.toHaveBeenCalled(); expect(fake.secrets).not.toHaveBeenCalled();
  });
  it("keeps a service key only for its saved project and revalidates it on edit", async () => {
    const d = serviceDraft();
    fake.stored.mockResolvedValue({ data: { type: "supabase", app_id: APP, auto: false, target: d.projectUrl }, error: null });
    fake.secrets.mockResolvedValue({ data: [{ name: "service-key", sealed: seal(d.key, headerContext(MON, "service-key"), KEY) }], error: null });
    fake.run.mockResolvedValue(servicePass);
    expect((await updateMonitor(MON, { ...d, key: "" })).ok).toBe(true);
    expect(fake.run.mock.calls[0][1]).toEqual({ "service-key": d.key });
    fake.rpc.mockClear(); fake.run.mockClear();
    for (const action of [() => updateMonitor(MON, { ...d, key: "", projectUrl: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" }),
      () => testMonitor({ ...d, key: "", projectUrl: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" }, MON)]) {
      expect(await action()).toMatchObject({ ok: false, fieldErrors: { key: expect.any(String) } });
    }
    expect(fake.run).not.toHaveBeenCalled(); expect(fake.rpc).not.toHaveBeenCalled();
  });
  it("runs the check once with what the form holds, and spends one use of both budgets", async () => {
    expect(await testMonitor(draft({ headers: [{ name: "X-Key", value: "typed" }] }))).toEqual({ ok: true, outcome: passed });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.rpc).toHaveBeenCalledWith("spend_budget", {
      p_workspace_id: "ws_a",
      p_action: "test_check",
      p_user_id: "user_a",
      p_member_limit: TEST_BUDGET.member.limit,
      p_member_window_sec: TEST_BUDGET.member.windowSec,
      p_workspace_limit: TEST_BUDGET.workspace.limit,
      p_workspace_window_sec: TEST_BUDGET.workspace.windowSec,
    });
    const [row, headers, withinMs] = fake.run.mock.calls[0];
    expect(row).toMatchObject({ type: "http", target: "https://api.example.com/health", appId: APP });
    expect(headers).toEqual({ "X-Key": "typed" });
    // What the reads took comes out of the deadline; the runner never gets more.
    expect(withinMs).toBeGreaterThan(TEST_DEADLINE_MS - 2_000);
    expect(withinMs).toBeLessThanOrEqual(TEST_DEADLINE_MS);
  });

  it("opens a kept header for its own monitor, hands it to the check, and never returns it", async () => {
    const result = await testMonitor(draft({ headers: [{ name: "Authorization", value: "" }] }), MON);
    expect(result).toEqual({ ok: true, outcome: passed });
    expect(fake.run.mock.calls[0][1]).toEqual({ Authorization: KEPT });
    expect(JSON.stringify(result)).not.toContain(KEPT);
    expect(JSON.stringify(result)).not.toContain("kept-value");
  });

  it("refuses a kept header sealed for another monitor, before anything is spent", async () => {
    fake.secrets.mockResolvedValue({ data: [{ name: "Authorization", sealed: seal(KEPT, headerContext(OTHER_MON, "Authorization"), KEY) }], error: null });
    const result = await testMonitor(draft({ headers: [{ name: "Authorization", value: "" }] }), MON);
    const reason = "The stored value of Authorization can't be read. Type it again to test with it.";
    expect(result).toEqual({ ok: false, reason, fieldErrors: { headers: reason } });
    expect(JSON.stringify(result)).not.toContain(KEPT);
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("sends a kept header only to the address it was saved for, and asks for it again elsewhere", async () => {
    const reason = "Type Authorization again: a kept value is only sent to the address it was saved for.";
    for (const url of ["https://collect.example.net/health", "http://api.example.com/health", "https://api.example.com:8443/health", "https://api.example.com/v2/status", "https://api.example.com/health?echo=1"]) {
      const result = await testMonitor(draft({ url, headers: [{ name: "Authorization", value: "" }] }), MON);
      expect(result).toEqual({ ok: false, reason, fieldErrors: { headers: reason } });
    }
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
    // Its own address keeps it; so does a new one with the value typed again.
    expect((await testMonitor(draft({ url: "https://api.example.com/health", headers: [{ name: "Authorization", value: "" }] }), MON)).ok).toBe(true);
    expect(fake.run.mock.calls[0][1]).toEqual({ Authorization: KEPT });
    expect((await testMonitor(draft({ url: "https://collect.example.net/health", headers: [{ name: "Authorization", value: "typed" }] }), MON)).ok).toBe(true);
    expect(fake.run.mock.calls[1][1]).toEqual({ Authorization: "typed" });
  });

  it("refuses an empty header on the add screen, where nothing is stored", async () => {
    const result = await testMonitor(draft({ headers: [{ name: "Authorization", value: "" }] }));
    expect(result).toMatchObject({ ok: false, fieldErrors: { headers: expect.any(String) } });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("tests an edited monitor as its own type and app, whatever the draft says", async () => {
    await testMonitor(draft({ appId: `app_${"d".repeat(24)}`, type: "heartbeat" }), MON);
    expect(fake.run.mock.calls[0][0]).toMatchObject({ type: "http", appId: APP });
  });

  it("refuses another workspace's monitor as not found, reading and spending nothing", async () => {
    fake.monitor.mockResolvedValue({ id: MON, workspace: wsB });
    expect(await testMonitor(draft({ headers: [{ name: "Authorization", value: "" }] }), MON)).toEqual(NOT_FOUND);
    fake.monitor.mockResolvedValue(null);
    expect(await testMonitor(draft(), MON)).toEqual(NOT_FOUND);
    expect(fake.stored).not.toHaveBeenCalled();
    expect(fake.secrets).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("refuses another workspace's app on the add screen", async () => {
    fake.app.mockResolvedValue({ id: APP, workspace: wsB });
    expect(await testMonitor(draft())).toMatchObject({ ok: false, fieldErrors: { appId: "Pick the app this monitor belongs to" } });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("refuses a member without monitors:write, adding and editing", async () => {
    fake.member.mockResolvedValue({ ...admin, caller: { ...admin.caller, orgRole: "org:member" } });
    expect(await testMonitor(draft())).toEqual(NOT_FOUND);
    expect(await testMonitor(draft({ headers: [{ name: "Authorization", value: "" }] }), MON)).toEqual(NOT_FOUND);
    expect(fake.secrets).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it.each([
    ["member", "You've run 20 tests in 10 minutes, which is as many as one person can.", 312],
    ["workspace", "This workspace has run 100 tests in an hour, which is as many as a workspace can.", 2400],
  ])("refuses a spent %s budget with when it can run again, and runs nothing", async (scope, reason, retryAfterSec) => {
    fake.rpc.mockResolvedValue({ data: { ok: false, scope, retryAfterSec }, error: null });
    expect(await testMonitor(draft())).toEqual({ ok: false, reason, retryAfterSec });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("refuses an address the parser knows is private, before anything is spent", async () => {
    expect(await testMonitor(draft({ url: "http://127.0.0.1:5432/" }))).toMatchObject({ ok: false, fieldErrors: { url: expect.stringContaining("private address") } });
    expect(await testMonitor({ type: "tcp", appId: APP, name: "", host: "10.0.0.4", port: 22, tls: false })).toMatchObject({ ok: false, fieldErrors: { host: expect.stringContaining("private address") } });
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("refuses a heartbeat, which has nothing to test", async () => {
    const result = await testMonitor({ type: "heartbeat", appId: APP, name: "cron", schedule: "0 6 * * *", tz: "UTC", graceMin: 10, maxRunMin: 15, assertions: [] });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("A heartbeat has nothing to test") });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("refuses an automatic monitor, as saving it would", async () => {
    fake.stored.mockResolvedValue({ data: { type: "ssl", app_id: APP, auto: true }, error: null });
    expect(await testMonitor({ type: "ssl", appId: APP, name: "", host: "api.example.com" }, MON)).toMatchObject({ ok: false });
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("requires a session and a same-origin request", async () => {
    fake.member.mockResolvedValue(null);
    expect(await testMonitor(draft())).toEqual({ ok: false, reason: "Your session has ended. Sign in again to keep going." });
    const { CrossOrigin } = await import("@/lib/request");
    fake.origin.mockRejectedValue(new CrossOrigin());
    expect(await testMonitor(draft())).toEqual({ ok: false, reason: "This request didn't come from Staygreen, so it was refused." });
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("returns a budget the database couldn't count as a refusal, not a test", async () => {
    fake.rpc.mockResolvedValue({ data: null, error: { code: "PT404", message: "not_found" } });
    expect(await testMonitor(draft())).toEqual(NOT_FOUND);
    expect(fake.run).not.toHaveBeenCalled();
  });
});
