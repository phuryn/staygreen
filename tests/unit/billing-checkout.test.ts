import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/authz";
import { built } from "@/lib/launch";
import { offers, usd } from "@/lib/plan-offer";
import { FREE } from "@/lib/plans";
import type { Member } from "@/lib/workspace";
import type { Workspace } from "@/lib/workspace-store";
import { NOW, sim } from "./fixtures";

const state = vi.hoisted(() => ({ workspace: null as Workspace | null, member: null as Member | null }));
const clerk = vi.hoisted(() => ({ isLoaded: true, organization: null as { id: string; name: string } | null }));
const snapshot = vi.hoisted(() => vi.fn());
const requireMember = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace-store", () => ({
  useWorkspace: () => state.workspace,
  WorkspaceSnapshot: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/workspace", () => ({
  requireMember,
  loadSnapshot: snapshot,
}));
vi.mock("@/lib/session", () => ({ devPlanSimulation: async () => null }));
vi.mock("@/lib/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/plans")>();
  return { ...actual, limits: { ...actual.limits, builder: { ...actual.limits.builder, monitors: 137 } } };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("@/app/(app)/app/billing/actions", () => ({ simulateBuilderPlan: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => clerk,
  PricingTable: (props: { for: string; newSubscriptionRedirectUrl: string }) => createElement("div", {
    "data-pricing-for": props.for, "data-continue": props.newSubscriptionRedirectUrl,
  }),
  useClerk: () => ({ openOrganizationProfile: vi.fn() }),
}));

import Landing from "@/app/(public)/page";
import Pricing from "@/app/(public)/pricing/page";
import BillingPage from "@/app/(app)/app/billing/page";
import { BillingScreen } from "@/app/(app)/app/billing/BillingScreen";

beforeEach(() => {
  vi.clearAllMocks();
  clerk.isLoaded = true;
  clerk.organization = null;
  state.member = {
    caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" },
    workspace: { id: "ws_a", clerk_org_id: "org_a" }, entitlements: FREE,
  };
  requireMember.mockImplementation(async () => state.member);
});
afterEach(() => vi.unstubAllEnvs());

