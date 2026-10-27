import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { INDEXED_PATHS, isIndexableSite, metadataBase, publicPageMetadata } from "@/lib/public-metadata";

const root = fileURLToPath(new URL("../../", import.meta.url));
const app = join(root, "src/app");
const publicPaths = ["/", "/pricing", "/scan", "/bot", "/legal/terms", "/legal/privacy"];
afterEach(() => vi.unstubAllEnvs());

describe("production-only public indexing", () => {
  it.each(["https://staygreen.io", "https://staygreen.io/", "https://staygreen.io:443"]) ("indexes the six public pages on %s", (url) => {
    vi.stubEnv("APP_URL", url);
    expect(INDEXED_PATHS).toEqual(publicPaths);
    for (const path of INDEXED_PATHS) {
      expect(publicPageMetadata(path)).toEqual({ alternates: { canonical: path }, robots: { index: true, follow: true } });
    }
    expect(sitemap().map((entry) => entry.url)).toEqual(publicPaths.map((path) => `https://staygreen.io${path}`));
    const result = robots();
    expect(result.sitemap).toBe("https://staygreen.io/sitemap.xml");
    expect(result.rules).toEqual({
      userAgent: "*", allow: publicPaths,
      disallow: ["/app", "/api", "/mcp", "/sign-in", "/sign-up", "/alerts", "/unsubscribe"],
    });
  });

  it.each(["https://dev.example.com", "http://localhost:3101", "https://preview.netlify.app", "http://staygreen.io", "https://staygreen.io:444", "https://staygreen.io.example.com", "https://staygreen.io@example.com"]) ("refuses indexing on %s", (url) => {
    vi.stubEnv("APP_URL", url);
    expect(isIndexableSite()).toBe(false);
    expect(metadataBase().href).toBe(new URL(url).href);
    for (const path of INDEXED_PATHS) expect(publicPageMetadata(path).robots).toEqual({ index: false, follow: false });
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } });
    expect(sitemap()).toEqual([]);
  });

  it("keeps an unconfigured local build off production", () => {
    vi.stubEnv("APP_URL", undefined);
    expect(metadataBase().origin).toBe("http://localhost:3000");
    expect(isIndexableSite()).toBe(false);
    expect(sitemap()).toEqual([]);
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function parse(path: string) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

it("keeps share-card fields only at the root, without title/image overrides or a root canonical", () => {
  const found: Record<string, string[]> = {};
  for (const path of sources(app)) {
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ["openGraph", "twitter"].includes(node.name.getText().replace(/["']/g, ""))) {
        expect(relative(app, path).replaceAll("\\", "/")).toBe("layout.tsx");
        expect(ts.isObjectLiteralExpression(node.initializer)).toBe(true);
        const object = node.initializer as ts.ObjectLiteralExpression;
        found[node.name.getText()] = object.properties.map((property) => property.name?.getText() ?? "spread");
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(path));
  }
  expect(found).toEqual({ openGraph: ["type", "siteName", "locale"], twitter: ["card"] });
  const layout = readFileSync(join(app, "layout.tsx"), "utf8");
  expect(layout).not.toMatch(/canonical\s*:/);
  expect(layout).toMatch(/robots:\s*\{\s*index:\s*false,\s*follow:\s*false\s*\}/);
});

it("opts in only the six named pages, with a canonical matching each page's own route", () => {
  const optedIn: string[] = [];
  for (const path of sources(app)) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText() === "publicPageMetadata") {
        const route = relative(join(app, "(public)"), path).replaceAll("\\", "/").replace(/(^|\/)page\.tsx$/, "") || "/";
        const normalized = route.startsWith("/") ? route : `/${route}`;
        expect(node.arguments[0]?.getText()).toBe(JSON.stringify(normalized));
        optedIn.push(normalized);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(path));
  }
  expect(optedIn.sort()).toEqual([...publicPaths].sort());
});

it("checks in the public PNG and a multi-size ICO made from the mark", () => {
  const png = readFileSync(join(app, "(public)/opengraph-image.png"));
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  expect(readFileSync(join(app, "(public)/opengraph-image.alt.txt"), "utf8").trim()).toBe("Staygreen. Your app is up. Is it working?");
  // Served from public/: an app-folder favicon is put first on every page, so a status page
  // or incident link would show Staygreen's icon ahead of its own (review rel25c).
  expect(existsSync(join(app, "favicon.ico"))).toBe(false);
  const ico = readFileSync(join(root, "public/favicon.ico"));
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2), ico.readUInt16LE(4)]).toEqual([0, 1, 4]);
  for (const [i, size] of [16, 32, 48, 256].entries()) {
    const offset = ico.readUInt32LE(6 + i * 16 + 12);
    const length = ico.readUInt32LE(6 + i * 16 + 8);
    expect(offset + length).toBeLessThanOrEqual(ico.length);
    expect([ico.readUInt32BE(offset + 16), ico.readUInt32BE(offset + 20)]).toEqual([size, size]);
  }
});
