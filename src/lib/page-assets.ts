import { z } from "zod";

/* A builder chooses the image they have; the page stores the one it needs (`architecture.md
   § Page images`). The editor's picker decodes the choice in the browser, draws it no larger than
   the box below and re-encodes it (`page-asset-prepare.ts`), so the file that is sent is small and
   carries pixels only. The server trusts none of that: `storablePageAsset` reads what arrived,
   refuses what the picker would never have made, and keeps the pixel chunks and nothing else. */

/** What the picker takes. Only the browser ever holds a file this size. */
export const PAGE_ASSET_UPLOAD_LIMIT = 10 * 1024 * 1024;
export const PAGE_ASSET_TOO_LARGE = "Upload an image no larger than 10 MB.";
/** What the server stores, and the table's own check (009). A resized image is far below it. */
export const PAGE_ASSET_LIMIT = 512 * 1024;
/** More than a browser can be relied on to decode: 8,000 by 5,000 pixels. */
export const PAGE_ASSET_MAX_PIXELS = 40_000_000;
export const pageAssetKind = z.enum(["logo", "favicon"]);
export type PageAssetKind = z.infer<typeof pageAssetKind>;
/** A status page's two slots, and an app's logo, which goes through the same pipeline: chosen in
 *  Settings, or imported from the app's own icon when it is added (`suggestion-checks.ts`). */
export type AssetKind = PageAssetKind | "app";
export type PageAssetMime = "image/png" | "image/jpeg" | "image/webp" | "image/vnd.microsoft.icon";
export type Size = { width: number; height: number };

/** The largest image each slot stores, from where the page shows it, for screens up to 3x: the
 *  logo is 32 px tall and at most 168 px wide in the page header (`.sp-uploaded-logo` in
 *  `src/styles/status.css`), the favicon 16 px in a browser tab, and an app's logo at most 32 px
 *  square beside its name in the dashboard (`.app-logo` in `src/styles/app.css`).
 *  `tests/unit/page-assets.test.ts` holds the logo's box to the stylesheet. */
export const PAGE_ASSET_BOX: Record<AssetKind, Size> = {
  logo: { width: 504, height: 96 },
  favicon: { width: 48, height: 48 },
  app: { width: 96, height: 96 },
};

/** What each slot stores: WebP for a logo, or PNG where a browser can't encode WebP (Safari),
 *  and PNG for a favicon, which every browser takes in a tab. An app's logo is a logo. */
const STORED: Record<AssetKind, readonly PageAssetMime[]> = { logo: ["image/webp", "image/png"], favicon: ["image/png"], app: ["image/webp", "image/png"] };
export const PAGE_ASSET_ID = /^asset_[0-9a-f]{32}$/;
export const pageAssetPath = z.string().regex(/^\/page-assets\/asset_[0-9a-f]{32}$/);

/** A fixed first-party path, never a filename or an address supplied by the uploader. Relative,
 *  so it is served by whichever host serves the page, which the CSP's `img-src 'self'` admits. */
export const assetPath = (id: string) => `/page-assets/${id}`;

/** Byte signatures, not the browser's MIME or extension (WHATWG MIME Sniffing § 6.1).
 * Container bounds reject truncated files too. This is identification, not a pixel decoder:
 * the response's fixed raster MIME, nosniff and sandbox are the execution boundary. */
export function identifyPageAsset(bytes: Uint8Array): PageAssetMime | null {
  const n = bytes.length;
  const match = (at: number, values: number[]) => values.every((v, i) => bytes[at + i] === v);
  const ascii = (at: number, s: string) => match(at, [...s].map((c) => c.charCodeAt(0)));
  const data = new DataView(bytes.buffer, bytes.byteOffset, n);
  if (n >= 45 && match(0, [137, 80, 78, 71, 13, 10, 26, 10])) {
    if (data.getUint32(8) !== 13 || !ascii(12, "IHDR") || !data.getUint32(16) || !data.getUint32(20)) return null;
    let image = false;
    for (let at = 8; at + 12 <= n;) {
      const size = data.getUint32(at);
      if (at + size + 12 > n) return null;
      if (ascii(at + 4, "IDAT") && size > 0) image = true;
      if (ascii(at + 4, "IEND")) return size === 0 && at + 12 === n && image ? "image/png" : null;
      at += size + 12;
    }
  }
  if (n >= 4 && match(0, [255, 216, 255]) && match(n - 2, [255, 217])) return jpegFrame(bytes) ? "image/jpeg" : null;
  if (n >= 26 && ascii(0, "RIFF") && ascii(8, "WEBP") && data.getUint32(4, true) === n - 8) {
    let image = false;
    let at = 12;
    for (; at + 8 <= n;) {
      const size = data.getUint32(at + 4, true);
      if (at + 8 + size > n) return null;
      if ((ascii(at, "VP8 ") && size >= 10) || (ascii(at, "VP8L") && size >= 5) || (ascii(at, "ANMF") && size >= 16)) image = true;
      at += 8 + size + (size % 2);
    }
    if (at === n && image) return "image/webp";
  }
  if (n >= 22 && match(0, [0, 0, 1, 0])) {
    const count = data.getUint16(4, true);
    const end = 6 + count * 16;
    if (!count || end > n) return null;
    for (let i = 6; i < end; i += 16) {
      const size = data.getUint32(i + 8, true), at = data.getUint32(i + 12, true);
      if (size < 40 || at < end || at + size > n) return null;
      // ICO contains PNG or a Windows DIB; cursors (type 2) are deliberately not accepted.
      if (data.getUint32(at, true) !== 40 && !(match(at, [137, 80, 78, 71, 13, 10, 26, 10]) && identifyPageAsset(bytes.subarray(at, at + size)) === "image/png")) return null;
    }
    return "image/vnd.microsoft.icon";
  }
  return null;
}

