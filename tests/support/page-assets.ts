import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

/** Real small images, independent of the product's byte identifier. No decoder is faked. Read from
 *  the repository root: Playwright loads this file as CommonJS and Vitest as ESM, so neither
 *  `import.meta` nor `__dirname` works in both. */
export const imageBytes = (extension: "png" | "jpg" | "webp" | "ico") => readFileSync(join(process.cwd(), "tests", "fixtures", "page-assets", `logo.${extension}`));
export function imageForm(content: Uint8Array = imageBytes("png"), name = "logo.png", type = "image/png") {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(content)], { type }), name);
  return form;
}

/* Images built here rather than checked in: a size, or the metadata a camera or a design tool
   writes, is a parameter rather than a binary in the repository. Each is a well-formed file of
   its type, written from its specification (PNG § 5, the WebP container), so a browser decodes
   the PNGs; a WebP's bitstream here is its header and filler, which the server never decodes. */

/** A PNG chunk with its CRC. */
export function pngChunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGBA PNG, flat grey or random noise, with `before` and `after` chunks either side of its
 *  image data. Level 0 stores the pixels uncompressed, so noise makes a file of a chosen size. */
export function png({ width, height, before = [], after = [], noise = false, level = 9 }: {
  width: number; height: number; before?: Buffer[]; after?: Buffer[]; noise?: boolean; level?: number;
}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = 1 + width * 4;
  const raw = noise ? randomBytes(row * height) : Buffer.alloc(row * height, 0x7f);
  for (let y = 0; y < height; y++) raw[y * row] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr), ...before, pngChunk("IDAT", deflateSync(raw, { level })), ...after, pngChunk("IEND"),
  ]);
}

/** The chunk types of a PNG, in order. */
export function pngChunks(bytes: Uint8Array): string[] {
  const b = Buffer.from(bytes);
  const out: string[] = [];
  for (let at = 8; at + 12 <= b.length; at += b.readUInt32BE(at) + 12) out.push(b.toString("latin1", at + 4, at + 8));
  return out;
}

/** A RIFF chunk, padded to an even length. */
export function webpChunk(type: string, data: Uint8Array = new Uint8Array()): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, "latin1");
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}

/** A lossless WebP's image chunk declaring `width` by `height`, with alpha. */
export function vp8l(width: number, height: number): Buffer {
  const data = Buffer.alloc(16);
  data[0] = 0x2f;
  data.writeUInt32LE(((width - 1) | ((height - 1) << 14) | (1 << 28)) >>> 0, 1);
  return webpChunk("VP8L", data);
}

/** An extended WebP header: its `flags` and its canvas. */
export function vp8x(flags: number, width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return webpChunk("VP8X", data);
}

export function webp(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

/** The chunks of a WebP, in order, with their data. */
export function webpChunks(bytes: Uint8Array): { type: string; data: Buffer }[] {
  const b = Buffer.from(bytes);
  const out: { type: string; data: Buffer }[] = [];
  for (let at = 12; at + 8 <= b.length;) {
    const size = b.readUInt32LE(at + 4);
    out.push({ type: b.toString("latin1", at, at + 4), data: b.subarray(at + 8, at + 8 + size) });
    at += 8 + size + (size % 2);
  }
  return out;
}

/** Something private, in every place a camera or an editor writes one, so a test can ask
 *  whether any of it survived. */
export const SECRET = "GPS 51.5072N 0.1276W, Alex's phone";
export const secretPngChunks = () => [
  pngChunk("tEXt", Buffer.from(`Comment\0${SECRET}`, "latin1")),
  pngChunk("eXIf", Buffer.from(`MM\0*${SECRET}`, "latin1")),
  pngChunk("iCCP", Buffer.from(`evil\0\0${SECRET}`, "latin1")),
  pngChunk("gAMA", Buffer.from([0, 0, 177, 143])),
  pngChunk("pHYs", Buffer.alloc(9)),
  pngChunk("tIME", Buffer.alloc(7)),
];
export const secretWebpChunks = () => [
  webpChunk("ICCP", Buffer.from(SECRET)),
  webpChunk("EXIF", Buffer.from(`MM\0*${SECRET}`)),
  webpChunk("XMP ", Buffer.from(`<x:xmpmeta>${SECRET}</x:xmpmeta>`)),
];
