import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkPageAssetSource, faviconOf, identifyPageAsset, imageSize, PAGE_ASSET_BOX, PAGE_ASSET_LIMIT, PAGE_ASSET_TOO_LARGE,
  PAGE_ASSET_TOO_MANY_PIXELS, PAGE_ASSET_UNPREPARED, PAGE_ASSET_UPLOAD_LIMIT, storablePageAsset,
} from "@/lib/page-assets";
import { fit } from "@/lib/page-asset-prepare";
import { APP_LOGO_SIZES } from "@/components/AppLogo";
import { pageAssetResponse } from "@/lib/page-asset-response";
import { snapshotDto, viewFromSim } from "@/lib/public-page";
import { imageBytes, png, pngChunk, pngChunks, SECRET, secretPngChunks, secretWebpChunks, vp8l, vp8x, webp, webpChunk, webpChunks } from "../support/page-assets";
import { page, sim } from "./fixtures";

const LOGO_NOT_AN_IMAGE = "This file isn't a PNG, JPEG, WebP or SVG image.";
const FAVICON_NOT_AN_IMAGE = "This file isn't a PNG, JPEG, WebP, ICO or SVG image.";
const svgs = ["<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", "<?xml version='1.0'?>\n<svg>\n</svg>"];
const notImages = ["<!doctype html><script>alert(1)</script>", "alert(document.cookie)", ""];
const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text, "latin1"));

describe("page image bytes", () => {
  it.each([
    ["png", "image/png"], ["jpg", "image/jpeg"], ["webp", "image/webp"], ["ico", "image/vnd.microsoft.icon"],
  ] as const)("identifies a real %s by its contents", (extension, mime) => {
    expect(identifyPageAsset(imageBytes(extension))).toBe(mime);
    expect(checkPageAssetSource(imageBytes(extension), "favicon")).toEqual({ ok: true, type: mime });
  });
  it.each(["png", "jpg", "webp", "ico"] as const)("refuses a truncated %s", (ext) => {
    const b = imageBytes(ext);
    expect(identifyPageAsset(b.subarray(0, b.length / 2))).toBeNull();
  });
  it("refuses PNG/JPEG/WebP/ICO signatures wrapped around HTML", () => {
    for (const ext of ["png", "jpg", "webp", "ico"] as const) {
      const b = Buffer.concat([imageBytes(ext).subarray(0, 12), Buffer.from("<script>alert(document.cookie)</script>")]);
      expect(identifyPageAsset(b)).toBeNull();
    }
  });
  it("reads each format's size from its header", () => {
    for (const ext of ["png", "jpg", "webp", "ico"] as const) expect(imageSize(imageBytes(ext), identifyPageAsset(imageBytes(ext))!), ext).toEqual({ width: 16, height: 16 });
    expect(imageSize(png({ width: 504, height: 96 }), "image/png")).toEqual({ width: 504, height: 96 });
    expect(imageSize(webp(vp8l(300, 20)), "image/webp")).toEqual({ width: 300, height: 20 });
    // A small canvas can't vouch for a large frame inside it.
    expect(imageSize(webp(vp8x(0x10, 10, 10), vp8l(4000, 3000)), "image/webp")).toEqual({ width: 4000, height: 3000 });
  });
});

