import { checkPageAssetSource, PAGE_ASSET_BOX, PAGE_ASSET_TOO_LARGE, PAGE_ASSET_UPLOAD_LIMIT, type AssetKind, type Size } from "./page-assets";

/* The browser half of an upload (`architecture.md § Page images`): the image a builder chose,
   up to 10 MB, becomes the one the page stores, and only that leaves the browser. A 10 MB file
   can't be sent as it is: a Server Action takes 1 MB by default and a Netlify Function's request
   6 MB. What is sent here is at most the slot's box (`PAGE_ASSET_BOX`), a few kilobytes to a few
   hundred, and the server checks it again on arrival (`storablePageAsset`).

   Everything goes through a canvas: decoded, drawn at its new size, encoded afresh. Only pixels
   cross a canvas, so no EXIF, location, comment, colour profile or animation of the original
   survives. Orientation is applied first, so a phone photo stays the right way up, and the
   browser converts the original's colour profile to sRGB as it draws.

   An SVG is drawn the same way, as an image: a browser renders an SVG in an <img> with scripting
   off and fetches nothing it references (SVG Integration § 3, secure static mode), so neither
   its script nor its links ever run, here or anywhere, and only the pixels are stored. It is
   parsed first, inertly, only to give it a size: a parsed document has no browsing context, so
   nothing in it runs or loads, and an external DTD or entity is never fetched.

   Browser-only: it touches the DOM, and is called from the picker's change handler. */

export const PAGE_ASSET_UNREADABLE = "The image couldn't be read. Choose it again.";
export const SVG_UNREADABLE = "This SVG couldn't be turned into an image. Export it as a PNG and upload that.";

type Prepared = { ok: true; file: File } | { ok: false; reason: string };

export async function preparePageAsset(file: File, kind: AssetKind): Promise<Prepared> {
  if (file.size > PAGE_ASSET_UPLOAD_LIMIT) return { ok: false, reason: PAGE_ASSET_TOO_LARGE };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const source = checkPageAssetSource(bytes, kind);
  if (!source.ok) return source;
  const box = PAGE_ASSET_BOX[kind];

  let drawn: HTMLCanvasElement | null;
  if (source.type === "image/svg+xml") {
    drawn = await fromSvg(bytes, box);
    if (!drawn) return { ok: false, reason: SVG_UNREADABLE };
  } else {
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      return { ok: false, reason: PAGE_ASSET_UNREADABLE };
    }
    try {
      drawn = scaled(bitmap, { width: bitmap.width, height: bitmap.height }, fit({ width: bitmap.width, height: bitmap.height }, box, false));
    } finally {
      bitmap.close();
    }
  }

  // A tab draws a square, and so does the dashboard beside an app's name.
  const out = kind === "logo" ? drawn : squared(drawn);
  // Where a browser can't encode WebP it hands back a PNG instead, which a logo also takes.
  const webp = kind !== "favicon" ? await encode(out, "image/webp", 0.92) : null;
  const blob = webp?.type === "image/webp" ? webp : await encode(out, "image/png");
  if (!blob) return { ok: false, reason: source.type === "image/svg+xml" ? SVG_UNREADABLE : PAGE_ASSET_UNREADABLE };
  return { ok: true, file: new File([blob], `${kind}.${blob.type === "image/webp" ? "webp" : "png"}`, { type: blob.type }) };
}

/** An app's logo as `uploadAppLogo` takes it: the image in the app's box and, beside it, the same
 *  original as a 48 px PNG favicon, which a new status page for the app takes as its tab icon
 *  (`addPage`). Both are made here, from the original, because the server never resizes an image
 *  (`architecture.md § Page images`). A favicon that can't be made leaves the logo without one,
 *  and a page made from it falls back to its logo in the tab, as any page without a favicon does. */
export async function appLogoForm(file: File): Promise<{ ok: true; form: FormData } | { ok: false; reason: string }> {
  const logo = await preparePageAsset(file, "app");
  if (!logo.ok) return logo;
  const form = new FormData();
  form.set("file", logo.file);
  const tab = await preparePageAsset(file, "favicon").catch(() => null);
  if (tab?.ok) form.set("favicon", tab.file);
  return { ok: true, form };
}

/** `from` scaled to fit `box`, keeping its shape; never larger than it is unless it is vector. */
export function fit(from: Size, box: Size, enlarge: boolean): Size {
  const scale = Math.min(box.width / from.width, box.height / from.height, enlarge ? Infinity : 1);
  return {
    width: Math.min(box.width, Math.max(1, Math.round(from.width * scale))),
    height: Math.min(box.height, Math.max(1, Math.round(from.height * scale))),
  };
}

function canvasOf(size: Size): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size.width;
  c.height = size.height;
  return c;
}

function paint(into: HTMLCanvasElement, from: CanvasImageSource, at: Size & { x?: number; y?: number } = { width: into.width, height: into.height }) {
  const ctx = into.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(from, at.x ?? 0, at.y ?? 0, at.width, at.height);
}

/** Halves the image until one more halving would pass the target, then draws the target. One
 *  large step would sample only some of the source's pixels and alias; halving reads them all. */
function scaled(source: CanvasImageSource, from: Size, to: Size): HTMLCanvasElement {
  let current: CanvasImageSource = source;
  let size = from;
  while (size.width >= to.width * 2 && size.height >= to.height * 2) {
    const half = canvasOf({ width: Math.ceil(size.width / 2), height: Math.ceil(size.height / 2) });
    paint(half, current);
    current = half;
    size = half;
  }
  const out = canvasOf(to);
  paint(out, current);
  return out;
}

/** Centred on a transparent square, for a slot drawn square: a favicon, an app's logo. */
function squared(c: HTMLCanvasElement): HTMLCanvasElement {
  const side = Math.max(c.width, c.height);
  if (c.width === c.height) return c;
  const out = canvasOf({ width: side, height: side });
  paint(out, c, { x: Math.round((side - c.width) / 2), y: Math.round((side - c.height) / 2), width: c.width, height: c.height });
  return out;
}

/** A canvas a browser refuses to export, such as one an SVG's foreign content tainted, is no image. */
function encode(c: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      c.toBlob(resolve, type, quality);
    } catch {
      resolve(null);
    }
  });
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The size an SVG draws at: its viewBox, else a width and height in pixels. */
function svgSize(root: Element): Size | null {
  const view = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (view.length === 4 && view.every(Number.isFinite) && view[2] > 0 && view[3] > 0) return { width: view[2], height: view[3] };
  const px = (v: string | null) => {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/.exec(v ?? "");
    return m && Number(m[1]) > 0 ? Number(m[1]) : null;
  };
  const width = px(root.getAttribute("width"));
  const height = px(root.getAttribute("height"));
  return width && height ? { width, height } : null;
}

async function fromSvg(bytes: Uint8Array, box: Size): Promise<HTMLCanvasElement | null> {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "image/svg+xml");
  const root = doc.documentElement;
  if (doc.getElementsByTagName("parsererror").length || root.namespaceURI !== SVG_NS || root.localName !== "svg") return null;
  const size = svgSize(root);
  if (!size) return null;
  // Vector, so it is drawn at the full box; the viewBox keeps the drawing inside it.
  const to = fit(size, box, true);
  if (!root.hasAttribute("viewBox")) root.setAttribute("viewBox", `0 0 ${size.width} ${size.height}`);
  root.setAttribute("width", String(to.width));
  root.setAttribute("height", String(to.height));
  // A data: address, which the dashboard's CSP admits for images (`img-src 'self' data:`).
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const out = canvasOf(to);
  paint(out, img);
  return out;
}
