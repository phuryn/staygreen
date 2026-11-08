import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Landing from "@/app/(public)/page";
import { metadata } from "@/app/(public)/page";
import { COMPANY } from "@/lib/legal";
import { HOME_DESCRIPTION, HOME_TITLE, homeStructuredData, jsonLd } from "@/lib/public-metadata";
import { offers, productLines } from "@/lib/plan-offer";
import { GITHUB_REPO, MAKER } from "@/lib/site-links";
import { SiteFrame } from "@/components/landing/SiteFrame";

type Node = Record<string, unknown> & { "@type": string };
const graph = (url: string) => homeStructuredData(url)!["@graph"] as Node[];
const byType = (nodes: Node[], type: string) => nodes.find(n => n["@type"] === type)!;

// The cards say Builder isn't on sale while `billing` isn't built, so the markup must not offer it.
async function graphWithBilling(billing: boolean) {
  vi.resetModules();
  vi.doMock("@/lib/launch", async (importOriginal) => {
    const real = await importOriginal<typeof import("@/lib/launch")>();
    return { ...real, isBuilt: (area: Parameters<typeof real.isBuilt>[0]) => (area === "billing" ? billing : real.isBuilt(area)) };
  });
  return (await import("@/lib/public-metadata")).homeStructuredData("https://staygreen.io")!;
}

// Off unless a case turns it on, so a shell that exports it can't decide what the hosted cases read.
beforeEach(() => { vi.stubEnv("SELF_HOSTED_PLAN", undefined); });
afterEach(() => { vi.doUnmock("@/lib/launch"); vi.resetModules(); vi.unstubAllEnvs(); });

describe("the homepage's structured data", () => {
  it("names the organisation once and points the site and the product at its @id", () => {
    const nodes = graph("https://staygreen.io");
    expect(nodes.map(n => n["@type"])).toEqual(["Organization", "WebSite", "SoftwareApplication"]);
    const org = byType(nodes, "Organization");
    expect(org).toMatchObject({ "@id": "https://staygreen.io/#organization", name: "Staygreen", url: "https://staygreen.io/", logo: "https://staygreen.io/icon.svg", sameAs: [GITHUB_REPO],
      parentOrganization: { "@type": "Organization", name: COMPANY.name },
      founder: { "@type": "Person", name: MAKER.name, url: MAKER.url, sameAs: [...MAKER.sameAs] } });
    expect(byType(nodes, "WebSite").publisher).toEqual({ "@id": org["@id"] });
    expect(byType(nodes, "SoftwareApplication").publisher).toEqual({ "@id": org["@id"] });
  });

  it("offers each plan on sale at the plan module's monthly price, per month, and describes the product in the page's own words", async () => {
    const app = byType((await graphWithBilling(true))["@graph"] as Node[], "SoftwareApplication");
    expect(app.offers).toEqual([offers.free, offers.builder].map(({ name, monthly }) => ({
      "@type": "Offer", name, price: String(monthly), priceCurrency: "USD", url: "https://staygreen.io/pricing",
      priceSpecification: { "@type": "UnitPriceSpecification", price: String(monthly), priceCurrency: "USD", referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "MON" } },
    })));
    expect(app.description).toBe(HOME_DESCRIPTION);
    expect(app).toMatchObject({ applicationCategory: "DeveloperApplication", operatingSystem: "Web" });
    // The features are the free card's own lines, Stripe and Supabase among them, so the markup lists
    // what the page prints and nothing else; Free's counts and interval aren't the product's, since the
    // same node offers Builder, which raises them (review s52-1).
    expect(app.featureList).toEqual(productLines);
    expect(productLines.every(line => offers.free.lines.includes(line))).toBe(true);
    expect(productLines).toEqual(expect.arrayContaining(["Stripe webhook and Supabase project checks", "A status page on your own domain"]));
    for (const limit of offers.free.lines.filter(line => /\d/.test(line))) expect(JSON.stringify(app)).not.toContain(limit);
  });

  it("offers Free alone while billing isn't built", async () => {
    const app = byType((await graphWithBilling(false))["@graph"] as Node[], "SoftwareApplication");
    expect((app.offers as { name: string }[]).map(o => o.name)).toEqual([offers.free.name]);
  });

  it("builds every address of its own on the host it is served from", () => {
    // The repository and the founder's profiles are the only addresses that aren't its own.
    const own = [GITHUB_REPO, MAKER.url, ...MAKER.sameAs].reduce((s, u) => s.replaceAll(`"${u}"`, '""'), JSON.stringify(graph("https://dev.example.test")));
    expect(own).not.toContain("staygreen.io");
    expect([...own.matchAll(/"(https?:\/\/[^"]+)"/g)].map(m => m[1]).filter(u => u !== "https://schema.org").every(u => u.startsWith("https://dev.example.test/"))).toBe(true);
  });

  // Read off the rendered page, since the page decides whether a block is written at all.
  it("puts one block on the homepage, and none on a self-hosted copy, which sells no plan", () => {
    const blocks = () => renderToStaticMarkup(createElement(Landing)).split('<script type="application/ld+json">').length - 1;
    expect(blocks()).toBe(1);
    vi.stubEnv("SELF_HOSTED_PLAN", "builder");
    expect(blocks()).toBe(0);
  });

  // The markup names a founder only because every public page's footer does, linking the same address.
  it("names the founder the footer names, linking where the footer links", async () => {
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
    const { SiteFrame: Frame } = await import("@/components/landing/SiteFrame");
    const html = renderToStaticMarkup(await Frame({ children: null }));
    expect(html).toContain(`Made by <a href="${MAKER.url}" rel="noreferrer">${MAKER.name}</a>`);
    vi.doUnmock("next/headers");
  });

  // A search for the name alone returned landscaping firms (2026-11-08): the title carries the category.
  it("titles the homepage with the name and the category", () => {
    expect(metadata.title).toEqual({ absolute: HOME_TITLE });
    expect(HOME_TITLE).toMatch(/^Staygreen: uptime monitoring /);
  });

  it("escapes < so no value can close the script tag, and still parses to the same data", () => {
    const data = { name: "</script><script>alert(1)</script>" };
    const out = jsonLd(data);
    expect(out).not.toContain("<");
    expect(JSON.parse(out)).toEqual(data);
  });
});
