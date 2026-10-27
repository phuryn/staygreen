import { describe, expect, it } from "vitest";
import { isSameOrigin, type OriginHeaders } from "@/lib/origin";

/* The Origin check on every mutation (`AGENTS.md § 1.2`, `docs/TESTS.md §
   Rules that came from bugs`): `Sec-Fetch-Site` first, because a page served
   with `Referrer-Policy: no-referrer` or a sandboxed frame posts `Origin: null`
   even from the same origin. `Origin` decides alone only when the browser sends
   no fetch metadata. The header sets below are the ones real browsers send. */

const HOST = "staygreen.io";
const h = (secFetchSite: string | null, origin: string | null, host: string | null = HOST): OriginHeaders => ({ secFetchSite, origin, host });

describe("with fetch metadata", () => {
  it("passes a same-origin form or fetch with a clean Origin", () => {
    expect(isSameOrigin(h("same-origin", "https://staygreen.io"))).toBe(true);
  });

  it("passes a same-origin post whose Origin is null (no-referrer page, sandboxed frame)", () => {
    expect(isSameOrigin(h("same-origin", "null"))).toBe(true);
  });

  it("passes a same-origin post that sends no Origin at all", () => {
    expect(isSameOrigin(h("same-origin", null))).toBe(true);
  });

  it("refuses a cross-site post whose Origin is null", () => {
    expect(isSameOrigin(h("cross-site", "null"))).toBe(false);
  });

  it("refuses a cross-site post even when it forges a matching Origin", () => {
    expect(isSameOrigin(h("cross-site", "https://staygreen.io"))).toBe(false);
  });

  it.each(["same-site", "none", "cross-site"])("refuses Sec-Fetch-Site: %s", (site) => {
    expect(isSameOrigin(h(site, "https://staygreen.io"))).toBe(false);
  });

  it("refuses a same-site sibling, such as a status page on another subdomain", () => {
    expect(isSameOrigin(h("same-site", "https://status.staygreen.io"))).toBe(false);
  });
});

describe("without fetch metadata, Origin decides", () => {
  it("passes an Origin whose host is the host reached", () => {
    expect(isSameOrigin(h(null, "https://staygreen.io"))).toBe(true);
    expect(isSameOrigin(h(null, "http://localhost:3101", "localhost:3101"))).toBe(true);
  });

  it("refuses another host", () => {
    expect(isSameOrigin(h(null, "https://evil.example"))).toBe(false);
    expect(isSameOrigin(h(null, "https://staygreen.io.evil.example"))).toBe(false);
  });

  it("refuses the same name on another port", () => {
    expect(isSameOrigin(h(null, "https://staygreen.io:8443"))).toBe(false);
  });

  it("refuses Origin: null, which proves nothing on its own", () => {
    expect(isSameOrigin(h(null, "null"))).toBe(false);
  });

  it("refuses a request with neither header", () => {
    expect(isSameOrigin(h(null, null))).toBe(false);
  });

  it("refuses when the host reached is unknown", () => {
    expect(isSameOrigin(h(null, "https://staygreen.io", null))).toBe(false);
  });

  it("refuses an Origin that does not parse", () => {
    expect(isSameOrigin(h(null, "not a url"))).toBe(false);
  });
});
