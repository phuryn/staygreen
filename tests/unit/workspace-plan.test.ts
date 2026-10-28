import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMember } from "@/lib/workspace";
import { agentQuery } from "../support/agent-db";

/* The plan the probes route Builder monitors by (migration 20261024090000): the dashboard writes
   the verified session's plan onto the workspace row when the row disagrees, and never a simulated
   one. The session and the database are faked. */

const fake = vi.hoisted(() => ({ entitlements: vi.fn(), simulation: vi.fn(), rpc: vi.fn(), update: vi.fn(), eq: vi.fn() }));
vi.mock("@/lib/session", () => ({
  currentCaller: async () => ({ userId: "user_1", orgId: "org_A", orgRole: "org:admin" }),
  currentEntitlements: fake.entitlements,
  devPlanSimulation: fake.simulation,
}));
vi.mock("@/lib/db", () => ({ db: () => ({ rpc: fake.rpc, from: (table: string) => {
  const q = agentQuery(null);
  q.update = (value: unknown) => { fake.update(table, value); return q; };
  q.eq = (key: string, value: unknown) => { fake.eq(key, value); return q; };
  return q;
} }) }));

const row = (plan: string) => ({ data: { id: "ws_a", clerk_org_id: "org_A", plan }, error: null });

beforeEach(() => {
  vi.clearAllMocks();
  fake.simulation.mockResolvedValue(null);
  fake.eq.mockResolvedValue({ error: null });
});

describe("the workspace's stored plan", () => {
  it("follows the verified plan when the row disagrees, in either direction", async () => {
    for (const [stored, verified] of [["free", "builder"], ["builder", "free"]]) {
      vi.clearAllMocks();
      fake.simulation.mockResolvedValue(null);
      fake.rpc.mockResolvedValue(row(stored));
      fake.entitlements.mockResolvedValue({ plan: verified });
      const member = await getMember();
      expect(member?.entitlements).toEqual({ plan: verified });
      expect(fake.update.mock.calls.filter(([table]) => table === "workspaces")).toEqual([["workspaces", { plan: verified }]]);
      expect(fake.eq).toHaveBeenCalledWith("id", "ws_a");
    }
  });

  it("writes nothing when the row already agrees", async () => {
    fake.rpc.mockResolvedValue(row("builder"));
    fake.entitlements.mockResolvedValue({ plan: "builder" });
    await getMember();
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("leaves the stored plan alone when Clerk couldn't be read, while the request gets Free", async () => {
    fake.rpc.mockResolvedValue(row("builder"));
    fake.entitlements.mockResolvedValue({ plan: "free", unread: true });
    const member = await getMember();
    expect(member?.entitlements.plan).toBe("free");
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("never stores a simulated plan", async () => {
    fake.rpc.mockResolvedValue(row("free"));
    fake.entitlements.mockResolvedValue({ plan: "builder" });
    fake.simulation.mockResolvedValue({ builder: true });
    await getMember();
    expect(fake.update).not.toHaveBeenCalled();
  });
});
