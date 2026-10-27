import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builderRegion } from "@/components/landing/plan-copy";
import { isLive, type LaunchArea } from "@/lib/launch";
import { limits, locations, slugLabel } from "@/lib/plans";

// The Clerk billing setup both instances run (`docs/billing.md`): applied with
// `clerk config patch --file scripts/clerk/billing.json`. The pricing table prints the visible
// features' names, so their numbers come from the plan module; the slugs the code checks stay
// hidden from it and stay in the session token.
const config = JSON.parse(readFileSync(new URL("../../scripts/clerk/billing.json", import.meta.url), "utf8")).billing as {
  features: Record<string, { name: string; publicly_visible: boolean; include_in_jwt: boolean }>;
  plans: Record<string, { name: string; features: string[]; payer_type: string }>;
};
const F = limits.free;
const B = limits.builder;
const shown = (plan: string) => config.plans[plan].features.filter((k) => config.features[k].publicly_visible).map((k) => config.features[k].name);

describe("the Clerk billing setup", () => {
  it("attaches every slug the code checks to Builder alone, hidden and in the token", () => {
    for (const slug of Object.keys(slugLabel)) {
      expect(config.plans.builder.features, slug).toContain(slug);
      expect(config.plans.free_org.features, slug).not.toContain(slug);
      expect(config.features[slug].publicly_visible, slug).toBe(false);
      expect(config.features[slug].include_in_jwt, slug).toBe(true);
    }
  });

  it("shows only display features, which nothing reads and the token doesn't carry", () => {
    for (const [slug, f] of Object.entries(config.features)) {
      if (slug in slugLabel) continue;
      expect(f.publicly_visible, slug).toBe(true);
      expect(f.include_in_jwt, slug).toBe(false);
    }
  });

  it("keeps Coming soon capabilities out of the displayed offer", () => {
    for (const plan of ["free_org", "builder"]) {
      expect(shown(plan).join(" ")).not.toMatch(/CSV|maintenance|alert delay|repeat while down|subscribers|MCP server monitors|own MCP server/i);
    }
  });

  it("states the plan module's numbers", () => {
    const [freeLocations, builderLocations] = [F, B].map((l) => l.locations.filter((id) => locations[id].live).length);
    expect(shown("free_org")).toEqual(expect.arrayContaining([
      `${F.apps} app, ${F.monitors} monitors and ${F.heartbeats} heartbeats`,
      `HTTP checks every ${F.httpIntervalMin} minutes from ${freeLocations} locations`,
    ]));
    expect(shown("builder")).toEqual(expect.arrayContaining([
      `${B.apps} apps, ${B.monitors} monitors and ${B.heartbeats} heartbeats`,
      `${B.httpIntervalMin}-minute HTTP checks from ${builderLocations} locations, one in ${builderRegion}`,
      `${B.historyLabel} of history`,
      // The mark goes from status pages, the widget and the badge, never from alerts (spec.md § 1).
      "No Staygreen mark on your status pages",
    ]));
  });

  it("names no area the launch list marks soon", () => {
    // What a label would say about each area; a label naming a soon area sells what doesn't run.
    const words: Partial<Record<LaunchArea, RegExp>> = {
      customDomains: /own domain/i, widget: /banner|pill/i, agentMcp: /MCP server for/i, stripe: /Stripe/i,
      supabase: /Supabase/i, heartbeat: /heartbeat/i, dns: /DNS/i, tcp: /TCP/i, ssl: /SSL/i,
      alerts: /alerts/i, statusPages: /status page/i, frankfurt: /Europe|Frankfurt/i,
    };
    for (const plan of ["free_org", "builder"]) for (const label of shown(plan)) for (const [area, re] of Object.entries(words) as [LaunchArea, RegExp][]) {
      if (re.test(label)) expect(isLive(area), `"${label}" on ${plan} names ${area}, which the launch list marks soon`).toBe(true);
    }
  });


});
