import { inflateSync } from "node:zlib";
import { isBrandColour, parseColour } from "./colour";
import { identifyPageAsset, looksLikeSvg } from "./page-assets";

/* The main saturated colour of a site's icon, one of the candidates for its status page's accent
   (`brand.ts`). Read on the server, from the icon the suggestion run already fetched, because the
   accent is chosen there, beside the other candidates and in the one model call a run makes.

   This is the one place the server reads an image's pixels, and only to count them: nothing here
   is stored, resized or sent anywhere, and the image the app keeps still goes through the
   browser's canvas (`architecture.md § Page images`). Plain TypeScript over `node:zlib`, with
   every size checked before it is used, so a hostile file can cost at most `MAX_PIXELS` pixels of
   memory and time, and a malformed one returns null:

   - **PNG**, and a PNG inside an ICO: 8-bit and 16-bit, greyscale, RGB, palette (1 to 8 bits) and
     their alpha forms, not interlaced. Inflated with a ceiling of exactly the bytes the header
     promises, so a compression bomb stops at that size.
   - **ICO** with a bitmap inside: 32-bit and 24-bit.
   - **SVG**: its fill, stroke and stop colours as written, counted by how often each appears,
     since an SVG is never rendered here.
   - JPEG and WebP icons have no colour read; a site's icon is rarely either. */

/** 1,024 by 1,024: an icon larger than this is cut by the fetch anyway (`PAGE_ASSET_LIMIT`). */
const MAX_PIXELS = 1024 * 1024;
/** Opaque enough that the pixel is the icon and not its anti-aliased edge. */
const OPAQUE = 200;
/** The colour must cover this share of the icon's opaque pixels to be its colour. */
const MIN_SHARE = 0.08;

type Pixels = { width: number; height: number; rgba: Uint8Array };

export function dominantColour(bytes: Uint8Array): string | null {
  try {
    const mime = identifyPageAsset(bytes);
    if (mime === "image/png") return fromPixels(decodePng(bytes));
    if (mime === "image/vnd.microsoft.icon") return fromPixels(decodeIco(bytes));
    if (!mime && looksLikeSvg(bytes)) return fromSvg(new TextDecoder().decode(bytes.subarray(0, 256 * 1024)));
    return null;
  } catch {
    return null;
  }
}

/** The most common brand-coloured bin of opaque pixels, as its average: 4 bits a channel, so
 *  the anti-aliased steps of one flat colour fall into its bin or a neighbour's. */
function fromPixels(p: Pixels | null): string | null {
  if (!p) return null;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  let opaque = 0;
  const step = Math.max(1, Math.floor((p.width * p.height) / 65_536));
  for (let i = 0; i < p.width * p.height; i += step) {
    const at = i * 4;
    if (p.rgba[at + 3] < OPAQUE) continue;
    opaque++;
    const [r, g, b] = [p.rgba[at], p.rgba[at + 1], p.rgba[at + 2]];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += r;
    bin.g += g;
    bin.b += b;
    bins.set(key, bin);
  }
  let best: { hex: string; n: number } | null = null;
  for (const bin of bins.values()) {
    const hex = `#${[bin.r, bin.g, bin.b].map((c) => Math.round(c / bin.n).toString(16).padStart(2, "0")).join("")}`;
    if (!isBrandColour(hex) || (best && bin.n <= best.n)) continue;
    best = { hex, n: bin.n };
  }
  return best && opaque > 0 && best.n / opaque >= MIN_SHARE ? best.hex : null;
}

