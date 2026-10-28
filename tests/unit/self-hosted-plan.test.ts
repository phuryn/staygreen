import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builderSlugs, demoSlug, FREE, limits } from "@/lib/plans";
import { agentQuery } from "../support/agent-db";

const fake = vi.hoisted(() => ({
  auth: vi.fn(), has: vi.fn(), cookies: vi.fn(), client: vi.fn(), subscription: vi.fn(), plans: vi.fn(),
  rpc: vi.fn(), update: vi.fn(), eq: vi.fn(),
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: fake.auth, clerkClient: fake.client }));
vi.mock("next/headers", () => ({ cookies: fake.cookies }));
vi.mock("@/lib/db", () => ({ db: () => ({ rpc: fake.rpc, from: (table: string) => {
  const q = agentQuery(null);
  q.update = (value: unknown) => { fake.update(table, value); return q; };
  q.eq = (key: string, value: unknown) => { fake.eq(key, value); return q; };
  return q;
} }) }));

import { currentCaller, currentEntitlements, devPlanOverrideEnabled, devPlanSimulation } from "@/lib/session";
import { apiEntitlements } from "@/lib/api-entitlements";
import { getMember } from "@/lib/workspace";

const builder = { plan: "builder", features: [...builderSlugs], limits: limits.builder };
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SELF_HOSTED_PLAN", "builder");
  vi.stubEnv("DEV_PLAN_OVERRIDE", "off");
  fake.auth.mockResolvedValue({ userId: "user_a", orgId: "org_a", orgRole: "org:admin", has: fake.has });
  fake.has.mockImplementation(() => { throw Error("Billing is disabled"); });
  fake.client.mockImplementation(() => { throw Error("Billing is disabled"); });
  fake.rpc.mockResolvedValue({ data: { id: "ws_a", clerk_org_id: "org_a", plan: "free" }, error: null });
  fake.eq.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("self-hosted entitlements", () => {
  it.each(["development", "production", "test"])("grants signed-in members every ordinary Builder feature under %s without consulting billing", async nodeEnv => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    expect(await currentCaller()).toEqual({ userId: "user_a", orgId: "org_a", orgRole: "org:admin" });
    expect(await currentEntitlements()).toEqual(builder);
    expect(fake.auth).toHaveBeenCalled();
    expect(fake.has).not.toHaveBeenCalled();
    expect(fake.client).not.toHaveBeenCalled();
    expect(fake.cookies).not.toHaveBeenCalled();
  });

  it("needs no has function and never picks up the owner's demo counts", async () => {
    fake.auth.mockResolvedValueOnce({ userId: "user_a" });
    expect(await currentEntitlements()).toEqual(builder);
    fake.has.mockReturnValue(true); // would include scale_demo if consulted
    expect(await currentEntitlements()).toEqual(builder);
    expect(fake.has).not.toHaveBeenCalled();
  });

  it("leaves signed-out visitors Free and never bypasses verification failure", async () => {
    fake.auth.mockResolvedValueOnce({ userId: null, has: fake.has });
    expect(await currentEntitlements()).toEqual(FREE);
    fake.auth.mockRejectedValueOnce(Error("session could not be verified"));
    await expect(currentEntitlements()).rejects.toThrow("session could not be verified");
    expect(fake.has).not.toHaveBeenCalled();
  });

  it("grants machine credentials Builder for every resolved organization without creating a Clerk client", async () => {
    for (const org of ["org_a", "org_b"]) expect(await apiEntitlements(org)).toEqual(builder);
    expect(await apiEntitlements("")).toEqual(FREE);
    expect(fake.client).not.toHaveBeenCalled();
    expect(fake.auth).not.toHaveBeenCalled();
  });

  it.each(["free", "builder"])("wins over the development cookie (%s), hides the switch and stores Builder for the probes", async cookie => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_PLAN_OVERRIDE", "on");
    fake.cookies.mockResolvedValue({ get: () => ({ value: cookie }) });
    expect(devPlanOverrideEnabled()).toBe(false);
    expect(await devPlanSimulation()).toBeNull();
    const member = await getMember();
    expect(member?.entitlements).toEqual(builder);
    expect(fake.update.mock.calls.filter(([table]) => table === "workspaces")).toEqual([["workspaces", { plan: "builder" }]]);
    expect(fake.eq).toHaveBeenCalledWith("id", "ws_a");
    expect(fake.cookies).not.toHaveBeenCalled();
    expect(fake.has).not.toHaveBeenCalled();
  });

  it.each([undefined, ""])("keeps both Clerk entitlement paths when SELF_HOSTED_PLAN is %j", async mode => {
    vi.stubEnv("SELF_HOSTED_PLAN", mode);
    fake.has.mockImplementation(({ feature }: { feature: string }) => feature !== demoSlug);
    fake.subscription.mockResolvedValue({ status: "active", subscriptionItems: [{ status: "active", plan: {
      forPayerType: "org", features: builderSlugs.map(slug => ({ slug })),
    } }] });
    fake.plans.mockResolvedValue({ data: [] });
    fake.client.mockResolvedValue({ billing: { getOrganizationBillingSubscription: fake.subscription, getPlanList: fake.plans } });
    expect(await currentEntitlements()).toEqual(builder);
    expect(fake.has).toHaveBeenCalled();
    expect(await apiEntitlements("org_a")).toEqual(builder);
    expect(fake.subscription).toHaveBeenCalledWith("org_a");
    fake.auth.mockResolvedValueOnce({ userId: null });
    expect(await currentEntitlements()).toEqual(FREE);
    fake.has.mockReturnValue(false);
    fake.subscription.mockRejectedValueOnce(Error("no billing"));
    expect(await currentEntitlements()).toEqual(FREE);
    expect(await apiEntitlements("org_a")).toEqual(FREE);
  });
});
