import { baseOf, resolvedUrl, tagsOf } from "./html-read";
import { PAGE_ASSET_BOX } from "./page-assets";

/* Finding an app's icon in its own page (`docs/flows.md § Suggested checks`), so a new app starts
   with its logo and a new status page with its favicon and header logo. Pure: it reads HTML and
   a web app manifest the suggestion run already fetched and returns addresses; the fetching,
   through the probes' guard, is `suggestion-checks.ts`.

   What is read is a page someone else wrote, so nothing here trusts it beyond picking addresses:
   no script runs, nothing is fetched here, and only http, https and data addresses come back. */

/** The largest side any slot stores an icon at: the app's logo and a page's header logo are
 *  96 px tall (32 px at 3×), the favicon 48 (`PAGE_ASSET_BOX`). A larger icon draws no sharper
 *  in any of them; it only costs more to fetch. */
export const ICON_SIDE = Math.max(PAGE_ASSET_BOX.app.width, PAGE_ASSET_BOX.logo.height, PAGE_ASSET_BOX.favicon.width);

/** An icon a manifest lists (W3C Web App Manifest § icons). */
export type ManifestIcon = { src: string; sizes?: string; type?: string; purpose?: string };

type Found = { url: string; score: number; at: number };

/** The sides a `sizes` attribute names, and whether it says `any` (a vector). Only squares
 *  count: a logo slot that is square, or a header that is 96 px tall, would draw a wide icon
 *  smaller than it says. */
function squareSide(sizes: string | undefined): number | "any" | null {
  if (!sizes) return null;
  if (/\bany\b/i.test(sizes)) return "any";
  const sides = [...sizes.matchAll(/(\d+)\s*x\s*(\d+)/gi)].filter((m) => m[1] === m[2]).map((m) => Number(m[1]));
  return sides.length ? Math.max(...sides) : sizes.trim() ? 0 : null;
}

/* Best is the icon that draws sharpest at `ICON_SIDE` for the fewest bytes:
   1. a vector, which draws sharp at any size;
   2. the smallest square raster that fills `ICON_SIDE`, then the larger ones;
   3. the largest raster under it;
   4. an icon that names no size, which is usually a 16 or 32 px ICO.
   An apple-touch-icon that names no size is 180 px, the size iOS asks for. */
function score(side: number | "any" | null, vector: boolean, touch: boolean): number {
  if (vector || side === "any") return 10_000;
  const px = typeof side === "number" && side > 0 ? side : touch && side === null ? 180 : 0;
  if (px >= ICON_SIDE) return 5_000 - Math.min(px, 4_096) / 2;
  return px > 0 ? 1_000 + px : 100;
}

const isVector = (url: string, type: string) => type === "image/svg+xml" || /\.svg(?:$|[?#])/i.test(url) || /^data:image\/svg\+xml/i.test(url);

/** The icons a manifest lists, as candidates. A monochrome icon is one colour on purpose, so it
 *  is never the app's logo; a maskable one is full-bleed with its drawing inside a safe zone, so
 *  it ranks below an ordinary icon of the same size. */
export function manifestIcons(icons: readonly ManifestIcon[], manifestUrl: string): { url: string; score: number }[] {
  const out: { url: string; score: number }[] = [];
  for (const icon of icons.slice(0, 50)) {
    if (typeof icon?.src !== "string") continue;
    const purposes = (typeof icon.purpose === "string" ? icon.purpose : "any").toLowerCase().split(/\s+/).filter(Boolean);
    if (!purposes.includes("any") && !purposes.includes("maskable")) continue;
    const url = resolvedUrl(icon.src, manifestUrl, true);
    if (!url) continue;
    const side = squareSide(typeof icon.sizes === "string" ? icon.sizes : undefined);
    if (side === 0) continue;
    const s = score(side, isVector(url, String(icon.type ?? "").toLowerCase()), false);
    out.push({ url, score: purposes.includes("any") ? s : s - 300 });
  }
  return out;
}

/** The icons a page names and its manifest lists, best first, then `/favicon.ico` on its origin,
 *  which browsers and crawlers ask for by convention when a page names none. A mask icon is one
 *  colour on purpose, so it is never the app's logo. */
export function iconCandidates(html: string, pageUrl: string, fromManifest: readonly { url: string; score: number }[] = []): string[] {
  const base = baseOf(html, pageUrl);
  const found: Found[] = [];
  for (const a of tagsOf(html, "link")) {
    const rel = (a.get("rel") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const touch = rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed");
    if (!touch && !rel.includes("icon")) continue;
    const url = resolvedUrl(a.get("href") ?? "", base, true);
    if (!url) continue;
    const side = squareSide(a.get("sizes"));
    if (side === 0) continue;
    found.push({ url, score: score(side, isVector(url, (a.get("type") ?? "").toLowerCase()), touch), at: found.length });
  }
  for (const m of fromManifest) found.push({ ...m, at: found.length });
  const ordered = found.sort((x, y) => y.score - x.score || x.at - y.at).map((c) => c.url);
  let fallback: string | null = null;
  try {
    fallback = new URL("/favicon.ico", pageUrl).href;
  } catch {
    fallback = null;
  }
  return [...new Set([...ordered, ...(fallback ? [fallback] : [])])];
}

/** The page's web app manifest, when it links one. */
export function manifestHref(html: string, pageUrl: string): string | null {
  const base = baseOf(html, pageUrl);
  for (const a of tagsOf(html, "link")) {
    if ((a.get("rel") ?? "").toLowerCase().split(/\s+/).includes("manifest")) return resolvedUrl(a.get("href") ?? "", base);
  }
  return null;
}

/** A `data:` icon's bytes, or null: base64, or percent-encoded text such as an inline SVG. */
export function dataUrlBytes(url: string, max: number): Uint8Array | null {
  const m = /^data:(image\/[a-z0-9.+-]+)?((?:;[^,;]*)*?)(;base64)?,(.*)$/is.exec(url);
  if (!m) return null;
  try {
    const bytes = m[3] ? Uint8Array.from(Buffer.from(m[4], "base64")) : new TextEncoder().encode(decodeURIComponent(m[4]));
    return bytes.length && bytes.length <= max ? bytes : null;
  } catch {
    return null;
  }
}
