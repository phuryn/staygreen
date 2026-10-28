import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/authz";
import { builderSlugs, limits } from "@/lib/plans";
import type { Workspace } from "@/lib/workspace-store";
import { monitor, NOW, sim } from "./fixtures";

const fake = vi.hoisted(() => ({
  workspace: null as Workspace | null, requireMember: vi.fn(), snapshot: vi.fn(),
  pricing: vi.fn(), organization: vi.fn(), clerk: vi.fn(),
}));
vi.mock("@/lib/workspace-store", () => ({
  useWorkspace: () => fake.workspace,
  useToasts: () => ({ toasts: [], dismiss: vi.fn() }),
  WorkspaceSnapshot: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/workspace", () => ({ requireMember: fake.requireMember, loadSnapshot: fake.snapshot }));
vi.mock("@/lib/session", () => ({ devPlanSimulation: async () => null }));
vi.mock("@/app/(app)/app/billing/actions", () => ({ simulateBuilderPlan: vi.fn() }));
vi.mock("@/components/AppSwitcher", () => ({ AppRow: () => null, AppLine: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/app", useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "test-font" }) }));
vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  UNSAFE_PortalProvider: ({ children }: { children: ReactNode }) => children,
  OrganizationSwitcher: () => null, UserButton: () => null,
  useOrganization: fake.organization, PricingTable: fake.pricing, useClerk: fake.clerk,
}));

import RootLayout from "@/app/layout";
import BillingPage from "@/app/(app)/app/billing/page";
import { BillingScreen } from "@/app/(app)/app/billing/BillingScreen";
import { OrganizationPlans } from "@/components/OrganizationPlans";
import { Shell } from "@/components/Shell";
import { SelfHostedPlanProvider } from "@/components/SelfHostedPlan";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SELF_HOSTED_PLAN", "builder");
  fake.workspace = {
    ...sim({ plan: "builder", monitors: [monitor({ id: "m1" }), monitor({ id: "h1", type: "heartbeat" }), monitor({ id: "ssl", auto: true })] }),
    loadedAt: NOW, features: [...builderSlugs], limits: limits.builder,
    can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"],
  };
  fake.requireMember.mockResolvedValue({ workspace: { id: "ws_a" } });
  fake.snapshot.mockResolvedValue(fake.workspace);
  fake.organization.mockReturnValue({ isLoaded: true, organization: { id: "org_a", name: "Example" } });
  fake.pricing.mockImplementation(() => createElement("div", { "data-clerk-billing": true }));
  fake.clerk.mockReturnValue({ openOrganizationProfile: vi.fn() });
});
afterEach(() => vi.unstubAllEnvs());

const document = async (children: ReactNode) => renderToStaticMarkup(await RootLayout({ children }));

it("passes the server's mode to both rails, retaining usage without a billing link", async () => {
  const html = await document(createElement(Shell, null, "Dashboard"));
  expect(html.match(/class="plan-box"/g)).toHaveLength(2);
  expect(html.match(/2 of 100 monitors/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html.match(/1 of 50/g)?.length).toBeGreaterThanOrEqual(2);
  expect(html).toContain("1-minute checks");
  expect(html).not.toContain('href="/app/billing"');
  expect(html).not.toContain("Plan and billing");
  expect(html).not.toMatch(/<a[^>]*class="plan-box"/);
  expect(html).toContain('href="/app/settings"');
});

it("keeps billing out while the workspace snapshot is loading too", async () => {
  fake.workspace = null;
  const html = await document(createElement(Shell, null, "Loading"));
  expect(html).not.toContain('href="/app/billing"');
  expect(html).not.toContain("Plan and billing");
});

it("checks membership on the billing route, then shows the included plan without checkout or a switch", async () => {
  const html = await document(await BillingPage());
  expect(fake.requireMember).toHaveBeenCalledExactlyOnceWith("/app/billing");
  expect(html).toContain("This installation includes every Builder feature.");
  expect(html).not.toMatch(/data-clerk-billing|Manage subscription|Simulate Builder|href="\/app\/billing"/);
  expect(fake.pricing).not.toHaveBeenCalled();
  expect(fake.organization).not.toHaveBeenCalled();
  expect(fake.clerk).not.toHaveBeenCalled();
});

it("does not bypass the billing route's signed-out refusal", async () => {
  fake.requireMember.mockRejectedValueOnce(Error("redirect to sign-in"));
  await expect(BillingPage()).rejects.toThrow("redirect to sign-in");
  expect(fake.snapshot).not.toHaveBeenCalled();
});

it("suppresses checkout and simulation even if a previously simulated snapshot is supplied", () => {
  const html = renderToStaticMarkup(createElement(SelfHostedPlanProvider, { enabled: true, children:
    createElement(BillingScreen, { simulation: { builder: true } }),
  }));
  expect(html).toContain("This installation includes every Builder feature.");
  expect(html).not.toMatch(/Simulat|data-clerk-billing/);
});

it("suppresses the shared pricing component without even reading Clerk's payer on a self-hosted public page", async () => {
  expect(await document(createElement(OrganizationPlans))).not.toContain("data-clerk-billing");
  expect(fake.organization).not.toHaveBeenCalled();
  expect(fake.pricing).not.toHaveBeenCalled();
});

it.each([undefined, ""])("preserves the hosted rail, usage link and checkout with mode %j", async mode => {
  vi.stubEnv("SELF_HOSTED_PLAN", mode);
  const html = await document(createElement(Shell, null, await BillingPage()));
  expect(html).toContain('href="/app/billing"');
  expect(html).toMatch(/<a[^>]*class="plan-box"/);
  expect(html).toContain("Plan and billing");
  expect(html).toContain("data-clerk-billing");
  expect(html).toContain("Manage subscription and payments");
  expect(fake.pricing).toHaveBeenCalled();
});
