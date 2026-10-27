import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrast } from "@/lib/accents";
import { BADGE_COLOURS as C, badgeFor, badgeMarkdown, badgePhrase, xmlText } from "@/lib/badge";
import { headline, viewFromSim, type PublicView } from "@/lib/public-page";
import type { State } from "@/lib/model";
import { component, monitor, NOW, page, sim } from "./fixtures";

/* The README badge (`src/lib/badge.ts`): one standalone SVG on a public URL, carrying the
   builder's page name into someone else's README. What it may say is the page's own headline;
   what it may carry is escaped text and nothing else; and its fixed colours are the stylesheet's,
   at the floors the kit holds itself to. The browser's own XML parse of the served file is in
   `tests/e2e/public-pages.spec.ts`. */

const view = (states: State[], over: Partial<PublicView["page"]> = {}): PublicView => ({
  page: { slug: "harbor", name: "Harbor status", logoText: "Harbor", logoUrl: null, faviconUrl: null, homepage: "", accent: "#1F2DE6", theme: "light", poweredBy: true, noindex: false, historyDays: 90, ...over },
  components: states.map((state, i) => ({ key: String(i), name: `C${i}`, inApp: false, state, daily: [] })),
  incidents: [],
  updatedAt: null,
  now: NOW,
});

/** Tags balance, attributes are quoted, and every `&` starts one of XML's five entities: what a
 *  strict parser needs from a file with no comments, CDATA or doctype in it. */
function wellFormed(svg: string) {
  const stack: string[] = [];
  const text = svg.replace(/<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"<]*")*)\s*(\/?)>/g, (_m, close: string, name: string, _a: string, self: string) => {
    if (close) expect(stack.pop()).toBe(name);
    else if (!self) stack.push(name);
    return "";
  });
  expect(stack).toEqual([]);
  expect(text).not.toMatch(/[<>]/);
  expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
}

