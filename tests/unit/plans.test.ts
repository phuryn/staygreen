import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builderSlugs, demoLimits, demoSlug, entitlementsFrom, FREE, has, holds, limits, limitsOf, locations, slugLabel, UNREAD, type Slug } from "@/lib/plans";

/* The plan module (`docs/product/spec.md § 1`, `AGENTS.md § 2.6`): feature
   slugs to numbers, failing toward Free. The tables below are the spec's, on
   purpose: "the plan module turns the feature slugs into these numbers, and
   tests pin them". */

describe("the limits table", () => {
  it("holds spec.md § 1's Free column", () => {
    expect(limits.free).toEqual({
      apps: 1,
      monitors: 50,
      httpIntervalMin: 3,
      mcpIntervalMin: 10,
      stripePollMin: 10,
      stripeAccounts: 1,
      locations: ["tor1", "sfo3"],
      assertions: 3,
      heartbeats: 5,
      heartbeatAssertions: 1,
      mcpMonitors: 2,
      supabaseMonitors: 1,
      statusPages: 1,
      historyLabel: "30 days",
      apiPerMin: 30,
      perHost: 5,
    });
  });

  it("holds spec.md § 1's Builder column", () => {
    expect(limits.builder).toEqual({
      apps: 10,
      monitors: 100,
      httpIntervalMin: 1,
      mcpIntervalMin: 5,
      stripePollMin: 5,
      stripeAccounts: 3,
      locations: ["tor1", "sfo3", "fra1"],
      assertions: 10,
      heartbeats: 50,
      heartbeatAssertions: 5,
      mcpMonitors: "cap",
      supabaseMonitors: "cap",
      statusPages: 10,
      historyLabel: "1 year",
      apiPerMin: 120,
      perHost: "fair use",
    });
  });

  it("gives Builder as many apps as status pages: one page per app is the model", () => {
    expect(limits.builder.apps).toBe(limits.builder.statusPages);
    expect(limits.free.apps).toBe(limits.free.statusPages);
  });

  it("holds spec.md § 4's locations, all on DigitalOcean and all running a probe", () => {
    expect(locations).toEqual({
      tor1: { city: "Toronto", country: "Canada", flag: "ca", continent: "North America", provider: "DigitalOcean", live: true },
      sfo3: { city: "San Francisco", country: "US", flag: "us", continent: "North America", provider: "DigitalOcean", live: true },
      fra1: { city: "Frankfurt", country: "Germany", flag: "de", continent: "Europe", provider: "DigitalOcean", live: true },
    });
  });

  // A flag sits beside a city in the dashboard (`design/README.md § Surfaces pinned outside the
  // theme`). Each is flag-icons' own file, served from `public/flags/` with its licence, and an
  // image of plain shapes: nothing that runs or reaches outside the file.
  it("has a flag file for each location's country: plain shapes, licence beside them", () => {
    const flags = fileURLToPath(new URL("../../public/flags/", import.meta.url));
    for (const l of Object.values(locations)) {
      const svg = readFileSync(`${flags}${l.flag}.svg`, "utf8");
      expect(svg, l.flag).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]* viewBox="0 0 640 480">/);
      expect(svg, l.flag).not.toMatch(/<script|<foreignObject|<image|<style|\shref=|\son\w+=|url\((?!#)/i);
    }
    expect(readFileSync(`${flags}LICENSE`, "utf8")).toMatch(/^The MIT License/);
  });

  it("puts the third location in Europe, a continent Free doesn't check from", () => {
    const extra = limits.builder.locations.filter((l) => !limits.free.locations.includes(l));
    expect(extra).toEqual(["fra1"]);
    expect(locations.fra1.continent).toBe("Europe");
    expect(limits.free.locations.map((l) => locations[l].continent)).toEqual(["North America", "North America"]);
  });

  it("never gives Free more than Builder", () => {
    const numeric = Object.keys(limits.free).filter((k) => typeof limits.free[k as keyof typeof limits.free] === "number" && typeof limits.builder[k as keyof typeof limits.builder] === "number");
    for (const key of numeric) {
      const f = limits.free[key as keyof typeof limits.free] as number;
      const b = limits.builder[key as keyof typeof limits.builder] as number;
      // Intervals are minutes between checks, so Builder's are the smaller.
      if (/Interval|Poll/.test(key)) expect(b, key).toBeLessThanOrEqual(f);
      else expect(b, key).toBeGreaterThanOrEqual(f);
    }
  });
});

describe("the feature slugs", () => {
  it("are AGENTS.md § 2.6's, each with a label", () => {
    expect([...builderSlugs]).toEqual(["scale_builder", "white_label", "private_pages", "subscribers", "alert_rules", "history_1y", "notify_teammates"]);
    expect(Object.keys(slugLabel).sort()).toEqual([...builderSlugs].sort());
  });

  it.each(builderSlugs)("has(plan, %s): Builder holds it, Free does not", (slug) => {
    expect(has("builder", slug)).toBe(true);
    expect(has("free", slug)).toBe(false);
  });

  it("refuses a slug the plan does not sell", () => {
    expect(has("builder", "sso" as Slug)).toBe(false);
  });
});

describe("entitlementsFrom", () => {
  it("is Free when the session holds nothing", () => {
    expect(entitlementsFrom(() => false)).toEqual(FREE);
    expect(FREE).toEqual({ plan: "free", features: [], limits: limits.free });
  });

  it("is Builder's numbers with every feature when the session holds them all", () => {
    expect(entitlementsFrom((slug) => slug !== demoSlug)).toEqual({ plan: "builder", features: [...builderSlugs], limits: limits.builder });
  });

  it("raises only the counts for the owner's demo plan, and only on Builder", () => {
    const demo = entitlementsFrom(() => true);
    expect(demo).toEqual({ plan: "builder", features: [...builderSlugs], limits: demoLimits });
    expect(demoLimits).toEqual({ ...limits.builder, apps: 100, monitors: 1000, heartbeats: 500, statusPages: 100 });
    // Without scale_builder the demo slug brings nothing; a failed read of it keeps Builder.
    expect(entitlementsFrom((slug) => slug === demoSlug)).toEqual(FREE);
    const flaky = entitlementsFrom((slug) => { if (slug === demoSlug) throw new Error("one read failed"); return true; });
    expect(flaky).toEqual({ plan: "builder", features: [...builderSlugs], limits: limits.builder });
  });

  it("gives screens the session's numbers when a snapshot carries them, else the plan's column", () => {
    expect(limitsOf({ plan: "builder", limits: demoLimits })).toBe(demoLimits);
    expect(limitsOf({ plan: "builder" })).toBe(limits.builder);
    expect(limitsOf({ plan: "free" })).toBe(limits.free);
  });

  it("follows scale_builder for the numbers, and nothing else", () => {
    const only = (held: Slug[]) => entitlementsFrom((slug) => held.includes(slug as Slug));
    expect(only(["scale_builder"])).toEqual({ plan: "builder", features: ["scale_builder"], limits: limits.builder });
    // Every other feature is its own switch: held alone, it brings no limit with it.
    const rest = builderSlugs.filter((s) => s !== "scale_builder");
    expect(only(rest)).toEqual({ plan: "free", features: rest, limits: limits.free });
    expect(only(["white_label"])).toEqual({ plan: "free", features: ["white_label"], limits: limits.free });
  });

  it("fails toward Free when the feature test throws, marked as a plan nobody read", () => {
    expect(
      entitlementsFrom(() => {
        throw new Error("Clerk is down");
      }),
    ).toEqual(UNREAD);
    expect(UNREAD).toEqual({ ...FREE, unread: true });
    const flaky = entitlementsFrom((slug) => {
      if (slug === "scale_builder") throw new Error("one read failed");
      return true;
    });
    expect(flaky.plan).toBe("free");
    expect(flaky.unread).toBe(true);
    expect(flaky.limits).toEqual(limits.free);
    expect(flaky.features).not.toContain("scale_builder");
    // Another feature's failed read costs that feature, and the plan itself was read.
    const other = entitlementsFrom((slug) => {
      if (slug === "white_label") throw new Error("one read failed");
      return true;
    });
    expect(other.plan).toBe("builder");
    expect(other.unread).toBeUndefined();
    expect(other.features).not.toContain("white_label");
  });

  it("counts only a literal true as held", () => {
    for (const answer of [1, "true", "yes", {}, undefined, null]) {
      expect(entitlementsFrom(() => answer as unknown as boolean)).toEqual(FREE);
    }
  });
});

describe("holds", () => {
  it("reads the features the session reported", () => {
    const e = entitlementsFrom((slug) => slug === "private_pages");
    expect(holds(e, "private_pages")).toBe(true);
    expect(holds(e, "white_label")).toBe(false);
    expect(holds(FREE, "scale_builder")).toBe(false);
  });
});
