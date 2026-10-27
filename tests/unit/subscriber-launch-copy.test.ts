import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import Landing from "@/app/(public)/page";
import Pricing from "@/app/(public)/pricing/page";
import { BillingScreen } from "@/app/(app)/app/billing/BillingScreen";
import { SettingsScreen } from "@/app/(app)/app/settings/SettingsScreen";
import { areaLabel, launch, soonAreas } from "@/lib/launch";
import { limits, locations, slugLabel } from "@/lib/plans";
import { PERMISSIONS } from "@/lib/authz";
import type { Workspace } from "@/lib/workspace-store";
import { NOW, sim } from "./fixtures";

// Real pages and plan table; only the member feed, navigation and action boundary are faked.
const feed = vi.hoisted(() => ({ workspace: null as Workspace | null }));
vi.mock("@/lib/workspace-store", () => ({ useWorkspace: () => feed.workspace, useActs: () => ({}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/app/billing/actions", () => ({ simulateBuilderPlan: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ PricingTable: () => null, useOrganization: () => ({ isLoaded: true, organization: null }), useClerk: () => ({ openOrganizationProfile: vi.fn() }) }));

const soon = '<span class="tag tag-soon">Coming soon</span>';
/** Free Billing for a member without `billing:manage`, the one who sees the page's own Builder summary. */
const asMember = () => {
  feed.workspace = {
    ...sim({ plan: "free" }), loadedAt: NOW, features: [],
    can: Object.fromEntries(PERMISSIONS.map(p => [p, p !== "billing:manage"])) as Workspace["can"],
  };
  return renderToStaticMarkup(createElement(BillingScreen, { simulation: null }));
};
const subscriberRow = (html: string) => [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)]
  .map(([row]) => row).find((row) => row.includes("Email subscribers"));

describe("Builder sells only the features running today", () => {
  const pending = ["alertTiming", "maintenanceWindows", "csvExport"] as const;

  it("puts missing alert controls and CSV export in the shared launch list, and Frankfurt's running probe out of it", () => {
    for (const area of pending) expect(soonAreas).toContain(area);
    expect(locations.fra1.live).toBe(true);
    expect(launch.frankfurt).toBe("live");
    expect(soonAreas).not.toContain("frankfurt");
  });

  it("marks each pending plan-table feature, keeping severity routing and every location live", () => {
    const html = renderToStaticMarkup(createElement(Pricing));
    const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(([row]) => row);
    for (const label of ["Alert delay and repeat while down", "Maintenance windows", "CSV export"]) {
      expect(rows.find(row => row.includes(label))).toContain(soon);
    }
    expect(rows.find(row => row.includes("Route incidents and warnings"))).not.toContain(soon);
    const cells = [...rows.find(row => row.includes("Check locations"))!.matchAll(/<td[\s\S]*?<\/td>/g)].map(([cell]) => cell);
    expect(cells[0]).not.toContain(soon);
    expect(cells[1]).toContain("Frankfurt");
    expect(cells[1]).not.toContain(soon);
    const history = rows.find(row => row.includes(">History<"));
    expect(history).toContain(limits.builder.historyLabel);
    expect(history).not.toContain(soon);
    expect(history).not.toContain("CSV");
    expect(slugLabel.history_1y).toBe("One year of history");
    const csv = rows.find(row => row.includes("CSV export"));
    expect(csv).toContain("Not included");
    expect(csv).toContain(">Included<");
  });

  // The landing's cards print the Clerk setup's lines, which list only live features; any line the
  // page itself adds that names a pending one still has to say so.
  it("marks any pending feature the landing lists, without marking severity routing", () => {
    const html = renderToStaticMarkup(createElement(Landing));
    const lines = [...html.matchAll(/<li[\s>][\s\S]*?<\/li>/g)].map(([li]) => li);
    for (const label of ["Alert delay and repeat", "Maintenance windows"]) {
      for (const line of lines.filter(l => l.includes(label))) expect(line).toContain(soon);
    }
    for (const label of ["Alert routing by severity", "one in Europe"]) {
      for (const line of lines.filter(l => l.includes(label))) expect(line).not.toContain(soon);
    }
  });

  it.each(["free", "builder"] as const)("keeps %s Billing's location promise true and all pending features beside checkout", (plan) => {
    feed.workspace = {
      ...sim({ plan }), loadedAt: NOW, features: [],
      can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"],
    };
    const html = renderToStaticMarkup(createElement(BillingScreen, { simulation: null }));
    const csv = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(([row]) => row).find(row => row.includes("CSV export"));
    expect(csv).toContain(soon);
    const settings = renderToStaticMarkup(createElement(SettingsScreen));
    const exportSection = settings.slice(settings.indexOf('aria-labelledby="ex-h"')).split("</section>")[0];
    expect(exportSection).toContain("CSV export");
    expect(exportSection).toContain(soon);
    expect(exportSection).not.toContain("exports it as CSV");
    // Each plan's own locations, Frankfurt's on Builder, and no Coming soon on any of them.
    expect(html).toContain(plan === "builder" ? "checks from Toronto, San Francisco and Frankfurt, and" : "checks from Toronto and San Francisco, and");
    expect(html).not.toContain("Checks from Frankfurt");
    // A Free admin reads what Builder adds in Clerk's table; a member who can't buy reads the page's own line.
    if (plan === "free") expect(asMember()).toContain(`a third location in Europe (Frankfurt), ${limits.builder.monitors} monitors`);
    // The caveat sits beside checkout: Billing and /pricing. The landing takes no payment.
    for (const page of [html, renderToStaticMarkup(createElement(Pricing))]) {
      const caveat = [...page.matchAll(/<p[\s\S]*?<\/p>/g)].map(([p]) => p).find(p => p.includes("paying for today"));
      for (const area of pending) expect(caveat).toContain(areaLabel[area]);
    }
  });
});

describe("subscribers are Coming soon wherever Builder is offered", () => {
  it("records the launch decision in the shared list", () => {
    expect(launch.subscribers).toBe("soon");
    expect(soonAreas).toContain("subscribers");
  });

  it("marks the pricing row and keeps subscribers exclusive to Builder", () => {
    const html = renderToStaticMarkup(createElement(Pricing));
    const row = subscriberRow(html);
    expect(row).toContain(soon);
    expect(row).toContain("Not included");
    expect(row).toContain("1,000 per page");
    expect(html).not.toContain("When it ships, both plans include it");
    // One inclusion rule for every Coming soon row would promise subscribers to Free.
    expect(html).not.toContain("included in the plans shown above");
    expect(html).toContain("When it ships, each plan gets it as the plan table above shows, at no extra cost.");
  });

  it("marks the subscriber feature wherever the landing lists it", () => {
    const html = renderToStaticMarkup(createElement(Landing));
    const lines = [...html.matchAll(/<li[\s>][\s\S]*?<\/li>/g)].map(([li]) => li)
      .filter((li) => li.includes("email subscribers"));
    for (const line of lines) expect(line).toContain(`email subscribers ${soon}`);
  });

  it.each(["free", "builder"] as const)("marks subscribers in Billing for a %s workspace", (plan) => {
    feed.workspace = {
      ...sim({ plan }), loadedAt: NOW, features: [],
      can: Object.fromEntries(PERMISSIONS.map((p) => [p, true])) as Workspace["can"],
    };
    const html = renderToStaticMarkup(createElement(BillingScreen, { simulation: null }));
    expect(subscriberRow(html)).toContain(soon);
    expect(html).not.toContain("This workspace has every Builder feature.");
    if (plan === "free") {
      const description = [...asMember().matchAll(/<p[\s\S]*?<\/p>/g)].map(([p]) => p)
        .find((p) => p.includes("email subscribers"));
      expect(description).toContain(`email subscribers ${soon}`);
    }
  });
});
