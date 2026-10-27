import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newerSnapshot, pendingPathOf, type LinkClick } from "@/lib/navigation";
import { FRESH_ON_EVERY_VISIT, KEPT_SCREEN_S, POLL_MS } from "@/lib/poll";

/* Moving between dashboard screens (`src/lib/navigation.ts`, `docs/architecture.md § Feeds and
   polling`): which snapshot a screen shows once the router keeps screens, and which clicks the
   shell answers before the server does. */

describe("newerSnapshot", () => {
  const at = (loadedAt: number) => ({ loadedAt });

  it("shows the page's own copy when it is the newest", () => {
    const page = at(2);
    expect(newerSnapshot(page, at(1))).toBe(page);
    expect(newerSnapshot(page, page)).toBe(page);
  });

  it("shows the newest handed up over a kept page's older copy", () => {
    const latest = at(5);
    expect(newerSnapshot(at(3), latest)).toBe(latest);
  });

  it("keeps the page's copy on a tie, so a screen never swaps for an equal one", () => {
    const page = at(4);
    expect(newerSnapshot(page, at(4))).toBe(page);
  });

  it("takes whichever exists before the other arrives", () => {
    const one = at(1);
    expect(newerSnapshot(one, null)).toBe(one);
    expect(newerSnapshot(null, one)).toBe(one);
    expect(newerSnapshot(null, null)).toBeNull();
  });
});

describe("pendingPathOf", () => {
  const here = { origin: "https://app.staygreen.io", pathname: "/app/monitors" };
  const click = (over: Partial<LinkClick> = {}): LinkClick => ({
    button: 0, modified: false, href: "https://app.staygreen.io/app/status-pages", target: "", download: false, ...over,
  });

  it("marks another dashboard screen, by its path alone", () => {
    expect(pendingPathOf(click(), here)).toBe("/app/status-pages");
    expect(pendingPathOf(click({ href: "https://app.staygreen.io/app/monitors/mon_1?tab=checks#x" }), here)).toBe("/app/monitors/mon_1");
    expect(pendingPathOf(click({ href: "https://app.staygreen.io/app", target: "_self" }), here)).toBe("/app");
  });

  it("marks nothing for the screen already shown", () => {
    expect(pendingPathOf(click({ href: "https://app.staygreen.io/app/monitors?app=a" }), here)).toBeNull();
  });

  it("marks nothing for a click that opens elsewhere or downloads", () => {
    expect(pendingPathOf(click({ button: 1 }), here)).toBeNull();
    expect(pendingPathOf(click({ modified: true }), here)).toBeNull();
    expect(pendingPathOf(click({ target: "_blank" }), here)).toBeNull();
    expect(pendingPathOf(click({ download: true }), here)).toBeNull();
  });

  it("marks nothing outside the dashboard", () => {
    expect(pendingPathOf(click({ href: "https://app.staygreen.io/s/acme" }), here)).toBeNull();
    expect(pendingPathOf(click({ href: "https://app.staygreen.io/application" }), here)).toBeNull();
    expect(pendingPathOf(click({ href: "https://example.com/app/monitors/mon_1" }), here)).toBeNull();
    expect(pendingPathOf(click({ href: "mailto:help@staygreen.io" }), here)).toBeNull();
  });
});

describe("kept screens", () => {
  it("are kept for less than the poll's interval, so none is older than polling allows", () => {
    expect(KEPT_SCREEN_S).toBe(30);
    expect(KEPT_SCREEN_S * 1000).toBeLessThan(POLL_MS);
  });
});

describe("the screens never shown from the router's keep", () => {
  const root = join(process.cwd(), "src/app/(app)/app");
  const pages: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      const path = dir ? `${dir}/${name}` : name;
      if (statSync(join(root, path)).isDirectory()) walk(path);
      else if (name === "page.tsx") pages.push(dir);
    }
  };
  walk("");
  const fresh = (page: string) => /^export const unstable_dynamicStaleTime = 0;$/m.test(readFileSync(join(root, page, "page.tsx"), "utf8"));

  it("are every screen of one thing (a monitor, an incident, a page, an app) and Settings, each fetched on every visit", () => {
    const ofOne = pages.filter((p) => p.includes("[") || p === "settings").sort();
    expect([...FRESH_ON_EVERY_VISIT].sort()).toEqual(ofOne);
    for (const page of FRESH_ON_EVERY_VISIT) expect(fresh(page), page).toBe(true);
  });

  it("leaves the lists kept, so moving between them stays quick", () => {
    for (const page of pages.filter((p) => !(FRESH_ON_EVERY_VISIT as readonly string[]).includes(p))) expect(fresh(page), page || "overview").toBe(false);
  });
});
