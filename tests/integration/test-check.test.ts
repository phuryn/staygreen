import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Caller } from "@/lib/authz";
import { TEST_BUDGET } from "@/lib/budgets";
import { FREE } from "@/lib/plans";
import type { TestOutcome } from "@/lib/test-result";
import { checkViolation, clientFor, describeTarget, expectOk, expectRefused, Fixtures, hex, LIMITS_REQUIRED, NOT_FOUND, readTarget, testUserId } from "../support/integration";

/* Testing a monitor before saving it (`docs/flows.md § Testing a monitor`), on the real
   database: the budget `spend_budget` counts (migration 011), and `testMonitor` with everything
   real but the check itself. The check is `runTest`, replaced here by a fake that records what
   it was handed, so nothing reaches past this machine; `tests/unit/monitor-test.test.ts` runs the
   real one against local servers.

   Faked as in `actions.test.ts`: the caller (the verifier), the request headers a same-origin
   browser sends (`next/headers`), and DNS for a monitor's host (`setResolver`). */

const fake = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/monitor-test", async (original) => ({ ...(await original<typeof import("@/lib/monitor-test")>()), runTest: fake.run }));
vi.mock("next/headers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/headers")>();
  return { ...actual, headers: async () => new Headers({ "sec-fetch-site": "same-origin", host: "localhost" }) };
});

const target = readTarget();

const NOT_HERE = { ok: false, reason: "That isn't here any more. Reload the page." };
const KEPT = `Bearer itest-kept-${hex(8)}`;