/** Walk JPEG markers up to the first scan; an SOI/EOI wrapper around text isn't a JPEG. The size
 *  is the frame's, before any EXIF rotation, which swaps the sides but keeps the pixel count. */
function jpegFrame(bytes: Uint8Array): Size | null {
  const n = bytes.length;
  const data = new DataView(bytes.buffer, bytes.byteOffset, n);
  let frame: Size | null = null;
  for (let at = 2; at + 4 < n;) {
    if (bytes[at++] !== 255) return null;
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (at + 2 > n) return null;
    const size = data.getUint16(at);
    if (size < 2 || at + size > n - 2) return null;
    if ([192, 193, 194].includes(marker) && size >= 8 && data.getUint16(at + 3) && data.getUint16(at + 5)) frame = { width: data.getUint16(at + 5), height: data.getUint16(at + 3) };
    if (marker === 218) return frame && size >= 6 ? frame : null;
    at += size;
  }
  return null;
}

const fourcc = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

/** An identified image's size in pixels, from its headers. For a WebP or an ICO it is the largest
 *  any chunk or entry declares, so a small canvas can't vouch for a large frame inside it. Null
 *  when nothing this reads carries a size. */
export function imageSize(bytes: Uint8Array, mime: PageAssetMime): Size | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (mime === "image/png") return { width: data.getUint32(16), height: data.getUint32(20) };
  if (mime === "image/jpeg") return jpegFrame(bytes);
  const sizes: Size[] = [];
  if (mime === "image/vnd.microsoft.icon") {
    // A directory entry stores 256 as 0.
    for (let i = 0; i < data.getUint16(4, true); i++) sizes.push({ width: bytes[6 + i * 16] || 256, height: bytes[7 + i * 16] || 256 });
  }
  const u24 = (i: number) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
  for (let at = 12; mime === "image/webp" && at + 8 <= bytes.length;) {
    const type = fourcc(bytes, at);
    const size = data.getUint32(at + 4, true);
    const body = at + 8;
    if (type === "VP8X" && size >= 10) sizes.push({ width: 1 + u24(body + 4), height: 1 + u24(body + 7) });
    if (type === "VP8 " && size >= 10) sizes.push({ width: data.getUint16(body + 6, true) & 0x3fff, height: data.getUint16(body + 8, true) & 0x3fff });
    if (type === "VP8L" && size >= 5 && bytes[body] === 0x2f) {
      const bits = data.getUint32(body + 1, true);
      sizes.push({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
    }
    at = body + size + (size % 2);
  }
  return sizes.length ? { width: Math.max(...sizes.map((s) => s.width)), height: Math.max(...sizes.map((s) => s.height)) } : null;
}

/** Only to word a refusal, and to send an SVG down the picker's own path. The picker runs this
 *  too, so no Node-only API. */
export const looksLikeSvg = (bytes: Uint8Array) => /<svg[\s>]/i.test(new TextDecoder("latin1").decode(bytes.subarray(0, 4096)));

const NOT_AN_IMAGE: Record<AssetKind, string> = {
  logo: "This file isn't a PNG, JPEG, WebP or SVG image.",
  favicon: "This file isn't a PNG, JPEG, WebP, ICO or SVG image.",
  app: "This file isn't a PNG, JPEG, WebP, ICO or SVG image.",
};
export const PAGE_ASSET_TOO_MANY_PIXELS = "This image is over 40 megapixels. Export it smaller and upload that.";
/** Reaches the server only from a client that skipped the picker, or an editor tab still open
 *  from before uploads were resized. */
export const PAGE_ASSET_UNPREPARED = "This image wasn't resized for the page. Reload the editor and choose it again.";

/** The picker's check of the file a builder chose, before anything decodes it. An app's logo takes
 *  an ICO as well, because the icon an app's own site serves is often one. */
export function checkPageAssetSource(bytes: Uint8Array, kind: AssetKind):
  { ok: true; type: PageAssetMime | "image/svg+xml" } | { ok: false; reason: string } {
  if (bytes.length > PAGE_ASSET_UPLOAD_LIMIT) return { ok: false, reason: PAGE_ASSET_TOO_LARGE };
  const mime = identifyPageAsset(bytes);
  if (!mime) return looksLikeSvg(bytes) ? { ok: true, type: "image/svg+xml" } : { ok: false, reason: NOT_AN_IMAGE[kind] };
  if (mime === "image/vnd.microsoft.icon" && kind === "logo") return { ok: false, reason: "ICO is for favicons. Upload a PNG, JPEG, WebP or SVG logo." };
  const size = imageSize(bytes, mime);
  if (!size || size.width * size.height > PAGE_ASSET_MAX_PIXELS) return { ok: false, reason: PAGE_ASSET_TOO_MANY_PIXELS };
  return { ok: true, type: mime };
}

/** The server's check of what arrived, and the bytes to store. It never decodes: it takes only
 *  the formats the picker makes, within the slot's box, and copies across only the chunks that
 *  hold pixels, so no text, EXIF, XMP, colour profile, gamma, timestamp or animation is stored,
 *  whoever sent the file. An animated WebP is refused rather than cut to a frame. */
export function storablePageAsset(bytes: Uint8Array, kind: AssetKind):
  { ok: true; mime: PageAssetMime; bytes: Uint8Array } | { ok: false; reason: string } {
  const unprepared = { ok: false, reason: PAGE_ASSET_UNPREPARED } as const;
  if (bytes.length > PAGE_ASSET_LIMIT) return unprepared;
  const mime = identifyPageAsset(bytes);
  if (!mime) return looksLikeSvg(bytes) ? unprepared : { ok: false, reason: NOT_AN_IMAGE[kind] };
  const size = imageSize(bytes, mime);
  const box = PAGE_ASSET_BOX[kind];
  if (!STORED[kind].includes(mime) || !size || size.width > box.width || size.height > box.height) return unprepared;
  const pixels = mime === "image/png" ? pngPixels(bytes) : webpPixels(bytes);
  // Identified again, so what is stored is a whole image of the type its row will claim.
  if (!pixels || identifyPageAsset(pixels) !== mime) return unprepared;
  return { ok: true, mime, bytes: pixels };
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (out.set(p, at), at + p.length), 0);
  return out;
};

