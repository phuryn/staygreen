import type { Metadata, MetadataRoute } from "next";

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
