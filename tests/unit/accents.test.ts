import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS, accentShades, accentStyle, contrast, hslOf, MARK_RATIO, PAGE_NEUTRALS, TEXT_RATIO, type AccentTheme } from "@/lib/accents";

// A status page's accent (`design/README.md § Surfaces pinned outside the theme`): the builder's
// one colour, shaded per theme so it reads on that theme's grounds (WCAG 2.2: 4.5:1 for link
// text, 3:1 for the focus ring and other marks), and kept exactly where it already reads. The
// ratios are pinned here over every preset and the extremes; the stylesheet's half, which maps
// the shades onto the kit's tokens for the theme a page shows, is pinned below it.

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const TOKENS = read("design/tokens.css");

/** The custom properties of the first rule whose selector starts with `selector`. */
function block(selector: string): Record<string, string> {
  const at = TOKENS.indexOf(selector);
  if (at < 0) throw new Error(`no rule for ${selector} in design/tokens.css`);
  const body = TOKENS.slice(TOKENS.indexOf("{", at) + 1, TOKENS.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const EXTREMES = [
  ["pure yellow", "#ffff00"],
  ["navy", "#1b2a4a"],
  ["pure navy", "#000080"],
  ["pure grey", "#808080"],
  ["black", "#000000"],
  ["white", "#ffffff"],
  ["pure red", "#ff0000"],
  ["pure green", "#00ff00"],
  ["Staygreen's cobalt, the default", "#1F2DE6"],
] as const;
const COLOURS = [...ACCENT_PRESETS.map((p) => [p.name, p.hex] as const), ...EXTREMES];
const THEMES: AccentTheme[] = ["light", "dark"];

const worst = (hex: string, theme: AccentTheme) => Math.min(...PAGE_NEUTRALS[theme].grounds.map((g) => contrast(hex, g)));
const hueGap = (a: string, b: string) => {
  const d = Math.abs(hslOf(a).h - hslOf(b).h) % 360;
  return Math.min(d, 360 - d);
};

describe("the grounds and inks the shades are computed against", () => {
  it("are the page's own, as design/tokens.css sets them", () => {
    const light = block(".public-neutral {");
    const dark = block(".public-neutral.theme-dark");
    expect(PAGE_NEUTRALS.light).toEqual({ grounds: [light.ground, light.surface], inks: [light.ink, light["on-ink"]] });
    expect(PAGE_NEUTRALS.dark).toEqual({ grounds: [dark.ground, dark.surface], inks: [dark.ink, dark["on-ink"]] });
  });
});

describe.each(THEMES)("on a %s page", (theme) => {
  it.each(COLOURS)("%s (%s): links 4.5:1, marks 3:1, and an ink that reads 4.5:1 on the fill", (_, hex) => {
    const s = accentShades(hex, theme);
    expect(worst(s.text, theme)).toBeGreaterThanOrEqual(TEXT_RATIO);
    expect(worst(s.accent, theme)).toBeGreaterThanOrEqual(MARK_RATIO);
    expect(worst(s.hover, theme)).toBeGreaterThanOrEqual(MARK_RATIO);
    expect(PAGE_NEUTRALS[theme].inks).toContain(s.onAccent);
    expect(contrast(s.onAccent, s.accent)).toBeGreaterThanOrEqual(TEXT_RATIO);
    expect(contrast(s.onAccent, s.hover)).toBeGreaterThanOrEqual(TEXT_RATIO);
  });

  it.each(COLOURS)("%s (%s): keeps its hue, and stays a colour, wherever it has one", (_, hex) => {
    const s = accentShades(hex, theme);
    for (const shade of [s.text, s.accent, s.hover]) {
      if (hslOf(hex).s === 0) expect(hslOf(shade).s, shade).toBe(0);
      else {
        // Within what rounding to whole channel values moves it: Graphite, the least saturated
        // preset, drifts 2 degrees.
        expect(hueGap(shade, hex), shade).toBeLessThanOrEqual(3);
        expect(hslOf(shade).s, shade).toBeGreaterThan(0);
      }
    }
  });

  it("holds the ratios and the hue across the colour wheel", () => {
    const misses: string[] = [];
    for (let h = 0; h < 360; h += 10) for (const s of [25, 50, 75, 100]) for (const l of [10, 25, 40, 55, 70, 85, 95]) {
      const hex = hsl(h, s, l);
      const out = accentShades(hex, theme);
      if (worst(out.text, theme) < TEXT_RATIO || worst(out.accent, theme) < MARK_RATIO || contrast(out.onAccent, out.accent) < TEXT_RATIO) misses.push(`${hex} ratio`);
      if (hslOf(hex).s > 0 && [out.text, out.accent].some((c) => hueGap(c, hex) > 3)) misses.push(`${hex} hue -> ${out.text} ${out.accent}`);
    }
    expect(misses).toEqual([]);
  });
});

describe("a colour that already reads is used exactly as picked", () => {
  it.each([
    ["Blue on a light page", "#2f6f9f", "light"],
    ["Violet on a light page", "#7c4dcc", "light"],
    ["Graphite on a light page", "#4a5560", "light"],
    ["navy on a light page", "#1b2a4a", "light"],
    ["Amber on a dark page", "#f5a524", "dark"],
    ["pure yellow on a dark page", "#ffff00", "dark"],
  ] as const)("%s", (_, hex, theme) => {
    const s = accentShades(hex, theme);
    expect([s.text, s.accent]).toEqual([hex, hex]);
  });

  it("and a colour that doesn't is moved only as far as its ratio needs", () => {
    // Pure yellow on white darkens to an olive that just reads, not to black.
    const yellow = accentShades("#ffff00", "light");
    expect(contrast(yellow.text, "#ffffff")).toBeLessThan(TEXT_RATIO + 0.15);
    // Navy on near-black lightens to a blue that just reads, not to white.
    const navy = accentShades("#1b2a4a", "dark");
    expect(worst(navy.text, "dark")).toBeLessThan(TEXT_RATIO + 0.15);
    expect(worst(navy.accent, "dark")).toBeLessThan(MARK_RATIO + 0.15);
  });

  it("matches in any case the builder typed it", () => {
    expect(accentShades("#2F6F9F", "light")).toEqual(accentShades("#2f6f9f", "light"));
  });
});

describe("the page's custom properties", () => {
  it("carry both themes' shades, so the stylesheet can follow the visitor", () => {
    const style = accentStyle("#2f6f9f");
    for (const theme of THEMES) {
      const s = accentShades("#2f6f9f", theme);
      expect(style).toMatchObject({
        [`--page-accent-${theme}`]: s.accent, [`--page-accent-hover-${theme}`]: s.hover,
        [`--page-accent-text-${theme}`]: s.text, [`--page-on-accent-${theme}`]: s.onAccent,
      });
    }
    expect(Object.keys(style)).toHaveLength(8);
  });

  it("are left unset for a colour that isn't one, so the page wears its ink", () => {
    expect(accentStyle("not a colour")).toEqual({});
  });
});

describe("the stylesheet", () => {
  const mapping = (theme: AccentTheme) => ({
    accent: `var(--page-accent-${theme}, var(--ink))`,
    "accent-hover": `var(--page-accent-hover-${theme}, var(--ink-2))`,
    "accent-text": `var(--page-accent-text-${theme}, var(--ink))`,
    "on-accent": `var(--page-on-accent-${theme}, var(--on-ink))`,
  });

  it("gives a light page the light shades, a dark page the dark ones, and a follow-the-visitor page the dark ones only under a dark preference", () => {
    expect(block(".public-neutral {")).toMatchObject(mapping("light"));
    expect(block(".public-neutral.theme-dark")).toMatchObject(mapping("dark"));
    const media = TOKENS.slice(TOKENS.lastIndexOf("@media (prefers-color-scheme: dark)"));
    expect(media).toContain(".public-neutral.theme-visitor");
    expect(block("@media (prefers-color-scheme: dark) {\n  .public-neutral.theme-visitor")).toMatchObject(mapping("dark"));
  });

  it("puts those tokens on the page's controls: its links, its focus ring and a filled button", () => {
    const kit = read("design/kit.css");
    expect(kit).toMatch(/:where\(:focus-visible\)\s*\{\s*outline:\s*var\(--rule\) solid var\(--accent\)/);
    expect(kit).toMatch(/\.link\s*\{\s*color:\s*var\(--accent-text\)/);
    expect(kit).toMatch(/\.btn-primary\s*\{\s*background:\s*var\(--accent\);\s*color:\s*var\(--on-accent\)/);
    expect(read("src/styles/status.css")).toMatch(/\.sp-home\s*\{[^}]*color:\s*var\(--accent-text\)/);
  });

  it("is fed by every public surface that wears a page's colour, and nothing still reads the raw pick", () => {
    for (const file of ["src/components/status/StatusPageView.tsx", "src/app/(app)/app/widget/WidgetScreen.tsx"]) {
      const source = read(file);
      expect(source, file).toContain("style={accentStyle(page.accent) as CSSProperties}");
      expect(source, file).not.toContain('"--brand": page.accent');
    }
  });
});

function hsl(h: number, s: number, l: number): string {
  const [S, L] = [s / 100, l / 100];
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => Math.round(255 * (L - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