describe("the file a builder chooses (the picker's check, before anything decodes it)", () => {
  it("takes up to 10 MB, and refuses more with a sentence that names the limit", () => {
    expect(PAGE_ASSET_TOO_LARGE).toBe("Upload an image no larger than 10 MB.");
    expect(checkPageAssetSource(new Uint8Array(PAGE_ASSET_UPLOAD_LIMIT + 1), "logo")).toEqual({ ok: false, reason: PAGE_ASSET_TOO_LARGE });
    // Exactly the limit passes the size guard and is refused on format instead.
    expect(checkPageAssetSource(new Uint8Array(PAGE_ASSET_UPLOAD_LIMIT), "logo")).toEqual({ ok: false, reason: LOGO_NOT_AN_IMAGE });
  });
  it("takes a 6 MB PNG, far over what is stored", () => {
    const big = png({ width: 1300, height: 1200, noise: true, level: 0 });
    expect(big.length).toBeGreaterThan(6_000_000);
    expect(checkPageAssetSource(big, "logo")).toEqual({ ok: true, type: "image/png" });
  });
  it.each(svgs)("sends an SVG down its own path, to become pixels: %j", (s) => {
    expect(checkPageAssetSource(Buffer.from(s), "logo")).toEqual({ ok: true, type: "image/svg+xml" });
  });
  it.each(notImages)("refuses a file that isn't an image, naming what is accepted: %j", (s) => {
    expect(checkPageAssetSource(Buffer.from(s), "logo")).toEqual({ ok: false, reason: LOGO_NOT_AN_IMAGE });
    expect(checkPageAssetSource(Buffer.from(s), "favicon")).toEqual({ ok: false, reason: FAVICON_NOT_AN_IMAGE });
  });
  it("allows ICO for the favicon and an app's logo, never a page's logo", () => {
    expect(checkPageAssetSource(imageBytes("ico"), "logo")).toEqual({ ok: false, reason: "ICO is for favicons. Upload a PNG, JPEG, WebP or SVG logo." });
    // The icon an app's own site serves is often an ICO, and it becomes the app's logo.
    expect(checkPageAssetSource(imageBytes("ico"), "app")).toEqual({ ok: true, type: "image/vnd.microsoft.icon" });
    expect(checkPageAssetSource(Buffer.from(notImages[0]), "app")).toEqual({ ok: false, reason: FAVICON_NOT_AN_IMAGE });
  });
  it("refuses more pixels than a browser can be relied on to decode, from the header alone", () => {
    expect(checkPageAssetSource(png({ width: 8000, height: 5000, level: 1 }), "logo")).toEqual({ ok: true, type: "image/png" });
    expect(checkPageAssetSource(png({ width: 8000, height: 5001, level: 1 }), "logo")).toEqual({ ok: false, reason: PAGE_ASSET_TOO_MANY_PIXELS });
  });
});

