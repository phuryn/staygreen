import { readFileSync } from "node:fs";
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { imperativeProfilePages, WorkspaceProfile, WorkspaceSwitcher, workspaceProfilePages } from "@/components/WorkspaceProfile";
import { invoicesAvailable } from "@/lib/invoices/access";
import type { Member } from "@/lib/workspace";

const doubles = vi.hoisted(() => ({ org: "org_a", url: "mock" as string | undefined, children: [] as ReactNode[] }));
vi.mock("@/lib/env", () => ({ env: () => ({ INVOICE_SERVICE_URL: doubles.url }) }));
vi.mock("@/lib/workspace", async () => ({ allowed: (await import("@/lib/authz")).hasPermission }));
vi.mock("@/components/invoices/Invoices", () => ({ Invoices: () => null }));
vi.mock("@clerk/nextjs", () => ({
  useClerk: () => ({ openOrganizationProfile: vi.fn() }),
  useOrganization: () => ({ organization: { id: doubles.org } }),
  OrganizationSwitcher: Object.assign(({ children }: { children: ReactNode }) => { doubles.children = Children.toArray(children); return null; },
    { OrganizationProfilePage: function ProfilePage() {} }),
}));

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("workspace profile registration", () => {
  it("requires both a configured service and billing:manage in the verified workspace", () => {
    const member = {
      caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" },
      workspace: { id: "ws_a", clerk_org_id: "org_a" },
    } as Member;
    for (const service of [undefined, "mock"]) {
      doubles.url = service;
      expect(invoicesAvailable(member)).toBe(!!service);
      expect(invoicesAvailable({ ...member, caller: { ...member.caller, orgRole: "org:member" } })).toBe(false);
    }
    expect(read("src/app/(app)/app/layout.tsx")).toContain("invoicesEnabled={invoicesAvailable(member)}");
  });

  it("derives the same ordered pages for switcher children and the imperative opener, reordering only Billing", () => {
    const org = "org_a";
    const setSlot = vi.fn();
    renderToStaticMarkup(createElement(WorkspaceProfile, { organizationId: org, invoicesEnabled: true, children: createElement(WorkspaceSwitcher) }));
    const direct = doubles.children;
    expect(direct).toHaveLength(2);
    expect(direct.every(child => isValidElement(child) && typeof child.type === "function" && child.type.name === "ProfilePage")).toBe(true);
    const [billing, invoices] = direct as ReactElement<{ label: string; url?: string; children?: ReactElement }>[];
    expect(billing.props).toEqual({ label: "billing" });
    expect(invoices.props.children?.key).toBe(org);
    const [native, custom] = imperativeProfilePages(workspaceProfilePages(org, true), setSlot);
    expect(native).toEqual(billing.props);
    expect(custom).toMatchObject({ label: invoices.props.label, url: invoices.props.url });
    const slot = {} as HTMLDivElement;
    custom.mount?.(slot);
    custom.mountIcon?.(slot);
    custom.unmount?.(slot);
    custom.unmountIcon?.(slot);
    expect(setSlot.mock.calls).toEqual([["invoices", slot], ["invoices:icon", slot], ["invoices", slot, true], ["invoices:icon", slot, true]]);
    expect(workspaceProfilePages("org_b", true)[1]).toMatchObject({ content: { key: "org_b" } });
  });

  it.each([[false, "org_a"], [true, "org_b"]] as const)("withholds registration when enabled=%s and the verified workspace is %s", (invoicesEnabled, organizationId) => {
    renderToStaticMarkup(createElement(WorkspaceProfile, { organizationId, invoicesEnabled, children: createElement(WorkspaceSwitcher) }));
    expect(doubles.children).toEqual([]);
  });

  it("routes the switcher, both Billing buttons and Settings through the shared definition", () => {
    expect(read("src/components/Shell.tsx")).toContain("<WorkspaceSwitcher />");
    expect(read("src/components/WorkspaceProfile.tsx")).toContain("clerk.openOrganizationProfile({ customPages })");
    const billing = read("src/app/(app)/app/billing/BillingScreen.tsx");
    expect(billing).toMatch(/onClick=\{profile.open\}>Manage subscription and payments/);
    expect(billing).toMatch(/profile.invoicesEnabled && <button[^>]*onClick=\{profile.open\}>Open workspace settings for invoices/);
    expect(read("src/app/(app)/app/settings/SettingsScreen.tsx")).toMatch(/onClick=\{profile.open\}>Manage name and members/);
  });
});

it("resolves every Clerk appearance variable in both palettes", () => {
  const css = read("design/tokens.css");
  const light = css.slice(css.indexOf(":root"), css.indexOf("@media (prefers-color-scheme: dark)"));
  const dark = css.match(/:root\[data-theme="dark"\],\s*\.theme-dark\s*\{([^}]+)\}/)?.[1] ?? "";
  const shared = css.match(/\n:root \{([^}]+)\}/)?.[1] ?? "";
  const appearance = read("src/app/layout.tsx").match(/const appearance = \{\s*variables: \{([^}]+)\}/)?.[1] ?? "";
  const options = [...appearance.matchAll(/:\s*"([^"]+)"/g)];
  expect(options.length).toBeGreaterThan(10);
  for (const [, option] of options) {
    expect(option).toMatch(/^var\(--[a-z0-9-]+\)$/);
    const token = option.slice(4, -1);
    const alias = shared.match(new RegExp(`${token}: var\\((--[a-z0-9-]+)\\);`))?.[1];
    if (!alias && shared.includes(`${token}:`)) continue;
    expect(light).toContain(`${alias ?? token}:`);
    expect(dark).toContain(`${alias ?? token}:`);
  }
});
