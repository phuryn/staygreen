import type { Metadata, MetadataRoute } from "next";
import { isBuilt } from "./launch";
import { COMPANY } from "./legal";
import { offers, productLines, type Offer } from "./plan-offer";
import { selfHostedPlanEnabled } from "./self-hosted-plan";
import { GITHUB_REPO, MAKER } from "./site-links";

export const INDEXED_PATHS = ["/", "/pricing", "/scan", "/bot", "/legal/terms", "/legal/privacy"] as const;

// The env schema requires APP_URL on a configured host. Keyless local builds still
// need a base, and must never inherit production's indexing or image addresses.
export function metadataBase(appUrl = process.env.APP_URL): URL {
  return new URL(appUrl ?? "http://localhost:3000");
}

export function isIndexableSite(appUrl = process.env.APP_URL): boolean {
  return metadataBase(appUrl).origin === "https://staygreen.io";
}

// Only the six public pages call this. The root keeps noindex so new routes,
// member pages, token links and status surfaces retain their existing boundary.
export function publicPageMetadata(path: typeof INDEXED_PATHS[number], appUrl = process.env.APP_URL): Metadata {
  const index = isIndexableSite(appUrl);
  return { alternates: { canonical: path }, robots: { index, follow: index } };
}

export function siteRobots(appUrl = process.env.APP_URL): MetadataRoute.Robots {
  if (!isIndexableSite(appUrl)) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: {
      userAgent: "*",
      allow: [...INDEXED_PATHS],
      disallow: ["/app", "/api", "/mcp", "/sign-in", "/sign-up", "/alerts", "/unsubscribe"],
    },
    sitemap: new URL("/sitemap.xml", metadataBase(appUrl)).href,
  };
}

export function siteSitemap(appUrl = process.env.APP_URL): MetadataRoute.Sitemap {
  return isIndexableSite(appUrl)
    ? INDEXED_PATHS.map((path) => ({ url: new URL(path, metadataBase(appUrl)).href }))
    : [];
}

// "Staygreen" alone is a landscaping company to a search engine (US results for `staygreen`,
// `staygreen monitoring` and even `staygreen.io` held no staygreen.io page on 2026-11-08), so the
// homepage's title names the category beside the name.
export const HOME_TITLE = "Staygreen: uptime monitoring for apps you built yourself";

export const HOME_DESCRIPTION = "Uptime checks that read what your app returns, heartbeats for your crons, Stripe webhook failures, a paused Supabase project, SSL and domain expiry, a status page on your domain, and an MCP server for your coding agent.";

// The homepage's structured data: the organisation, the site, and the product with an offer for
// each plan its cards sell, at the monthly price the cards print from the same module
// (`plan-offer.ts`), so the markup can't state a price the page doesn't. Builder is offered only
// while `billing` is built, the switch its card reads to say it isn't on sale yet. The price is
// per month (`referenceQuantity`), not for a month: `billingDuration` would read as a term, which
// no plan has. The organisation's one other home the site links is the repository, in the footer.
// The company behind it is the one the legal pages name (`legal.ts`), its founder the maker every
// public page's footer names (`site-links.ts`), and the product's features are the free card's
// own lines that hold on every plan, its counts and interval left out (`productLines`,
// `plan-offer.ts`): nothing here says what no page shows, or what only one plan gets.
// A self-hosted copy (`SELF_HOSTED_PLAN`) gets none: it sells no plan, and an operator reviewing
// the page's copy can't see markup. A copy that sets no plan serves what its own cards print.
export function homeStructuredData(appUrl = process.env.APP_URL) {
  if (selfHostedPlanEnabled()) return null;
  const at = (path: string) => new URL(path, metadataBase(appUrl)).href;
  const organization = at("/#organization");
  const offer = ({ name, monthly }: Offer) => {
    const price = { price: String(monthly), priceCurrency: "USD" };
    return { "@type": "Offer", name, ...price, url: at("/pricing"), priceSpecification: { "@type": "UnitPriceSpecification", ...price, referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "MON" } } };
  };
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": organization, name: "Staygreen", url: at("/"), logo: at("/icon.svg"), sameAs: [GITHUB_REPO],
        parentOrganization: { "@type": "Organization", name: COMPANY.name },
        founder: { "@type": "Person", name: MAKER.name, url: MAKER.url, sameAs: [...MAKER.sameAs] } },
      { "@type": "WebSite", "@id": at("/#website"), name: "Staygreen", url: at("/"), description: HOME_DESCRIPTION, publisher: { "@id": organization } },
      {
        "@type": "SoftwareApplication", "@id": at("/#software"), name: "Staygreen", url: at("/"), description: HOME_DESCRIPTION,
        applicationCategory: "DeveloperApplication", operatingSystem: "Web", publisher: { "@id": organization },
        featureList: productLines,
        offers: [offers.free, ...(isBuilt("billing") ? [offers.builder] : [])].map(offer),
      },
    ],
  };
}

/** JSON for a `<script type="application/ld+json">`: `<` escaped so no value can close the tag. */
export const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");