/** The critical chunks, which are the image, and transparency. Every other ancillary chunk is
 *  dropped, APNG's frames too, which leaves its default image. Chunks are copied whole, so each
 *  keeps its own CRC. */
const PNG_PIXELS = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
function pngPixels(bytes: Uint8Array): Uint8Array {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const parts = [bytes.subarray(0, 8)];
  for (let at = 8; at + 12 <= bytes.length;) {
    const end = at + data.getUint32(at) + 12;
    if (PNG_PIXELS.has(fourcc(bytes, at + 4))) parts.push(bytes.subarray(at, end));
    at = end;
  }
  return concat(parts);
}

/** The image chunks and the alpha that goes with them. VP8X keeps only its alpha flag, so it
 *  never announces a profile, EXIF or XMP that is no longer there. */
const WEBP_PIXELS = new Set(["VP8X", "ALPH", "VP8 ", "VP8L"]);
function webpPixels(bytes: Uint8Array): Uint8Array | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const chunks: Uint8Array[] = [];
  for (let at = 12; at + 8 <= bytes.length;) {
    const type = fourcc(bytes, at);
    const size = data.getUint32(at + 4, true);
    const end = at + 8 + size + (size % 2);
    if (type === "ANIM" || type === "ANMF") return null;
    if (WEBP_PIXELS.has(type)) {
      const chunk = bytes.slice(at, end);
      if (type === "VP8X") chunk[8] &= 0x10;
      chunks.push(chunk);
    }
    at = end;
  }
  const body = concat(chunks);
  const head = new Uint8Array(12);
  head.set([82, 73, 70, 70], 0); // RIFF
  new DataView(head.buffer).setUint32(4, body.length + 4, true);
  head.set([87, 69, 66, 80], 8); // WEBP
  return concat([head, body]);
}

export const faviconOf = (page: { faviconUrl: string | null; logoUrl: string | null }) => page.faviconUrl ?? page.logoUrl ?? "/icon.svg";