function fromSvg(text: string): string | null {
  const counts = new Map<string, number>();
  const re = /(?:fill|stroke|stop-color|color)\s*(?:=\s*["']|:\s*)([^"';}>]+)/gi;
  for (const m of text.matchAll(re)) {
    const hex = parseColour(m[1]);
    if (hex && isBrandColour(hex)) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best?.[0] ?? null;
}

// ── PNG (ISO/IEC 15948) ────────────────────────────────────────────────────

function decodePng(bytes: Uint8Array): Pixels | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const ascii = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const width = data.getUint32(16);
  const height = data.getUint32(20);
  const depth = bytes[24];
  const colour = bytes[25];
  const interlace = bytes[28];
  if (!width || !height || width * height > MAX_PIXELS || interlace !== 0) return null;
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && colour !== 0 && colour !== 3) || (depth === 16 && colour === 3)) return null;

  let palette: Uint8Array | null = null;
  let alphas: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = data.getUint32(at);
    const type = ascii(at + 4);
    const body = bytes.subarray(at + 8, at + 8 + size);
    if (type === "PLTE") palette = body;
    if (type === "tRNS") alphas = body;
    if (type === "IDAT") idat.push(body);
    if (type === "IEND") break;
    at += size + 12;
  }
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const expected = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  if (raw.length < expected) return null;

  const bpp = Math.max(1, bitsPerPixel >> 3);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = out.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= bpp ? up[x - bpp] : 0;
      const v = line[x];
      if (filter === 0) row[x] = v;
      else if (filter === 1) row[x] = v + a;
      else if (filter === 2) row[x] = v + b;
      else if (filter === 3) row[x] = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        row[x] = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else return null;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const sample = (y: number, i: number): number => {
    // The i-th sample of row y, scaled to 8 bits.
    const row = y * stride;
    if (depth === 8) return out[row + i];
    if (depth === 16) return out[row + i * 2];
    const perByte = 8 / depth;
    const v = (out[row + Math.floor(i / perByte)] >> (8 - depth * ((i % perByte) + 1))) & ((1 << depth) - 1);
    return colour === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = (k: number) => sample(y, x * channels + k);
      if (colour === 3) {
        const index = s(0);
        if (!palette || index * 3 + 2 >= palette.length) return null;
        rgba.set([palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2], alphas && index < alphas.length ? alphas[index] : 255], o);
      } else if (colour === 0 || colour === 4) {
        const g = s(0);
        rgba.set([g, g, g, colour === 4 ? s(1) : 255], o);
      } else {
        rgba.set([s(0), s(1), s(2), colour === 6 ? s(3) : 255], o);
      }
    }
  }
  return { width, height, rgba };
}

// ── ICO ────────────────────────────────────────────────────────────────────

/** The largest image an ICO holds: a PNG, or a 32- or 24-bit bitmap. `identifyPageAsset` has
 *  already checked the directory's bounds. */
function decodeIco(bytes: Uint8Array): Pixels | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const count = data.getUint16(4, true);
  let best: { side: number; at: number; size: number } | null = null;
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const side = (bytes[e] || 256) * (bytes[e + 1] || 256);
    if (!best || side > best.side) best = { side, at: data.getUint32(e + 12, true), size: data.getUint32(e + 8, true) };
  }
  if (!best) return null;
  const image = bytes.subarray(best.at, best.at + best.size);
  if (identifyPageAsset(image) === "image/png") return decodePng(image);
  const d = new DataView(image.buffer, image.byteOffset, image.length);
  if (image.length < 40 || d.getUint32(0, true) !== 40) return null;
  const width = d.getInt32(4, true);
  const height = Math.abs(d.getInt32(8, true)) / 2; // the colour bitmap, then the AND mask
  const bits = d.getUint16(14, true);
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS || (bits !== 32 && bits !== 24) || d.getUint32(16, true) !== 0) return null;
  const stride = Math.ceil((width * bits) / 32) * 4;
  if (40 + stride * height > image.length) return null;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    // Bottom-up rows, blue first.
    const row = 40 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const p = row + x * (bits / 8);
      rgba.set([image[p + 2], image[p + 1], image[p], bits === 32 ? image[p + 3] : 255], (y * width + x) * 4);
    }
  }
  // An older 32-bit icon leaves its alpha at zero and draws its shape with the AND mask instead.
  if (bits === 32 && rgba.every((v, i) => i % 4 !== 3 || v === 0)) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  return { width, height, rgba };
}