describeTarget("testMonitor and its budget: counted in Postgres, one use per test, nothing else written", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);
  let actions: typeof import("@/app/(app)/app/actions");
  let caller: Caller | null = null;
  let A: { id: string; clerk_org_id: string }, B: { id: string; clerk_org_id: string };
  let callerA: Caller, callerB: Caller;
  let appA = "";
  let monA = "";
  const hostA = `itest-${hex(4)}.example.com`;
  let appB = "";
  let monB = "";

  const as = async <T>(who: Caller, run: () => Promise<T>): Promise<T> => {
    caller = who;
    try {
      return await run();
    } finally {
      caller = null;
    }
  };
  const spend = (workspaceId: string, userId: string, member = 2, workspace = 3, memberWindow = 600, workspaceWindow = 3600) =>
    db.rpc("spend_budget", {
      p_workspace_id: workspaceId,
      p_action: "test_check",
      p_user_id: userId,
      p_member_limit: member,
      p_member_window_sec: memberWindow,
      p_workspace_limit: workspace,
      p_workspace_window_sec: workspaceWindow,
    });
  const budgets = async (workspaceId: string) =>
    (await db.from("budgets").select("actor, used").eq("workspace_id", workspaceId).order("actor")).data!;
  const httpDraft = (appId: string, host: string, headers: { name: string; value: string }[] = []) => ({
    type: "http",
    appId,
    name: "",
    url: `https://${host}/health`,
    method: "GET",
    expect: "2xx",
    keyword: "",
    slowMs: 1500,
    assertions: [],
    headers,
  });
  const passed: TestOutcome = { ok: true, ms: 9, at: 0, timeoutSec: 15, type: "tcp", tcp: { host: "x", port: 1, tls: false } };

  beforeAll(async () => {
    const session = await import("@/lib/session");
    const targets = await import("@/lib/targets");
    actions = await import("@/app/(app)/app/actions");
    session.setSessionVerifier({ current: async () => caller, entitlements: async () => FREE });
    targets.setResolver(async () => ["93.184.216.34"]);
    fake.run.mockResolvedValue(passed);

    A = await fx.workspace();
    B = await fx.workspace();
    callerA = { userId: testUserId(), orgId: A.clerk_org_id, orgRole: "org:admin" };
    callerB = { userId: testUserId(), orgId: B.clerk_org_id, orgRole: "org:admin" };
    await as(callerA, async () => {
      const app = await actions.addApp({ name: `itest A test ${hex(3)}`, url: "" });
      if (!app.ok) throw new Error(app.reason);
      appA = app.id;
      const mon = await actions.addMonitor(httpDraft(appA, hostA, [{ name: "Authorization", value: KEPT }]));
      if (!mon.ok) throw new Error(mon.reason);
      monA = mon.id;
    });
    await as(callerB, async () => {
      const app = await actions.addApp({ name: `itest B test ${hex(3)}`, url: "" });
      if (!app.ok) throw new Error(app.reason);
      appB = app.id;
      const mon = await actions.addMonitor(httpDraft(appB, `itest-${hex(4)}.example.com`, [{ name: "Authorization", value: "Bearer b" }]));
      if (!mon.ok) throw new Error(mon.reason);
      monB = mon.id;
    });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("spend_budget counts the member and the workspace, and refuses at either limit with when it opens again", async () => {
    const ws = await fx.workspace();
    const [u1, u2] = [testUserId(), testUserId()];
    expect(expectOk(await spend(ws.id, u1))).toEqual({ ok: true });
    expect(expectOk(await spend(ws.id, u1))).toEqual({ ok: true });
    const member = expectOk(await spend(ws.id, u1)) as { ok: boolean; scope: string; retryAfterSec: number };
    expect(member).toMatchObject({ ok: false, scope: "member" });
    expect(member.retryAfterSec).toBeGreaterThan(590);
    expect(member.retryAfterSec).toBeLessThanOrEqual(600);
    expect(expectOk(await spend(ws.id, u2))).toEqual({ ok: true });
    const shared = expectOk(await spend(ws.id, u2)) as { ok: boolean; scope: string; retryAfterSec: number };
    expect(shared).toMatchObject({ ok: false, scope: "workspace" });
    expect(shared.retryAfterSec).toBeGreaterThan(3590);
    // A refusal spends nothing.
    expect(await budgets(ws.id)).toEqual([
      { actor: u1, used: 2 },
      { actor: u2, used: 1 },
      { actor: "workspace", used: 3 },
    ].sort((x, y) => x.actor.localeCompare(y.actor)));
  });

  it("spend_budget starts a window again once it has passed, and not before", async () => {
    const ws = await fx.workspace();
    const u = testUserId();
    await spend(ws.id, u, 1, 10);
    expect(expectOk(await spend(ws.id, u, 1, 10))).toMatchObject({ ok: false, scope: "member" });
    // Well past the 600 s window: this machine's clock and the database's needn't agree to the second.
    await db.from("budgets").update({ window_started_at: new Date(Date.now() - 700_000).toISOString() }).eq("workspace_id", ws.id).eq("actor", u);
    expect(expectOk(await spend(ws.id, u, 1, 10))).toEqual({ ok: true });
    expect(await budgets(ws.id)).toEqual([{ actor: u, used: 1 }, { actor: "workspace", used: 2 }].sort((x, y) => x.actor.localeCompare(y.actor)));
  });

  it("spend_budget refuses a missing limit, a missing workspace, another action and an actor that isn't a member", async () => {
    const ws = await fx.workspace();
    const u = testUserId();
    expectRefused(await db.rpc("spend_budget", { p_workspace_id: ws.id, p_action: "test_check", p_user_id: u, p_member_limit: null as never, p_member_window_sec: 600, p_workspace_limit: 3, p_workspace_window_sec: 3600 }), LIMITS_REQUIRED);
    expectRefused(await spend(ws.id, u, 2, 3, 0), LIMITS_REQUIRED);
    expectRefused(await spend(`ws_${hex(12)}`, u), NOT_FOUND);
    expectRefused(await db.rpc("spend_budget", { p_workspace_id: ws.id, p_action: "proxy", p_user_id: u, p_member_limit: 2, p_member_window_sec: 600, p_workspace_limit: 3, p_workspace_window_sec: 3600 }), checkViolation("budgets", "budgets_action_check"));
    expectRefused(await spend(ws.id, "workspace"), { status: 400, code: "22023", message: "invalid_actor" });
    expect(await budgets(ws.id)).toEqual([]);
  });

  it("spend_budget gives the last allowed use to exactly one caller under a race", async () => {
    const ws = await fx.workspace();
    const users = [testUserId(), testUserId(), testUserId()];
    const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => spend(ws.id, users[i % 3], 100, 10)));
    const oks = answers.map((r) => expectOk(r) as { ok: boolean }).filter((r) => r.ok);
    expect(oks).toHaveLength(10);
    const rows = await budgets(ws.id);
    expect(rows.find((r) => r.actor === "workspace")).toEqual({ actor: "workspace", used: 10 });
    expect(rows.filter((r) => r.actor !== "workspace").reduce((n, r) => n + r.used, 0)).toBe(10);
  });

  it("testMonitor opens a kept header for its own monitor, never returns it, and writes one use and nothing else", async () => {
    const monitor = async () => (await db.from("monitors").select("*").eq("id", monA).single()).data;
    const secrets = async () => (await db.from("monitor_secrets").select("*").eq("monitor_id", monA)).data;
    const incidents = async () => (await db.from("incidents").select("id").eq("workspace_id", A.id)).data;
    const [before, sealedBefore] = [await monitor(), await secrets()];
    fake.run.mockClear();

    // The monitor's own address, the only place a kept value is sent.
    const draft = httpDraft(appA, hostA, [{ name: "Authorization", value: "" }]);
    const result = await as(callerA, () => actions.testMonitor(draft, monA));
    expect(result).toEqual({ ok: true, outcome: passed });
    expect(JSON.stringify(result)).not.toContain(KEPT);
    expect(fake.run).toHaveBeenCalledTimes(1);
    const [row, headers] = fake.run.mock.calls[0];
    expect(row).toMatchObject({ type: "http", target: draft.url });
    expect(headers).toEqual({ Authorization: KEPT });

    expect(await monitor()).toEqual(before);
    expect(await secrets()).toEqual(sealedBefore);
    expect(await incidents()).toEqual([]);
    expect(await budgets(A.id)).toEqual([{ actor: callerA.userId, used: 1 }, { actor: "workspace", used: 1 }].sort((x, y) => x.actor.localeCompare(y.actor)));
  });

  it("testMonitor refuses B's monitor and B's app to A, and neither budget moves", async () => {
    fake.run.mockClear();
    const before = await budgets(A.id);
    expect(await as(callerA, () => actions.testMonitor(httpDraft(appA, "x.example.com", [{ name: "Authorization", value: "" }]), monB))).toEqual(NOT_HERE);
    expect(await as(callerA, () => actions.testMonitor(httpDraft(appB, "x.example.com")))).toMatchObject({ ok: false, fieldErrors: { appId: "Pick the app this monitor belongs to" } });
    expect(fake.run).not.toHaveBeenCalled();
    expect(await budgets(B.id)).toEqual([]);
    expect(await budgets(A.id)).toEqual(before);
  });

  it("testMonitor refuses a spent workspace budget with when it can run again, and runs nothing", async () => {
    fake.run.mockClear();
    await db.from("budgets").update({ used: TEST_BUDGET.workspace.limit }).eq("workspace_id", A.id).eq("actor", "workspace");
    const result = await as(callerA, () => actions.testMonitor(httpDraft(appA, `itest-${hex(4)}.example.com`)));
    expect(result).toMatchObject({ ok: false, reason: "This workspace has run 100 tests in an hour, which is as many as a workspace can." });
    expect(result.ok ? 0 : result.retryAfterSec).toBeGreaterThan(3500);
    expect(fake.run).not.toHaveBeenCalled();
  });
});
