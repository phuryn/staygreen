import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { dominantColour } from "@/lib/icon-colour";
import { imageBytes, pngChunk } from "../support/page-assets";

/* The main colour of a site's icon (`icon-colour.ts`), one of the accent's candidates. Every image
   here is built in the test from its format's specification (PNG § 7 and § 9, the ICO directory
   and its BMP), so each colour type, bit depth and row filter is one the reader meets. */

type Rgba = [number, number, number, number];
const BRAND: Rgba = [0x63, 0x5b, 0xff, 255];
const RED: Rgba = [0xe1, 0x1d, 0x48, 255];
const WHITE: Rgba = [255, 255, 255, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** A logo: a disc of `fg` on `bg`, `share` of the square. */
const disc = (fg: Rgba, bg: Rgba, share = 0.5) => (x: number, y: number, side: number): Rgba => {
  const r = Math.sqrt((share * side * side) / Math.PI);
  return (x - side / 2 + 0.5) ** 2 + (y - side / 2 + 0.5) ** 2 <= r * r ? fg : bg;
};

/** The predictor PNG § 9.2 names, for `filter` (0 none, 1 sub, 2 up, 3 average, 4 Paeth). */
function filtered(rows: Uint8Array[], bpp: number, filter: number): Buffer {
  const out: number[] = [];
  rows.forEach((row, y) => {
    const up = y > 0 ? rows[y - 1] : new Uint8Array(row.length);
    const f = filter === -1 ? y % 5 : filter;
    out.push(f);
    for (let x = 0; x < row.length; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = up[x];
      const c = x >= bpp ? up[x - bpp] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const pred = [0, a, b, (a + b) >> 1, paeth][f];
      out.push((row[x] - pred) & 255);
    }
  });
  return Buffer.from(out);
}

function pngFile(width: number, height: number, depth: number, colour: number, rows: Uint8Array[], bpp: number, o: { filter?: number; plte?: Buffer; trns?: Buffer; interlace?: number; idat?: Buffer } = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = depth;
  ihdr[9] = colour;
  ihdr[12] = o.interlace ?? 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    ...(o.plte ? [pngChunk("PLTE", o.plte)] : []),
    ...(o.trns ? [pngChunk("tRNS", o.trns)] : []),
    pngChunk("IDAT", o.idat ?? deflateSync(filtered(rows, bpp, o.filter ?? 0))),
    pngChunk("IEND"),
  ]);
}

/** An 8-bit RGBA PNG of `side` square, painted by `paint`. */
function rgbaPng(side: number, paint: (x: number, y: number, side: number) => Rgba, filter = 0): Buffer {
  const rows = Array.from({ length: side }, (_, y) => Uint8Array.from(Array.from({ length: side }, (_, x) => paint(x, y, side)).flat()));
  return pngFile(side, side, 8, 6, rows, 4, { filter });
}

