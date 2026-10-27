import { z } from "zod";
import { snapshotDto, viewFromDto } from "../src/lib/public-page";
import { badgeFor } from "../src/lib/badge";
import { summaryFor } from "../src/lib/status-summary";
import { domainSchema } from "../src/lib/domain-input";
import { renderPage } from "./render";
import { POLL_MS, edgeSchema } from "./config";

const entrySchema = z.object({ pageId: z.string().min(1).max(128), snapshot: snapshotDto, version: z.number().int().nonnegative(),
  domain: domainSchema.nullable(),
  assets: z.array(z.object({ id: z.string().regex(/^asset_[a-f0-9]{32}$/),
    mime: z.enum(["image/png", "image/webp", "image/jpeg", "image/vnd.microsoft.icon"]), content: z.string().max(720_000) })).max(2),
});
type Entry = { fingerprint: string; html: string; summary: string; badge: string; domain: string | null;
  assets: Map<string, { mime: string; bytes: Buffer }> };
export type Reply = { status: number; headers: Record<string, string>; body: string | Buffer };
const policy = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
const headers = { "Content-Security-Policy": policy, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
export const pageUrls = (slug: string, host = edgeSchema.shape.EDGE_STATUS_HOST.parse(undefined)) => [`https://${host}/${slug}`, `https://${host}/${slug}/summary.json`, `https://${host}/${slug}/badge.svg`];

/** Refresh is atomic: a broken/incomplete feed never replaces the last complete snapshot.
 * Deletions and newly private pages are removed before any purge is attempted. Purge retries
 * retain only URLs, never a withdrawn snapshot. A restart does not restore an old disk copy. */
export class EdgeCache {
  constructor(readonly statusHost = edgeSchema.shape.EDGE_STATUS_HOST.parse(undefined)) {}
  private pages = new Map<string, Entry>();
  private domains = new Map<string, string>();
  readonly pendingPurge = new Map<string, number>();
  private purgeVersion = 0;
  private queue(url: string) { this.pendingPurge.set(url, ++this.purgeVersion); }
  // Versions belong to a page id. A new page on a freed slug has its own version sequence
  // and must not inherit the old page's fence.
  private withdrawn = new Map<string, number>();
  refreshedAt = 0;
  loaded = false;
  replace(rows: unknown[], now: number) {
    const next = new Map<string, Entry>();
    const domains = new Map<string, string>();
    const changed = new Set<string>();
    for (const row of rows) {
      const parsed = entrySchema.parse(row);
      const slug = parsed.snapshot.page.slug;
      if (parsed.version <= (this.withdrawn.get(parsed.pageId) ?? -1)) continue;
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug) || next.has(slug)) throw new Error("Invalid edge feed");
      const fingerprint = JSON.stringify(parsed) + new Date(now).toISOString().slice(0, 10);
      const previous = this.pages.get(slug);
      if (previous?.fingerprint === fingerprint) next.set(slug, previous);
      else {
        const view = viewFromDto(parsed.snapshot, now);
        const paths = new Set([view.page.logoUrl, view.page.faviconUrl]);
        const assets = new Map(parsed.assets.filter(a => paths.has(`/page-assets/${a.id}`))
          .map(a => [`/page-assets/${a.id}`, { mime: a.mime, bytes: Buffer.from(a.content, "base64") }]));
        next.set(slug, { fingerprint, html: renderPage(view), summary: JSON.stringify(summaryFor(view)),
          badge: badgeFor(view).svg, domain: parsed.domain, assets });
        changed.add(slug);
      }
      if (parsed.domain) {
        if (domains.has(parsed.domain)) throw new Error("Duplicate edge domain");
        domains.set(parsed.domain, slug);
      }
    }
    for (const [slug, old] of this.pages) if (!next.has(slug)) {
      changed.add(slug);
      for (const path of old.assets.keys()) this.queue(`https://${this.statusHost}${path}`);
    }
    for (const slug of changed) {
      for (const url of pageUrls(slug, this.statusHost)) this.queue(url);
      for (const path of this.pages.get(slug)?.assets.keys() ?? []) this.queue(`https://${this.statusHost}${path}`);
    }
    this.pages = next; this.domains = domains; this.refreshedAt = now; this.loaded = true;
  }

  withdraw(pageId: string, slug: string, version: number) {
    this.withdrawn.set(pageId, Math.max(version, this.withdrawn.get(pageId) ?? -1));
    const page = this.pages.get(slug);
    if (page?.domain) this.domains.delete(page.domain);
    for (const path of page?.assets.keys() ?? []) this.queue(`https://${this.statusHost}${path}`);
    this.pages.delete(slug);
    for (const url of pageUrls(slug, this.statusHost)) this.queue(url);
  }

  respond(host: string, rawPath: string, now: number): Reply {
    const fail = (status: number, body = "Not found"): Reply => ({ status, headers: { ...headers, "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }, body });
    // Only the canonical URL is cacheable/purgeable. Reject query/path variants rather than
    // creating an unbounded family of cache keys a URL purge cannot enumerate.
    if (rawPath.includes("?") || rawPath.includes("%") || rawPath.includes("\\")) return fail(404);
    const custom = host !== this.statusHost;
    const mapped = this.domains.get(host);
    if (custom && !mapped) return fail(404);
    if (!this.loaded) return fail(503, "Status is temporarily unavailable");
    const match = /^\/([a-z0-9-]+)(?:\/(summary\.json|badge\.svg))?$/.exec(rawPath);
    const slug = custom ? mapped : match?.[1];
    const page = slug ? this.pages.get(slug) : undefined;
    const asset = rawPath.startsWith("/page-assets/") ? (custom ? page?.assets.get(rawPath) :
      [...this.pages.values()].map(p => p.assets.get(rawPath)).find(Boolean)) : undefined;
    if (asset) return { status: 200, headers: { ...headers, "Content-Type": asset.mime, "Cache-Control": "no-store" }, body: asset.bytes };
    if (!page) return fail(404);
    const piece = custom ? ({ "/": "html", "/summary.json": "summary.json", "/badge.svg": "badge.svg" } as Record<string, string>)[rawPath] : match?.[2] ?? "html";
    if (!piece) return fail(404);
    const stale = now - this.refreshedAt > POLL_MS * 2;
    const body = piece === "summary.json" ? page.summary : piece === "badge.svg" ? page.badge :
      page.html.replace('<div class="edge-freshness" role="status">__STAYGREEN_FRESHNESS__</div>',
        `<div class="edge-freshness" role="status">${stale ? `Updated ${Math.floor((now - this.refreshedAt) / 60_000)} minutes ago. Updates are temporarily unavailable.` : ""}</div>`);
    return { status: 200, body, headers: { ...headers,
      "Content-Type": piece === "summary.json" ? "application/json" : piece === "badge.svg" ? "image/svg+xml" : "text/html; charset=utf-8",
      // Customer hosts are DNS-only. No browser/proxy cache survives a removed domain mapping.
      "Cache-Control": stale || custom ? "no-store" : "public, max-age=0, s-maxage=30, stale-while-revalidate=300",
      ...(piece === "summary.json" ? { "Access-Control-Allow-Origin": "*" } : {}),
    } };
  }
}
