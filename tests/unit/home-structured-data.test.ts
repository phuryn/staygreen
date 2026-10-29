import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Landing from "@/app/(public)/page";
import { HOME_DESCRIPTION, homeStructuredData, jsonLd } from "@/lib/public-metadata";
import { offers } from "@/lib/plan-offer";
import { GITHUB_REPO } from "@/lib/site-links";

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
    expect(org).toMatchObject({ "@id": "https://staygreen.io/#organization", name: "Staygreen", url: "https://staygreen.io/", logo: "https://staygreen.io/icon.svg", sameAs: [GITHUB_REPO] });
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
  });

  it("offers Free alone while billing isn't built", async () => {
    const app = byType((await graphWithBilling(false))["@graph"] as Node[], "SoftwareApplication");
    expect((app.offers as { name: string }[]).map(o => o.name)).toEqual([offers.free.name]);
  });

  it("builds every address of its own on the host it is served from", () => {
    const own = JSON.stringify(graph("https://dev.example.test")).replaceAll(GITHUB_REPO, "");
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

  it("escapes < so no value can close the script tag, and still parses to the same data", () => {
    const data = { name: "</script><script>alert(1)</script>" };
    const out = jsonLd(data);
    expect(out).not.toContain("<");
    expect(JSON.parse(out)).toEqual(data);
  });
});
