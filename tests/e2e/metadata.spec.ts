import { expect, test } from "@playwright/test";
import { BASE_URL } from "./web-server";

// Work from the response text: a hydrated DOM can hide missing crawler metadata.
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [match[1], match[2].replaceAll("&amp;", "&")]));
}

function meta(html: string, key: string): string | undefined {
  return [...html.matchAll(/<meta\s[^>]*>/g)].map(([tag]) => attributes(tag)).find((attrs) => attrs.name === key || attrs.property === key)?.content;
}

for (const path of ["/", "/pricing", "/scan", "/bot", "/legal/terms", "/legal/privacy"]) {
  test(`${path} serves a complete card and its own canonical without JavaScript`, async ({ request }) => {
    const response = await request.get(path);
    expect(response.status()).toBe(200);
    const html = await response.text();
    const title = /<title>([^<]+)<\/title>/.exec(html)?.[1].replaceAll("&amp;", "&");
    expect(title).toBeTruthy();
    expect(meta(html, "og:title")).toBe(title);
    expect(meta(html, "og:description")).toBe(meta(html, "description"));
    expect(meta(html, "og:description")).toBeTruthy();
    expect(meta(html, "og:site_name")).toBe("Staygreen");
    expect(meta(html, "og:type")).toBe("website");
    expect(meta(html, "og:image:width")).toBe("1200");
    expect(meta(html, "og:image:height")).toBe("630");
    expect(meta(html, "og:image:alt")?.trim()).toBe("Staygreen. Your app is up. Is it working?");
    expect(meta(html, "twitter:card")).toBe("summary_large_image");
    expect(meta(html, "twitter:image")).toBe(meta(html, "og:image"));
    expect(meta(html, "robots")).toBe("noindex, nofollow");
    const canonical = [...html.matchAll(/<link\s[^>]*>/g)].map(([tag]) => attributes(tag)).find((attrs) => attrs.rel === "canonical");
    expect(canonical?.href).toBeTruthy();
    expect(new URL(canonical!.href).href).toBe(new URL(path, BASE_URL).href);
    const imageUrl = new URL(meta(html, "og:image")!);
    expect(imageUrl.origin).toBe(BASE_URL);
    const image = await request.get(imageUrl.href);
    expect(image.status()).toBe(200);
    expect(image.headers()["content-type"]).toMatch(/^image\/png/);
    const png = await image.body();
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });
}

test("the linked SVG parses, the PNG decodes, and the conventional favicon is an ICO", async ({ request, page }) => {
  const html = await (await request.get("/")).text();
  const icon = [...html.matchAll(/<link\s[^>]*>/g)].map(([tag]) => attributes(tag)).find((attrs) => attrs.rel === "icon" && attrs.href?.endsWith(".svg"));
  expect(icon?.href).toBeTruthy();
  // No page links the ICO: one that did would come before a status page's own icon.
  expect(html).not.toMatch(/<link[^>]+favicon\.ico/);
  const svg = await request.get(icon!.href);
  expect(svg.status()).toBe(200);
  expect(svg.headers()["content-type"]).toMatch(/^image\/svg\+xml/);
  expect(await page.evaluate((source) => {
    const doc = new DOMParser().parseFromString(source, "image/svg+xml");
    return doc.querySelector("parsererror") === null && doc.documentElement.localName === "svg";
  }, await svg.text())).toBe(true);
  const image = await request.get(meta(html, "og:image")!);
  const png = await image.body();
  expect(await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const size = [bitmap.width, bitmap.height];
    bitmap.close();
    return size;
  }, png.toString("base64"))).toEqual([1200, 630]);
  const favicon = await request.get("/favicon.ico");
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()["content-type"]).toMatch(/^image\/(x-icon|vnd\.microsoft\.icon)/);
  const ico = await favicon.body();
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
});

test("non-production robots and sitemap never invite indexing", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toMatch(/^User-Agent: \*\s+Disallow: \/\s*$/);
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("xml");
  const xml = await sitemap.text();
  expect(xml).toContain("<urlset");
  expect(xml).not.toContain("<loc>");
});

for (const path of ["/sign-in", "/sign-up", "/alerts/confirm/not-a-token", "/unsubscribe/not-a-token", "/not-a-real-page"]) {
  test(`${path} keeps noindex and inherits no canonical`, async ({ request }) => {
    const response = await request.get(path);
    expect(response.status()).toBe(path === "/not-a-real-page" ? 404 : 200);
    const html = await response.text();
    expect(meta(html, "robots")).toContain("noindex");
    expect(html).not.toMatch(/<link[^>]+rel="canonical"/);
  });
}
