import { statusHost } from "@/lib/status-host";
import { badgeFor } from "@/lib/badge";
import { loadPublicView } from "@/lib/public-data";

export const dynamic = "force-dynamic";

/* This long-lived README address stays sessionless. The public SQL read refuses private and
   withdrawn pages even for a member. After edge activation it redirects without caching the
   redirect; beforehand it serves the same SVG uncached, so a privacy change is not held here. */

const headers = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const view = await loadPublicView((await params).slug);
  if (!view) return new Response(null, { status: 404, headers: { ...headers, "Cache-Control": "no-store" } });
  if (process.env.STATUS_EDGE_ENABLED === "on") return new Response(null, { status: 307,
    headers: { ...headers, "Location": `https://${statusHost()}/${view.page.slug}/badge.svg`, "Cache-Control": "no-store" } });
  return new Response(badgeFor(view).svg, { headers: { ...headers, "Content-Type": "image/svg+xml", "Cache-Control": "no-store" } });
}