describe("what the server stores", () => {
  it("takes the picker's own formats: a WebP or PNG logo, a PNG favicon, a WebP or PNG app logo", () => {
    expect(storablePageAsset(imageBytes("webp"), "app")).toMatchObject({ ok: true, mime: "image/webp" });
    expect(storablePageAsset(imageBytes("png"), "app")).toMatchObject({ ok: true, mime: "image/png" });
    expect(storablePageAsset(imageBytes("ico"), "app")).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
    expect(storablePageAsset(imageBytes("webp"), "logo")).toMatchObject({ ok: true, mime: "image/webp" });
    expect(storablePageAsset(imageBytes("png"), "logo")).toMatchObject({ ok: true, mime: "image/png" });
    expect(storablePageAsset(imageBytes("png"), "favicon")).toMatchObject({ ok: true, mime: "image/png" });
  });
  it("refuses what only a client that skipped the picker sends: a JPEG, an ICO, a WebP favicon, an SVG", () => {
    expect(PAGE_ASSET_UNPREPARED).toBe("This image wasn't resized for the page. Reload the editor and choose it again.");
    expect(storablePageAsset(imageBytes("jpg"), "logo")).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
    expect(storablePageAsset(imageBytes("ico"), "favicon")).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
    expect(storablePageAsset(imageBytes("webp"), "favicon")).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
    for (const s of svgs) expect(storablePageAsset(Buffer.from(s), "logo")).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
  });
  it.each(notImages)("refuses a file that isn't an image: %j", (s) => {
    expect(storablePageAsset(Buffer.from(s), "logo")).toEqual({ ok: false, reason: LOGO_NOT_AN_IMAGE });
  });
  it("stores an image no larger than its slot's box, and refuses one a pixel over", () => {
    for (const kind of ["logo", "favicon", "app"] as const) {
      const { width, height } = PAGE_ASSET_BOX[kind];
      expect(storablePageAsset(png({ width, height }), kind), kind).toMatchObject({ ok: true });
      expect(storablePageAsset(png({ width: width + 1, height }), kind), kind).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
      expect(storablePageAsset(png({ width, height: height + 1 }), kind), kind).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
    }
    expect(storablePageAsset(webp(vp8l(505, 96)), "logo")).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
    expect(storablePageAsset(webp(vp8x(0x10, 100, 20), vp8l(4000, 20)), "logo")).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
  });
  it("refuses over 512 KB, the table's own limit, before identifying bytes", () => {
    const over = png({ width: 504, height: 96, before: [pngChunk("zTXt", Buffer.alloc(PAGE_ASSET_LIMIT))] });
    expect(storablePageAsset(over, "logo")).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
  });
  it("keeps a PNG's pixels and drops every other chunk: text, EXIF, profile, gamma, density, time", () => {
    const sent = png({ width: 40, height: 20, before: secretPngChunks(), after: [pngChunk("tEXt", Buffer.from(`Author\0${SECRET}`, "latin1"))] });
    expect(has(sent, SECRET)).toBe(true);
    const stored = storablePageAsset(sent, "logo");
    if (!stored.ok) throw new Error(stored.reason);
    expect(pngChunks(stored.bytes)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(has(stored.bytes, SECRET)).toBe(false);
    expect(identifyPageAsset(stored.bytes)).toBe("image/png");
    // What's left is the image's own chunks, byte for byte.
    expect(Buffer.from(stored.bytes)).toEqual(png({ width: 40, height: 20 }));
    // The fixture's density chunk goes too.
    const fixture = storablePageAsset(imageBytes("png"), "logo");
    expect(pngChunks(imageBytes("png"))).toContain("pHYs");
    expect(fixture.ok && pngChunks(fixture.bytes)).toEqual(["IHDR", "IDAT", "IEND"]);
  });
  it("keeps an animated PNG's default image only", () => {
    const apng = png({ width: 20, height: 20, before: [pngChunk("acTL", Buffer.alloc(8)), pngChunk("fcTL", Buffer.alloc(26))], after: [pngChunk("fcTL", Buffer.alloc(26)), pngChunk("fdAT", Buffer.alloc(8))] });
    const stored = storablePageAsset(apng, "logo");
    expect(stored.ok && pngChunks(stored.bytes)).toEqual(["IHDR", "IDAT", "IEND"]);
  });
  it("keeps a WebP's image and alpha, drops its profile, EXIF and XMP, and stops announcing them", () => {
    const [iccp, exif, xmp] = secretWebpChunks();
    const sent = webp(vp8x(0x20 | 0x10 | 0x08 | 0x04, 120, 40), iccp, webpChunk("ALPH", Buffer.alloc(5)), vp8l(120, 40), exif, xmp);
    expect(has(sent, SECRET)).toBe(true);
    const stored = storablePageAsset(sent, "logo");
    if (!stored.ok) throw new Error(stored.reason);
    const chunks = webpChunks(stored.bytes);
    expect(chunks.map((c) => c.type)).toEqual(["VP8X", "ALPH", "VP8L"]);
    expect(chunks[0].data[0]).toBe(0x10);
    expect(has(stored.bytes, SECRET)).toBe(false);
    expect(Buffer.from(stored.bytes).readUInt32LE(4)).toBe(stored.bytes.length - 8);
    expect(identifyPageAsset(stored.bytes)).toBe("image/webp");
  });
  it("refuses an animated WebP rather than store one frame of it", () => {
    const animated = webp(vp8x(0x02, 50, 50), webpChunk("ANIM", Buffer.alloc(6)), webpChunk("ANMF", Buffer.concat([Buffer.alloc(16), vp8l(50, 50)])));
    expect(identifyPageAsset(animated)).toBe("image/webp");
    expect(storablePageAsset(animated, "logo")).toEqual({ ok: false, reason: PAGE_ASSET_UNPREPARED });
  });
});

describe("the box an image is drawn into", () => {
  const css = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");
  it("is the logo's place in the page header at 3x, as the stylesheet draws it", () => {
    const rule = /\.sp-uploaded-logo\s*\{([^}]*)\}/.exec(css("src/styles/status.css"))?.[1] ?? "";
    const token = (name: string) => Number(new RegExp(`--${name}:\\s*(\\d+)px`).exec(css("design/tokens.css"))?.[1]);
    const height = /(?:^|[\s;])height:\s*var\(--([\w-]+)\)/.exec(rule)?.[1] ?? "";
    const width = /max-width:\s*min\([^,]+,\s*var\(--([\w-]+)\)\)/.exec(rule)?.[1] ?? "";
    expect(PAGE_ASSET_BOX.logo).toEqual({ width: token(width) * 3, height: token(height) * 3 });
    // A tab draws a favicon at 16 CSS pixels.
    expect(PAGE_ASSET_BOX.favicon).toEqual({ width: 48, height: 48 });
  });
  it("is an app's logo at the largest size the dashboard draws it, at 3x", () => {
    const side = Math.max(...APP_LOGO_SIZES) * 3;
    expect(PAGE_ASSET_BOX.app).toEqual({ width: side, height: side });
  });
  it("keeps the shape, never enlarges a raster image, and never passes the box", () => {
    const logo = PAGE_ASSET_BOX.logo;
    expect(fit({ width: 1300, height: 1200 }, logo, false)).toEqual({ width: 104, height: 96 });
    expect(fit({ width: 3000, height: 100 }, logo, false)).toEqual({ width: 504, height: 17 });
    expect(fit({ width: 16, height: 16 }, logo, false)).toEqual({ width: 16, height: 16 });
    expect(fit({ width: 100000, height: 1 }, logo, false)).toEqual({ width: 504, height: 1 });
    for (let i = 0; i < 200; i++) {
      const from = { width: 1 + Math.floor(Math.random() * 9000), height: 1 + Math.floor(Math.random() * 9000) };
      for (const box of Object.values(PAGE_ASSET_BOX)) {
        const to = fit(from, box, false);
        expect(to.width <= box.width && to.height <= box.height && to.width <= from.width && to.height <= from.height, JSON.stringify({ from, box, to })).toBe(true);
      }
    }
  });
  it("draws a vector at the full box", () => {
    expect(fit({ width: 24, height: 24 }, PAGE_ASSET_BOX.logo, true)).toEqual({ width: 96, height: 96 });
    expect(fit({ width: 24, height: 24 }, PAGE_ASSET_BOX.favicon, true)).toEqual({ width: 48, height: 48 });
    expect(fit({ width: 300, height: 40 }, PAGE_ASSET_BOX.logo, true)).toEqual({ width: 504, height: 67 });
  });
});

