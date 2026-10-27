import { afterEach, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
const planList = vi.hoisted(() => vi.fn(async () => ({ data: [] as unknown[] })));
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: async () => ({ billing: { getOrganizationBillingSubscription: read, getPlanList: planList } }) }));
import { apiEntitlements, subscriptionEntitlements } from "@/lib/api-entitlements";
import { FREE } from "@/lib/plans";
afterEach(() => vi.useRealTimers());
const now = Date.parse("2026-10-23T12:00:00Z");
const paidPlan = { forPayerType: "org", features: [{ slug: "scale_builder" }, { slug: "history_1y" }] };

it("keeps canceled paid features for machine credentials through the paid period, then drops them on the next request", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  read.mockResolvedValue({ status: "active", subscriptionItems: [
    { status: "active", plan: { forPayerType: "org", features: [] } },
    { status: "canceled", canceledAt: now - 1000, periodEnd: now + 1000, plan: paidPlan },
  ] });
  const paid = await apiEntitlements("org_canceled");
  expect(paid.limits.apiPerMin).toBe(120);
  expect(paid.features).toContain("history_1y");
  vi.setSystemTime(now + 1000);
  expect(await apiEntitlements("org_canceled")).toEqual(FREE);
});

it.each([undefined, null, now - 1, now, "2099-01-01", Infinity])("requires a future millisecond periodEnd for canceled items (%s)", periodEnd => {
  expect(subscriptionEntitlements({ status: "active", subscriptionItems: [{ status: "canceled", periodEnd, plan: paidPlan }] }, now)).toEqual(FREE);
});

it.each(["past_due", "ended", "upcoming", "incomplete", "abandoned"])("never extends %s items even with a future period end", status => {
  expect(subscriptionEntitlements({ status: "active", subscriptionItems: [{ status, periodEnd: now + 1000, plan: paidPlan }] }, now)).toEqual(FREE);
});

it("rejects past-due subscriptions and canceled user-plan features", () => {
  expect(subscriptionEntitlements({ status: "past_due", subscriptionItems: [{ status: "canceled", periodEnd: now + 1000, plan: paidPlan }] }, now)).toEqual(FREE);
  expect(subscriptionEntitlements({ status: "active", subscriptionItems: [{ status: "canceled", periodEnd: now + 1000, plan: { ...paidPlan, forPayerType: "user" } }] }, now)).toEqual(FREE);
});
it("derives machine capacities from active organization features, independent of browser cookies", async () => {
  read.mockResolvedValue({ status: "active", subscriptionItems: [{ status: "active", plan: { forPayerType: "org", features: [{ slug: "scale_builder" }, { slug: "history_1y" }] } }] });
  const e = await apiEntitlements("org_a"); expect(e.limits.apiPerMin).toBe(120); expect(e.features).toContain("history_1y");
  expect(read).toHaveBeenCalledWith("org_a");
});
it.each([{}, null, { status: "active", subscriptionItems: [{ status: "active", plan: { forPayerType: "user", features: [{ slug: "scale_builder" }] } }] }, { status: "active", subscriptionItems: [{ status: "canceled", plan: { forPayerType: "org", features: [{ slug: "scale_builder" }] } }] }])("fails closed on malformed, user, or inactive subscriptions", value => {
  expect(subscriptionEntitlements(value)).toEqual(FREE);
});
it("fails towards Free when Clerk billing cannot be read", async () => { read.mockRejectedValue(new Error("offline")); expect(await apiEntitlements("org_a")).toEqual(FREE); });

// What Clerk returns (development, 2026-10-23): the subscription's plan lists only its visible
// labels; the hidden slugs the code checks are on the plan list. A fresh module has no plan cache.
const visibleOnly = { status: "active", subscriptionItems: [{ status: "active", plan: { id: "cplan_builder", forPayerType: "org", features: [{ slug: "show_builder_scale" }, { slug: "show_builder_history" }] } }] };
it("reads the checked slugs from the plan list when the subscription carries only visible labels", async () => {
  vi.resetModules();
  const { apiEntitlements: fresh } = await import("@/lib/api-entitlements");
  read.mockResolvedValue(visibleOnly);
  planList.mockResolvedValueOnce({ data: [{ id: "cplan_builder", features: [{ slug: "scale_builder" }, { slug: "history_1y" }, { slug: "show_builder_scale" }] }] });
  const e = await fresh("org_paid");
  expect(e.limits.apiPerMin).toBe(120); expect(e.features).toContain("history_1y");
  expect(planList).toHaveBeenLastCalledWith({ payerType: "org" });
});
it("is Free from the subscription alone when it carries only visible labels", () => {
  expect(subscriptionEntitlements(visibleOnly, now)).toEqual(FREE);
});
it("fails towards Free when the plan list cannot be read", async () => {
  vi.resetModules();
  const { apiEntitlements: fresh } = await import("@/lib/api-entitlements");
  read.mockResolvedValue(visibleOnly);
  planList.mockRejectedValueOnce(new Error("offline"));
  expect(await fresh("org_paid")).toEqual(FREE);
});
