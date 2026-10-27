import { describe, expect, it } from "vitest";
import { dataUrlBytes, ICON_SIDE, iconCandidates, manifestHref, manifestIcons } from "@/lib/favicon";

/* Finding an app's icon in the page its address served and its web app manifest (`docs/flows.md
   § Suggested checks`). The page is someone else's HTML, so these hold what comes back: addresses
   only, best first, http, https or data only, and `/favicon.ico` when the page names nothing. */

const page = "https://app.example.com/dashboard/";

describe("iconCandidates", () => {
  it("falls back to /favicon.ico on the page's origin when the page names no icon", () => {
    expect(iconCandidates("<html><head><title>x</title></head></html>", page)).toEqual(["https://app.example.com/favicon.ico"]);
    expect(iconCandidates("", page)).toEqual(["https://app.example.com/favicon.ico"]);
  });

  it("puts a vector first, then the smallest raster that fills the largest box, then the largest under it, then one of unknown size", () => {
    expect(ICON_SIDE).toBe(96);
    const html = `
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <link rel="icon" href="/small.ico">
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="icon" href="/favicon-512.png" sizes="512x512">
      <link rel="icon" href="/favicon-64.png" sizes="64x64">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">`;
    expect(iconCandidates(html, page)).toEqual([
      "https://app.example.com/icon.svg",
      // An apple-touch-icon naming no size is the 180 px iOS asks for: big enough, and smaller than 512.
      "https://app.example.com/touch.png",
      "https://app.example.com/favicon-512.png",
      "https://app.example.com/favicon-64.png",
      "https://app.example.com/favicon-16.png",
      "https://app.example.com/small.ico",
      "https://app.example.com/favicon.ico",
    ]);
  });

  it("never offers an icon that names only a size that isn't square", () => {
    const html = `<link rel="icon" href="/wide.png" sizes="200x100"><link rel="icon" href="/both.png" sizes="200x100 64x64">`;
    expect(iconCandidates(html, page)).toEqual(["https://app.example.com/both.png", "https://app.example.com/favicon.ico"]);
  });

  it("ranks the manifest's icons with the page's own", () => {
    const fromManifest = manifestIcons([{ src: "icon-192.png", sizes: "192x192" }], "https://app.example.com/static/site.webmanifest");
    const html = `<link rel="icon" href="/favicon-32.png" sizes="32x32">`;
    expect(iconCandidates(html, page, fromManifest)).toEqual(["https://app.example.com/static/icon-192.png", "https://app.example.com/favicon-32.png", "https://app.example.com/favicon.ico"]);
  });

  it("reads rel lists, single quotes, bare values and whatever attribute order a page uses", () => {
    const html = `<LINK href='/a.png' REL='shortcut icon'><link sizes=48x48 rel=icon href=/b.png>`;
    expect(iconCandidates(html, page).slice(0, 2)).toEqual(["https://app.example.com/b.png", "https://app.example.com/a.png"]);
  });

  it("resolves against <base href> and the page's own address", () => {
    expect(iconCandidates(`<base href="https://cdn.example.net/assets/"><link rel="icon" href="logo.png">`, page)[0]).toBe("https://cdn.example.net/assets/logo.png");
    expect(iconCandidates(`<link rel="icon" href="logo.png">`, page)[0]).toBe("https://app.example.com/dashboard/logo.png");
    expect(iconCandidates(`<link rel="icon" href="//static.example.com/i.png">`, page)[0]).toBe("https://static.example.com/i.png");
  });

  it("decodes entities in an href", () => {
    expect(iconCandidates(`<link rel="icon" href="/i.png?v=1&amp;s=2">`, page)[0]).toBe("https://app.example.com/i.png?v=1&s=2");
  });

  it("never offers a mask icon, a commented-out icon, or another kind of link", () => {
    const html = `
      <link rel="mask-icon" href="/mask.svg" color="#000">
      <!-- <link rel="icon" href="/old.png"> -->
      <link rel="stylesheet" href="/style.css">
      <link rel="manifest" href="/site.webmanifest">`;
    expect(iconCandidates(html, page)).toEqual(["https://app.example.com/favicon.ico"]);
  });

  it("returns only http, https and data:image addresses", () => {
    const html = `
      <link rel="icon" href="javascript:alert(1)">
      <link rel="icon" href="file:///etc/passwd">
      <link rel="icon" href="data:text/html,<b>x</b>">
      <link rel="icon" href="ftp://example.com/i.png">
      <link rel="icon" href="data:image/png;base64,iVBORw0KGgo=" sizes="32x32">`;
    expect(iconCandidates(html, page)).toEqual(["data:image/png;base64,iVBORw0KGgo=", "https://app.example.com/favicon.ico"]);
  });

  it("names an internal address as the page wrote it: refusing it is the guard's job when it is fetched", () => {
    // `suggestion-checks.ts` fetches every candidate through `src/checks/`, which refuses this
    // (`suggestion-checks.test.ts`, "never fetches an icon the page names at an internal address").
    expect(iconCandidates(`<link rel="icon" href="http://169.254.169.254/latest/meta-data">`, page)[0]).toBe("http://169.254.169.254/latest/meta-data");
  });

  it("lists each address once", () => {
    expect(iconCandidates(`<link rel="icon" href="/favicon.ico"><link rel="shortcut icon" href="/favicon.ico">`, page)).toEqual(["https://app.example.com/favicon.ico"]);
  });
});