describe("dominantColour, PNG", () => {
  it("is the logo's colour, under its anti-aliasing and on a transparent ground", () => {
    expect(dominantColour(rgbaPng(64, disc(BRAND, CLEAR)))).toBe("#635bff");
  });

  it.each([[0, "none"], [1, "sub"], [2, "up"], [3, "average"], [4, "Paeth"], [-1, "each, row by row"]])("reads rows written with filter %s (%s)", (filter) => {
    expect(dominantColour(rgbaPng(48, disc(RED, WHITE, 0.4), filter))).toBe("#e11d48");
  });

  it("is the largest brand-coloured area, never the white or grey around it", () => {
    const twoTone = (x: number, y: number, side: number): Rgba => (y < side * 0.6 ? BRAND : x < side / 2 ? RED : [128, 128, 128, 255]);
    expect(dominantColour(rgbaPng(40, twoTone))).toBe("#635bff");
  });

  it("is nothing when the colour covers too little of the icon, or there is none", () => {
    expect(dominantColour(rgbaPng(64, disc(BRAND, WHITE, 0.05)))).toBeNull();
    expect(dominantColour(rgbaPng(32, () => [120, 120, 120, 255]))).toBeNull();
    expect(dominantColour(rgbaPng(32, () => CLEAR))).toBeNull();
  });

  it("reads 8-bit RGB, 16-bit RGB and greyscale", () => {
    const side = 16;
    const rgb = Array.from({ length: side }, () => Uint8Array.from(Array.from({ length: side }, () => [0x63, 0x5b, 0xff]).flat()));
    expect(dominantColour(pngFile(side, side, 8, 2, rgb, 3))).toBe("#635bff");
    const rgb16 = Array.from({ length: side }, () => Uint8Array.from(Array.from({ length: side }, () => [0x63, 0x00, 0x5b, 0x00, 0xff, 0xff]).flat()));
    expect(dominantColour(pngFile(side, side, 16, 2, rgb16, 6))).toBe("#635bff");
    const grey = Array.from({ length: side }, () => new Uint8Array(side).fill(90));
    expect(dominantColour(pngFile(side, side, 8, 0, grey, 1))).toBeNull();
  });

  it("reads a 4-bit palette, with transparency from tRNS", () => {
    const side = 16;
    const plte = Buffer.from([0, 0, 0, 0x63, 0x5b, 0xff, 0xe1, 0x1d, 0x48]);
    // Index 0 transparent, 1 the brand, 2 red; two pixels a byte.
    const rows = Array.from({ length: side }, (_, y) => Uint8Array.from(Array.from({ length: side / 2 }, () => (y < 4 ? 0x22 : y < 10 ? 0x11 : 0x00))));
    expect(dominantColour(pngFile(side, side, 4, 3, rows, 1, { plte, trns: Buffer.from([0]) }))).toBe("#635bff");
  });

  it("refuses what it doesn't read, and what isn't whole, without throwing", () => {
    const side = 16;
    const rows = Array.from({ length: side }, () => new Uint8Array(side * 4).fill(200));
    expect(dominantColour(pngFile(side, side, 8, 6, rows, 4, { interlace: 1 }))).toBeNull();
    // Rows shorter than the header promises.
    expect(dominantColour(pngFile(side, side, 8, 6, rows, 4, { idat: deflateSync(Buffer.alloc(10)) }))).toBeNull();
    // A palette index past the palette.
    expect(dominantColour(pngFile(side, side, 8, 3, Array.from({ length: side }, () => new Uint8Array(side).fill(9)), 1, { plte: Buffer.from([1, 2, 3]) }))).toBeNull();
    // A filter type that doesn't exist.
    const bad = Buffer.concat(Array.from({ length: side }, () => Buffer.concat([Buffer.from([7]), Buffer.alloc(side * 4)])));
    expect(dominantColour(pngFile(side, side, 8, 6, rows, 4, { idat: deflateSync(bad) }))).toBeNull();
  });

  it("never inflates more than the header promises: a small header over a bomb stops at its size", () => {
    const bomb = deflateSync(Buffer.alloc(64 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(100 * 1024);
    const started = performance.now();
    expect(dominantColour(pngFile(16, 16, 8, 6, [], 4, { idat: bomb }))).toBeNull();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("refuses an image larger than a million pixels before it reads a row", () => {
    expect(dominantColour(pngFile(2000, 2000, 8, 6, [], 4, { idat: deflateSync(Buffer.alloc(16)) }))).toBeNull();
  });
});

/** An ICO holding `images`, each a PNG or a BMP with its side. */
function ico(images: { side: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + images.length * 16);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let at = head.length;
  images.forEach((img, i) => {
    const e = 6 + i * 16;
    head[e] = img.side % 256;
    head[e + 1] = img.side % 256;
    head.writeUInt32LE(img.data.length, e + 8);
    head.writeUInt32LE(at, e + 12);
    at += img.data.length;
  });
  return Buffer.concat([head, ...images.map((i) => i.data)]);
}

/** A 32-bit BMP as an ICO holds it: its header, then bottom-up BGRA rows, then the AND mask. */
function bmp32(side: number, paint: (x: number, y: number, side: number) => Rgba, alpha = true): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(side, 4);
  header.writeInt32LE(side * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const [r, g, b, a] = paint(x, y, side);
      pixels.set([b, g, r, alpha ? a : 0], ((side - 1 - y) * side + x) * 4);
    }
  }
  const mask = Buffer.alloc(Math.ceil(side / 32) * 4 * side);
  return Buffer.concat([header, pixels, mask]);
}

describe("dominantColour, ICO", () => {
  it("reads the largest image an ICO holds, as a PNG", () => {
    expect(dominantColour(ico([{ side: 16, data: rgbaPng(16, () => RED) }, { side: 32, data: rgbaPng(32, disc(BRAND, CLEAR)) }]))).toBe("#635bff");
  });

  it("reads a 32-bit bitmap, and one that leaves its alpha at zero", () => {
    expect(dominantColour(ico([{ side: 32, data: bmp32(32, disc(BRAND, WHITE, 0.6)) }]))).toBe("#635bff");
    expect(dominantColour(ico([{ side: 32, data: bmp32(32, disc(RED, WHITE, 0.6), false) }]))).toBe("#e11d48");
  });

  it("reads the product's own fixture without throwing", () => {
    expect(() => dominantColour(imageBytes("ico"))).not.toThrow();
  });
});

describe("dominantColour, SVG and the rest", () => {
  it("is an SVG's most used brand colour, as written in its attributes and styles", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect fill="#ffffff" width="24" height="24"/><path fill="#635BFF" d="M0 0h12v12z"/><path style="fill: #635bff" d="M12 12h12v12z"/><circle stroke="rgb(225, 29, 72)" r="4"/><stop stop-color="#808080"/></svg>`;
    expect(dominantColour(new TextEncoder().encode(svg))).toBe("#635bff");
  });

  it("is nothing for an SVG in greys, a JPEG, a WebP, or bytes that aren't an image", () => {
    expect(dominantColour(new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><path fill="#333"/><path fill="currentColor"/></svg>`))).toBeNull();
    expect(dominantColour(imageBytes("jpg"))).toBeNull();
    expect(dominantColour(imageBytes("webp"))).toBeNull();
    expect(dominantColour(new TextEncoder().encode("<!doctype html><p>hi"))).toBeNull();
    expect(dominantColour(new Uint8Array())).toBeNull();
  });
});
