import { identifyPageAsset, PAGE_ASSET_LIMIT } from "./page-assets";

/** Applied even to errors, which are never cached. No uploaded filename, HTML, redirect or session participates.
 * sandbox without allow-scripts/allow-same-origin also isolates a direct navigation. */
const headers = {
  "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Frame-Options": "DENY",
};

export function pageAssetResponse(asset: { content: string; mime: string } | null): Response {
  if (!asset || asset.content.length > PAGE_ASSET_LIMIT * 2 + 2 || !/^\\x(?:[0-9a-f]{2})+$/i.test(asset.content)) {
    return new Response(null, { status: 404, headers });
  }
  const bytes = Buffer.from(asset.content.slice(2), "hex");
  // Check again on read: even a corrupt row must never choose its own response MIME.
  const mime = identifyPageAsset(bytes);
  if (!mime || mime !== asset.mime) return new Response(null, { status: 404, headers });
  // An address is never reused: a new upload gets a new one, so what is served here never changes,
  // and a cached copy keeps Postgres out of a busy status page's every view.
  return new Response(bytes, { headers: { ...headers, "Cache-Control": "public, max-age=31536000, immutable", "Content-Type": mime, "Content-Length": String(bytes.length) } });
}