describe("asset delivery", () => {
  it("returns the stored bytes with an inert raster MIME and sandbox, cached for good under its one-time address", async () => {
    const bytes = imageBytes("png");
    const response = pageAssetResponse({ content: `\\x${bytes.toString("hex")}`, mime: "image/png" });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toContain("sandbox;");
    expect(response.headers.get("content-security-policy")).not.toMatch(/allow-scripts|allow-same-origin/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.has("set-cookie")).toBe(false);
  });
  it("still serves a JPEG or an ICO stored before uploads were resized", () => {
    for (const [ext, mime] of [["jpg", "image/jpeg"], ["ico", "image/vnd.microsoft.icon"]] as const) {
      const r = pageAssetResponse({ content: `\\x${imageBytes(ext).toString("hex")}`, mime });
      expect([r.status, r.headers.get("content-type")]).toEqual([200, mime]);
    }
  });
  it.each([null, { content: "<script>alert(1)</script>", mime: "image/png" }, { content: `\\x${imageBytes("png").toString("hex")}`, mime: "text/html" }])("fails closed for a missing or corrupt row", (row) => {
    const r = pageAssetResponse(row);
    expect(r.status).toBe(404);
    expect(r.headers.get("content-security-policy")).toContain("sandbox;");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("branding addresses", () => {
  const path = `/page-assets/asset_${"a".repeat(32)}`;
  it("uses a favicon, then the logo, then the unchanged default", () => {
    expect(faviconOf({ faviconUrl: "/favicon", logoUrl: "/logo" })).toBe("/favicon");
    expect(faviconOf({ faviconUrl: null, logoUrl: "/logo" })).toBe("/logo");
    expect(faviconOf({ faviconUrl: null, logoUrl: null })).toBe("/icon.svg");
  });
  it("carries the saved image addresses into the preview without image bytes", () => {
    const p = page({ logoUrl: path, faviconUrl: path });
    expect(viewFromSim(sim(), p).page).toMatchObject({ logoUrl: path, faviconUrl: path });
  });
  it("allows only generated paths in the public DTO", () => {
    const shape = snapshotDto.shape.page.shape.logoUrl;
    expect(shape.parse(path)).toBe(path);
    for (const address of ["https://evil.test/image", "//evil.test/a", "data:image/svg+xml,a", "/page-assets/guess"]) {
      expect(shape.safeParse(address).success).toBe(false);
    }
  });
});