describe("organization checkout", () => {
  it.each([Pricing])("identifies the active workspace before checkout, including after a workspace change", (page) => {
    for (const organization of [{ id: "org_a", name: "First workspace" }, { id: "org_b", name: "Second <workspace>" }]) {
      clerk.organization = organization;
      const html = renderToStaticMarkup(createElement(page));
      const name = organization.name.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const label = `Plans and payment for workspace: <strong>${name}</strong>`;
      expect(html).toContain(label);
      expect(html.indexOf(label)).toBeLessThan(html.indexOf('data-pricing-for="organization"'));
      if (organization.id === "org_b") expect(html).not.toContain("First workspace");
    }
    // Initial load and a switch can both leave auth state unresolved.
    clerk.isLoaded = false;
    const loading = renderToStaticMarkup(createElement(page));
    expect(loading).toContain("Loading workspace and plans");
    expect(loading).not.toContain("data-pricing-for");
    expect(loading).not.toContain("Plans and payment for workspace");
  });

  it.each([Pricing])("renders exactly one vendor table on the public pricing surface, returning to Billing", (page) => {
    const html = renderToStaticMarkup(createElement(page));
    expect(built.billing).toBe(true);
    expect(html.match(/data-pricing-for="organization"/g)).toHaveLength(1);
    expect(html).toContain('data-continue="/app/billing"');
    expect(html).toContain('href="/app/billing"');
    expect(html).not.toContain("Plans and payment for workspace");
    expect(html).not.toMatch(/plan=builder|cycle=|isn.t on sale yet/);
  });

  it.each(["free", "builder"] as const)("only offers billing controls to a billing manager on %s", (plan) => {
    for (const manage of [false, true]) {
      state.workspace = {
        ...sim({ plan }), loadedAt: NOW, features: [],
        can: Object.fromEntries(PERMISSIONS.map(p => [p, p !== "billing:manage" || manage])) as Workspace["can"],
      };
      const html = renderToStaticMarkup(createElement(BillingScreen, { simulation: null }));
      expect(html.includes('data-pricing-for="organization"')).toBe(manage);
      // A Free workspace has no subscription to manage; Clerk's table is its way to Builder.
      expect(html.includes("Manage subscription and payments")).toBe(manage && plan === "builder");
      expect(html.includes("Manage your subscription below")).toBe(manage && plan === "builder");
      expect(html).not.toContain("arrives with billing");
      // The page never sends a member out to the public pricing page to upgrade.
      expect(html).not.toContain('href="/pricing"');
    }
  });

  // Every Builder mark leads here (`upgradeAction`), so on Free the upgrade is the first thing on
  // the page; on Builder the usage comes first and the plans follow it.
  it.each(["free", "builder"] as const)("orders the %s page around what its admin came to do", (plan) => {
    state.workspace = {
      ...sim({ plan }), loadedAt: NOW, features: [],
      can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"],
    };
    const html = renderToStaticMarkup(createElement(BillingScreen, { simulation: null }));
    const at = (s: string) => { const i = html.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    if (plan === "free") {
      expect(at('<h2 id="checkout-h" class="t-section">Upgrade to Builder</h2>')).toBeLessThan(at("Free: what you"));
      expect(html).toContain('class="section pb-upgrade"');
      // Clerk's table says what Builder adds, so the page's own summary of it stays out.
      expect(html).not.toContain('id="plan-h"');
    } else {
      expect(at("Builder: what you")).toBeLessThan(at('<h2 id="checkout-h" class="t-section">Plans and payment</h2>'));
      expect(html).not.toContain("pb-upgrade");
    }
  });

  it("keeps the simulated plan separate from checkout", () => {
    state.workspace = {
      ...sim({ plan: "builder" }), loadedAt: NOW, features: [],
      can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"],
    };
    const html = renderToStaticMarkup(createElement(BillingScreen, { simulation: { builder: true } }));
    expect(html).toContain("Simulated in this browser only");
    expect(html).not.toContain("data-pricing-for");
    expect(html).not.toContain("Manage subscription and payments");
  });

  it("resolves the member on the Billing return path and reads only that member's workspace", async () => {
    await BillingPage();
    expect(requireMember).toHaveBeenCalledWith("/app/billing");
    expect(snapshot).toHaveBeenCalledExactlyOnceWith(state.member);
  });

  // The landing prints no Builder capacity of its own: its cards print the Clerk setup's labels,
  // which `clerk-billing-config.test.ts` pins to the plan module.
  it("derives the public capacity summary from the plan module", () => {
    expect(renderToStaticMarkup(createElement(Pricing))).toContain("137");
    expect(renderToStaticMarkup(createElement(Landing))).not.toContain("137");
  });

  it("prints the Clerk setup's own plan lines and prices on the landing, and mounts Clerk's table only on /pricing", () => {
    const landing = renderToStaticMarkup(createElement(Landing));
    for (const line of [...offers.free.lines, ...offers.builder.lines]) expect(landing).toContain(line.replace(/'/g, "&#x27;"));
    expect(landing).toContain(`${usd(offers.builder.yearlyMonthly)}</span>`);
    expect(landing).toContain(`${usd(offers.builder.monthly)} billed monthly`);
    expect(offers.builder).toMatchObject({ monthly: 9, yearlyMonthly: 7.5 });
    expect(landing).not.toContain("data-pricing-for");
    expect(renderToStaticMarkup(createElement(Pricing))).toContain("data-pricing-for");
  });
});

it.each(["billing@example.test", ""])("offers receipts and company/VAT invoices on request through the existing contact (%s)", (email) => {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", email);
  const html = renderToStaticMarkup(createElement(Pricing));
  const faq = html.slice(html.indexOf("Do you send invoices?"));
  expect(faq).toContain("receipt for each payment");
  expect(faq).toContain("company details and VAT number is available on request");
  expect(faq).toContain("Send those details to");
  if (email) expect(faq).toContain(`href="mailto:${email}"`);
  else {
    expect(faq).toContain("HURYN Sp. z o.o.");
    expect(faq).toContain("00-521");
    expect(faq).not.toContain("mailto:");
  }
});

const root = fileURLToPath(new URL("../../src", import.meta.url));
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? files(path) : /\.(tsx?|css|json)$/.test(entry.name) ? [path] : [];
});
const currencyAmount = /(?:[$€£]\s*(?:\d|\$\{)|\b(?:USD|EUR|GBP)\s*\d)/;
it("has no currency-amount literals in screens and plan copy: Staygreen prices belong to Clerk", () => {
  for (const sample of ["$9", "€41/mo", "£20", "USD 90", "$${price.yearly}"]) expect(sample).toMatch(currencyAmount);
  // Check display sources. Backend parsers/SQL use dollar signs for replacement
  // groups, JSONPath and parameters, which aren't displayed prices.
  const display = [...files(join(root, "app")), ...files(join(root, "components")), join(root, "lib/plans.ts")];
  for (const path of display) expect(readFileSync(path, "utf8"), path).not.toMatch(currencyAmount);
  expect(readFileSync(join(root, "lib/plans.ts"), "utf8")).not.toContain("export const price");
});