describe("what the badge says", () => {
  // The icon's shape for each state, as `StateIcon` draws it, in the badge's fixed colours.
  const shape: Record<State, string> = {
    up: `<circle cx="8" cy="8" r="4.5" fill="${C.up}"/>`,
    degraded: `<path d="M8 1.2 15.2 14.3H.8z" fill="${C.warn}"`,
    down: `<rect x="1" y="1" width="14" height="14" rx="2.5" fill="${C.down}"/>`,
    paused: `<circle cx="8" cy="8" r="7.5" fill="${C.paused}"/>`,
    unchecked: `<circle cx="8" cy="8" r="6.5" fill="none" stroke="${C.unchecked}"`,
  };

  it.each<[string, State[], State, string]>([
    ["every component up", ["up", "up"], "up", "operational"],
    ["one up beside a paused one", ["up", "paused"], "up", "no problems found"],
    ["one up beside one not checked yet", ["up", "unchecked"], "up", "no problems found"],
    ["one degraded", ["degraded", "up"], "degraded", "degraded"],
    ["one down beside a degraded one", ["down", "degraded"], "down", "outage"],
    ["everything paused", ["paused", "paused"], "paused", "paused"],
    ["nothing checked yet", ["unchecked", "paused"], "unchecked", "not checked yet"],
    ["no components at all", [], "unchecked", "nothing to show yet"],
  ])("%s: the page headline's state, in its own words", (_name, states, state, word) => {
    const v = view(states);
    const b = badgeFor(v);
    expect(b.state).toBe(headline(v).state);
    expect([b.state, b.word]).toEqual([state, word]);
    expect(b.svg).toContain(shape[state]);
    expect(b.svg).toContain(`>${word}</text>`);
    expect(b.svg).toContain(`<title>Harbor status: ${word}</title>`);
    wellFormed(b.svg);
  });

  it("is an image named by its title, with nothing in it that runs or fetches", () => {
    const b = badgeFor(view(["up"]));
    expect(b.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="\d+" height="20" viewBox="0 0 \d+ 20" role="img"><title>/);
    expect(b.svg).not.toMatch(/<script|<style|<image|<use|<foreignObject|href=|url\(|var\(|<!--/i);
    expect(b.svg).toContain(`width="${b.width}"`);
  });

  it("tints only a problem, and sets every state's word in the same weight", () => {
    expect(badgeFor(view(["down"])).svg).toContain(`fill="${C.washDown}"`);
    expect(badgeFor(view(["degraded"])).svg).toContain(`fill="${C.washWarn}"`);
    for (const st of ["down", "degraded"] as const) expect(badgeFor(view([st])).svg, st).not.toContain("font-weight");
    for (const st of ["up", "paused", "unchecked"] as const) {
      const svg = badgeFor(view([st])).svg;
      expect(svg, st).not.toContain("font-weight");
      expect(svg, st).not.toMatch(new RegExp(`${C.washDown}|${C.washWarn}`));
    }
  });
});

describe("whose name it carries", () => {
  it("carries the Staygreen name on Free, and only the page's own name with white label", () => {
    const free = badgeFor(view(["up"], { poweredBy: true }));
    expect(free.label).toBe("Staygreen");
    expect(free.svg).toContain(">Staygreen</text>");
    const white = badgeFor(view(["up"], { poweredBy: false }));
    expect(white.label).toBe("Harbor");
    expect(white.svg).toContain(">Harbor</text>");
    expect(white.svg).not.toContain("Staygreen");
  });

  it("takes the page name where the page has no logo text", () => {
    const b = badgeFor(view(["up"], { poweredBy: false, logoText: "  " }));
    expect(b.label).toBe("Harbor status");
    expect(b.title).toBe("Harbor status: operational");
  });

  it("follows the same switch as the page's Powered by Staygreen footer, which the plan decides", () => {
    const s = (plan: "free" | "builder") =>
      sim({ plan, apps: [{ id: "app_1", name: "Harbor", url: "", logoUrl: null, blurb: "", channelIds: [] }], monitors: [monitor({ id: "m1" })] });
    const p = page({ name: "Harbor status", logoText: "Harbor", poweredBy: false, components: [component({ id: "c1", monitorIds: ["m1"] })] });
    // Free can't remove the name, whatever the page row says; Builder can.
    expect(badgeFor(viewFromSim(s("free"), p)).label).toBe("Staygreen");
    expect(badgeFor(viewFromSim(s("builder"), p)).label).toBe("Harbor");
    expect(badgeFor(viewFromSim(s("builder"), { ...p, poweredBy: true })).label).toBe("Staygreen");
  });

  it("shortens a long name rather than drawing a badge wider than a README", () => {
    const b = badgeFor(view(["up"], { poweredBy: false, logoText: "", name: "N".repeat(80) }));
    expect([...b.label]).toHaveLength(40);
    expect(b.label.endsWith("…")).toBe(true);
    expect(b.width).toBeLessThan(500);
    expect(b.title).toBe(`${"N".repeat(80)} status: operational`);
  });
});

describe("the builder's text in it", () => {
  // Within the logo text's 40 characters, and trying to close the element it lands in.
  const hostile = `<i>"T" & 'J'</i></text><script>`;
  const escaped = "&lt;i&gt;&quot;T&quot; &amp; &apos;J&apos;&lt;/i&gt;&lt;/text&gt;&lt;script&gt;";

  it.each([true, false])("is escaped in the title and the label, poweredBy %s", (poweredBy) => {
    const b = badgeFor(view(["down"], { poweredBy, logoText: hostile, name: `${hostile} status` }));
    expect(b.svg).toContain(`<title>${escaped} status: outage</title>`);
    expect(b.svg.includes(`>${escaped}</text>`)).toBe(!poweredBy);
    expect(b.svg).not.toContain("<i>");
    expect(b.svg).not.toContain("<script");
    expect(b.svg).not.toContain(`"T"`);
    wellFormed(b.svg);
  });

  it("escapes all five of XML's specials", () => {
    expect(xmlText(`<a href="x" class='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; class=&apos;y&apos;&gt;&amp;&lt;/a&gt;");
  });

  it("drops what XML 1.0 can't carry, which would make the whole file refuse to parse", () => {
    const b = badgeFor(view(["up"], { poweredBy: false, logoText: "Har\u0001b\u001Fo\uFFFEr\uD800" }));
    expect(b.label).toBe("Harbor");
    expect(b.svg).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDFFF]/);
    // A real pair is a character, and stays.
    expect(badgeFor(view(["up"], { poweredBy: false, logoText: "Harbor \u{1F6A2}" })).label).toBe("Harbor \u{1F6A2}");
  });
});

describe("the Markdown a builder pastes", () => {
  it("is the badge linking to the page, on the app's own address", () => {
    expect(badgeMarkdown("https://staygreen.io", { slug: "harbor", name: "Harbor status", logoText: "Harbor" })).toBe(
      "[![Harbor status](https://staygreen.io/s/harbor/badge.svg)](https://staygreen.io/s/harbor)",
    );
    expect(badgeMarkdown("http://localhost:3101/", { slug: "harbor", name: "Harbor status", logoText: "" })).toBe(
      "[![Harbor status](http://localhost:3101/s/harbor/badge.svg)](http://localhost:3101/s/harbor)",
    );
  });

  it("keeps the link whole when the name has brackets in it", () => {
    expect(badgeMarkdown("https://staygreen.io", { slug: "harbor", name: "x", logoText: "Harbor [beta] \\o/" })).toBe(
      "[![Harbor \\[beta\\] \\\\o/ status](https://staygreen.io/s/harbor/badge.svg)](https://staygreen.io/s/harbor)",
    );
  });

  it("names the page once, whether or not its name already says status", () => {
    expect(badgePhrase({ name: "Harbor status", logoText: "" })).toBe("Harbor status");
    expect(badgePhrase({ name: "Harbor Status", logoText: "" })).toBe("Harbor Status");
    expect(badgePhrase({ name: "x", logoText: "Harbor" })).toBe("Harbor status");
  });
});

describe("its colours", () => {
  // The light set of `design/tokens.css`, read from the file, as `tokens-contrast.test.ts` does.
  const css = readFileSync(fileURLToPath(new URL("../../design/tokens.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const at = css.indexOf(":root,\n.theme-light");
  const light = Object.fromEntries([...css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at)).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  // GitHub's README grounds, light and dark: the badge sits on either.
  const GITHUB = { light: "#ffffff", dark: "#0d1117" };

  it("are the stylesheet's light set", () => {
    expect(C).toEqual({
      ink: light.ink,
      onInk: light["on-ink"],
      surface: light.surface,
      line: light["line-strong"],
      washWarn: light["wash-warn"],
      washDown: light["wash-down"],
      up: light.up,
      warn: light.warn,
      down: light.down,
      paused: light.paused,
      unchecked: light.edge,
    });
  });

  it("read at the kit's floors: text 4.5:1, a state's shape 3:1 on the fill behind it", () => {
    expect(contrast(C.onInk, C.ink)).toBeGreaterThanOrEqual(4.5);
    for (const fill of [C.surface, C.washWarn, C.washDown]) expect(contrast(C.ink, fill)).toBeGreaterThanOrEqual(4.5);
    for (const [shape, fill] of [[C.up, C.surface], [C.warn, C.washWarn], [C.down, C.washDown], [C.paused, C.surface], [C.unchecked, C.surface]]) {
      expect(contrast(shape, fill), shape).toBeGreaterThanOrEqual(3);
    }
  });

  it("stand off a light and a dark README alike", () => {
    expect(contrast(C.ink, GITHUB.light)).toBeGreaterThanOrEqual(3);
    for (const fill of [C.surface, C.washWarn, C.washDown]) expect(contrast(fill, GITHUB.dark)).toBeGreaterThanOrEqual(3);
  });
});
