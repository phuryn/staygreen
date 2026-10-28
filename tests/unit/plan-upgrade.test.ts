import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { entitlementsFrom, demoSlug, FREE, limits } from "@/lib/plans";

type RecordRow = Record<string, unknown>;
const state = vi.hoisted(() => ({
  rows: {} as Record<string, RecordRow[]>, entitlements: vi.fn(), simulation: vi.fn(),
  writes: [] as string[], failType: null as string | null, failPlan: false,
}));
vi.mock("@/lib/session", () => ({
  currentCaller: async () => ({ userId: "user_a", orgId: "org_a", orgRole: "org:admin" }),
  currentEntitlements: state.entitlements, devPlanSimulation: state.simulation,
}));
vi.mock("@/lib/env", () => ({ env: () => ({ API_TOKEN_PEPPER: "p".repeat(43) }) }));
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: vi.fn(), verifyToken: vi.fn() }));
vi.mock("@/lib/api-entitlements", () => ({ apiEntitlements: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => ({
  rpc: async () => ({ data: { ...state.rows.workspaces[0] }, error: null }),
  from: (table: string) => {
    const filters: ((row: RecordRow) => boolean)[] = [];
    let changes: RecordRow | null = null;
    const q = {
      update(value: RecordRow) { changes = value; return q; },
      eq(key: string, value: unknown) { filters.push(row => row[key] === value); return q; },
      in(key: string, values: unknown[]) { filters.push(row => values.includes(row[key])); return q; },
      then(resolve: (value: unknown) => unknown) {
        const matching = state.rows[table].filter(row => filters.every(f => f(row)));
        if (changes) {
          state.writes.push(table);
          if ((table === "monitors" && matching.some(row => row.type === state.failType)) || (table === "workspaces" && state.failPlan))
            return Promise.resolve({ error: { code: "temporary_failure" } }).then(resolve);
          for (const row of matching) Object.assign(row, changes);
        }
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return q;
  },
}) }));

import { getMember } from "@/lib/workspace";
import { requireAgent } from "@/lib/agent-auth";

const promoted = [["http", "httpIntervalMin"], ["tcp", "httpIntervalMin"], ["supabase", "httpIntervalMin"]] as const;
// Plan-timed but kept: moving them would rewrite their past uptime (`workspace-plan.ts`).
const kept = [["stripe", "stripePollMin"], ["mcp", "mcpIntervalMin"]] as const;
const intervals = [...promoted, ...kept] as const;
const builder = entitlementsFrom(slug => slug !== demoSlug);
const snapshot = () => structuredClone(state.rows.monitors);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SELF_HOSTED_PLAN", undefined);
  state.entitlements.mockResolvedValue(builder);
  state.simulation.mockResolvedValue(null);
  state.failType = null; state.failPlan = false; state.writes = [];
  state.rows = {
    workspaces: [{ id: "ws_a", clerk_org_id: "org_a", plan: "free" }, { id: "ws_b", clerk_org_id: "org_b", plan: "free" }],
    monitors: [
      ...intervals.flatMap(([type, key]) => [
        { id: type, workspace_id: "ws_a", type, interval_sec: limits.free[key] * 60, state: "up", updated_at: "unchanged" },
        { id: `${type}-custom`, workspace_id: "ws_a", type, interval_sec: limits.free[key] * 60 + 60 },
        { id: `${type}-builder`, workspace_id: "ws_a", type, interval_sec: limits.builder[key] * 60 },
        { id: `${type}-foreign`, workspace_id: "ws_b", type, interval_sec: limits.free[key] * 60 },
      ]),
      // Equal numbers do not make these plan-based: DNS and SSL are fixed, heartbeats use cron.
      ...["dns", "ssl", "heartbeat"].map(type => ({ id: type, workspace_id: "ws_a", type, interval_sec: limits.free.httpIntervalMin * 60 })),
    ],
  };
});
afterEach(() => vi.unstubAllEnvs());

const run = async (path: string) => {
  if (path !== "hosted member") vi.stubEnv("SELF_HOSTED_PLAN", "builder");
  if (path !== "self-hosted MCP") return getMember();
  return requireAgent(new Request("https://example.test/mcp", { headers: { authorization: "Bearer fixture" } }), true, undefined, {
    verify: vi.fn().mockResolvedValue({ userId: "user_a", orgId: "org_a", clientId: "client_a", scopes: ["user:org:read"] }),
    membershipRole: vi.fn().mockResolvedValue("org:admin"), clientName: vi.fn().mockResolvedValue("Example agent"),
    budget: vi.fn(), entitlements: state.entitlements,
  });
};

describe.each(["hosted member", "self-hosted member", "self-hosted MCP"])("Builder interval upgrade through %s", path => {
  it("promotes only this workspace's Free defaults and preserves all other monitor fields and intervals", async () => {
    const expected = snapshot();
    for (const [type, key] of promoted) expected.find(row => row.id === type)!.interval_sec = limits.builder[key] * 60;
    await run(path);
    expect(state.rows.monitors).toEqual(expected);
    for (const [type, key] of kept) expect(state.rows.monitors.find(row => row.id === type)?.interval_sec).toBe(limits.free[key] * 60);
    expect(state.rows.workspaces.map(row => row.plan)).toEqual(["builder", "free"]);
    expect(state.writes.at(-1)).toBe("workspaces");
  });

  it("does not repeat an upgrade once the stored plan is Builder", async () => {
    state.rows.workspaces[0].plan = "builder";
    const before = snapshot();
    await run(path);
    expect(state.rows.monitors).toEqual(before);
    expect(state.writes).toEqual([]);
  });

  it("leaves the transition retryable if an interval write fails", async () => {
    state.failType = "supabase";
    await run(path);
    expect(state.rows.workspaces[0].plan).toBe("free");
    expect(state.writes).not.toContain("workspaces");
    state.failType = null;
    await run(path);
    expect(state.rows.workspaces[0].plan).toBe("builder");
    for (const [type, key] of promoted)
      expect(state.rows.monitors.find(row => row.id === type)?.interval_sec).toBe(limits.builder[key] * 60);
  });
});

it("keeps Builder intervals when the member's stored plan moves back to Free", async () => {
  state.rows.workspaces[0].plan = "builder";
  for (const [type, key] of intervals) state.rows.monitors.find(row => row.id === type)!.interval_sec = limits.builder[key] * 60;
  const before = snapshot();
  state.entitlements.mockResolvedValue(FREE);
  await getMember();
  expect(state.rows.workspaces[0].plan).toBe("free");
  expect(state.rows.monitors).toEqual(before);
  expect(state.writes).toEqual(["workspaces"]);
});

it("retries safely when the interval updates succeed but storing Builder fails", async () => {
  state.failPlan = true;
  await getMember();
  expect(state.rows.workspaces[0].plan).toBe("free");
  const promoted = snapshot();
  state.failPlan = false;
  await getMember();
  expect(state.rows.workspaces[0].plan).toBe("builder");
  expect(state.rows.monitors).toEqual(promoted);
});

it("does not update intervals for a simulated or unread plan", async () => {
  const before = snapshot();
  state.simulation.mockResolvedValue({ builder: true });
  await getMember();
  state.simulation.mockResolvedValue(null);
  state.entitlements.mockResolvedValue({ ...builder, unread: true });
  await getMember();
  expect(state.rows.monitors).toEqual(before);
  expect(state.rows.workspaces[0].plan).toBe("free");
  expect(state.writes).toEqual([]);
});