describe("manifestIcons", () => {
  const at = "https://app.example.com/m/manifest.json";

  it("resolves each icon against the manifest's own address, and ranks a vector first", () => {
    const icons = manifestIcons(
      [
        { src: "/a-512.png", sizes: "512x512", type: "image/png" },
        { src: "b.svg", sizes: "any", type: "image/svg+xml" },
        { src: "c-48.png", sizes: "48x48" },
      ],
      at,
    );
    expect(icons.map((i) => i.url)).toEqual(["https://app.example.com/a-512.png", "https://app.example.com/m/b.svg", "https://app.example.com/m/c-48.png"]);
    expect(icons[1].score).toBeGreaterThan(icons[0].score);
    expect(icons[0].score).toBeGreaterThan(icons[2].score);
  });

  it("never takes a monochrome icon, or one that isn't square, and ranks a maskable one below an ordinary one", () => {
    const icons = manifestIcons(
      [
        { src: "mono.png", sizes: "192x192", purpose: "monochrome" },
        { src: "wide.png", sizes: "300x150" },
        { src: "mask.png", sizes: "192x192", purpose: "maskable" },
        { src: "plain.png", sizes: "192x192" },
        { src: "both.png", sizes: "192x192", purpose: "any maskable" },
      ],
      at,
    );
    expect(icons.map((i) => i.url.split("/").pop())).toEqual(["mask.png", "plain.png", "both.png"]);
    expect(icons[0].score).toBeLessThan(icons[1].score);
    expect(icons[2].score).toBe(icons[1].score);
  });

  it("ranks getbootstrap.com's, recorded 2026-10-22, with its page's icons: the 180 px touch icon, then the manifest's 192", () => {
    const html = `<link rel="apple-touch-icon" href="/docs/6.0/assets/img/favicons/apple-touch-icon.png" sizes="180x180"><link rel="icon" href="/docs/6.0/assets/img/favicons/favicon-32x32.png" sizes="32x32" type="image/png"><link rel="icon" href="/docs/6.0/assets/img/favicons/favicon-16x16.png" sizes="16x16" type="image/png"><link rel="manifest" href="/docs/6.0/assets/img/favicons/manifest.json"><link rel="icon" href="/docs/6.0/assets/img/favicons/favicon.ico">`;
    const manifest = { name: "Bootstrap", icons: [{ src: "android-chrome-192x192.png", sizes: "192x192", type: "image/png" }, { src: "android-chrome-512x512.png", sizes: "512x512", type: "image/png" }], theme_color: "#7952b3" };
    const site = "https://getbootstrap.com/";
    const at = manifestHref(html, site)!;
    expect(at).toBe("https://getbootstrap.com/docs/6.0/assets/img/favicons/manifest.json");
    expect(iconCandidates(html, site, manifestIcons(manifest.icons, at)).slice(0, 4)).toEqual([
      "https://getbootstrap.com/docs/6.0/assets/img/favicons/apple-touch-icon.png",
      "https://getbootstrap.com/docs/6.0/assets/img/favicons/android-chrome-192x192.png",
      "https://getbootstrap.com/docs/6.0/assets/img/favicons/android-chrome-512x512.png",
      "https://getbootstrap.com/docs/6.0/assets/img/favicons/favicon-32x32.png",
    ]);
  });

  it("takes only http, https and data addresses, and survives a manifest of the wrong shape", () => {
    const icons = manifestIcons([{ src: "javascript:alert(1)" }, { src: 42 } as never, null as never, { src: "data:image/png;base64,iVBORw0KGgo=", sizes: "96x96" }], at);
    expect(icons.map((i) => i.url)).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
  });
});

describe("manifestHref", () => {
  it("is the manifest the page links, resolved, or none", () => {
    expect(manifestHref(`<link rel="manifest" href="/site.webmanifest">`, page)).toBe("https://app.example.com/site.webmanifest");
    expect(manifestHref(`<base href="https://cdn.example.net/"><link rel=manifest href=m.json>`, page)).toBe("https://cdn.example.net/m.json");
    expect(manifestHref(`<link rel="manifest" href="javascript:x">`, page)).toBeNull();
    expect(manifestHref(`<link rel="icon" href="/i.png">`, page)).toBeNull();
  });
});

describe("dataUrlBytes", () => {
  it("decodes base64 and percent-encoded data addresses", () => {
    expect(Buffer.from(dataUrlBytes("data:image/png;base64,iVBORw0KGgo=", 1024)!)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(new TextDecoder().decode(dataUrlBytes("data:image/svg+xml,%3Csvg%3E%3C/svg%3E", 1024)!)).toBe("<svg></svg>");
    expect(new TextDecoder().decode(dataUrlBytes("data:image/svg+xml;charset=utf-8,%3Csvg%3E", 1024)!)).toBe("<svg>");
  });

  it("refuses an empty, oversized or malformed one", () => {
    expect(dataUrlBytes("data:image/png;base64,", 1024)).toBeNull();
    expect(dataUrlBytes(`data:image/png;base64,${Buffer.alloc(2048).toString("base64")}`, 1024)).toBeNull();
    expect(dataUrlBytes("data:image/svg+xml,%E0%A4%A", 1024)).toBeNull();
    expect(dataUrlBytes("https://example.com/i.png", 1024)).toBeNull();
  });
});
