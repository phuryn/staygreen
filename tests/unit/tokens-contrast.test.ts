import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The contrast floors of the theme choice (`AGENTS.md § 1.3`, `design/README.md`),
// read from `design/tokens.css` itself. Four sets reach a screen: the dashboard's
// light and dark, and a public status page's light and dark (`.public-neutral`).
// Each is resolved the way the cascade resolves it, so a token a set doesn't
// redefine is the one it inherits. Text needs 4.5:1 and an icon or a border 3:1
// (WCAG 1.4.3 and 1.4.11).
//
// Dark is written twice, once for the visitor's OS and once for an explicit
// choice, so the two copies must stay equal: one edited alone would give a
// visitor with no cookie a different page from one who picked dark.

const CSS = readFileSync(fileURLToPath(new URL("../../design/tokens.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

type Tokens = Record<string, string>;

/** The custom properties of the first rule whose selector list starts with `selector`. */
function block(selector: string): Tokens {
  const at = CSS.indexOf(selector);
  if (at < 0) throw new Error(`no rule for ${selector} in design/tokens.css`);
  const body = CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

/** A set with every `var()` resolved as the cascade resolves it on that element. A public page's
 *  accent tokens read the page's own `--page-*` values, which no stylesheet sets: they are each
 *  page's colour, shaded and tested in `tests/unit/accents.test.ts`. Here they resolve to the
 *  fallback a page without one wears. */
function resolved(set: Tokens): Tokens {
  const value = (v: string, depth = 0): string => {
    const m = /^var\(--([\w-]+)(?:,\s*(.+))?\)$/.exec(v);
    if (!m || depth > 8) return v;
    return value(m[1] in set ? set[m[1]] : (m[2] ?? ""), depth + 1);
  };
  return Object.fromEntries(Object.entries(set).map(([k, v]) => [k, value(v)]));
}

const light = block(":root,\n.theme-light");
const dark = { ...light, ...block(':root[data-theme="dark"]') };
const publicNeutral = block(".public-neutral {");
const sets: Record<string, Tokens> = {
  light,
  dark,
  "public light": resolved({ ...light, ...publicNeutral }),
  "public dark": resolved({ ...dark, ...publicNeutral, ...block(".public-neutral.theme-dark") }),
};

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`${hex} is not a six-digit colour`);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const TEXT: [string, string][] = [
  ["ink", "ground"],
  ["ink-2", "ground"],
  ["ink-3", "ground"],
  ["ink", "surface"],
  ["ink-2", "surface"],
  ["ink-2", "sunk"],
  ["ink-3", "surface"],
  ["ink-3", "sunk"],
  ["ink-3", "raised"],
  // The rail's current section, neutral (`design/README.md`, principle 1).
  ["ink", "current"],
  ["on-ink", "ink"],
  ["on-accent", "accent"],
  ["on-accent", "accent-hover"],
  ["accent-text", "surface"],
  ["accent-text", "sunk"],
  ["accent-text", "ground"],
  ["accent-text", "accent-wash"],
  ["accent-text", "wash-info"],
  ["down", "wash-down"],
  ["field-dark-ink", "field-dark"],
  ["field-dark-ink-2", "field-dark"],
  ["field-dark-ink-2", "field-dark-surface"],
  ["field-accent-ink", "field-accent"],
  ["field-accent-ink-2", "field-accent"],
];

// State icons, input borders and the unchecked ring, each beside a label that says the same; the
// accent as a focus ring, a switch that is on and a chosen card's border (on its wash), and the
// response chart's median line.
const NON_TEXT: [string, string][] = [
  ["up", "surface"],
  ["warn", "surface"],
  ["down", "surface"],
  ["paused", "surface"],
  ["edge", "surface"],
  // The same on the page itself: the overview's headline mark, a monitor's state, the list filters.
  ["up", "ground"],
  ["warn", "ground"],
  ["down", "ground"],
  ["paused", "ground"],
  ["edge", "ground"],
  ["up", "wash-up"],
  ["warn", "wash-warn"],
  ["accent", "surface"],
  ["accent", "ground"],
  ["accent", "accent-wash"],
  ["chart-p50", "surface"],
];

const floor = (set: Tokens, pairs: [string, string][], min: number) =>
  pairs.flatMap(([fg, bg]) => {
    const r = ratio(set[fg], set[bg]);
    return r < min ? [`--${fg} on --${bg}: ${r.toFixed(2)}`] : [];
  });

describe("the token sets", () => {
  it("are read: every pair names a colour in every set", () => {
    for (const set of Object.values(sets)) for (const [fg, bg] of [...TEXT, ...NON_TEXT]) expect([set[fg], set[bg]]).toEqual([expect.stringMatching(/^#[0-9a-f]{6}$/i), expect.stringMatching(/^#[0-9a-f]{6}$/i)]);
  });

  it("write dark the same for the visitor's OS as for an explicit choice", () => {
    expect(block(':root:not([data-theme="light"])')).toEqual(block(':root[data-theme="dark"]'));
    expect(block(".public-neutral.theme-visitor")).toEqual(block(".public-neutral.theme-dark"));
  });
});

describe.each(Object.keys(sets))("%s", (name) => {
  it("gives text 4.5:1 on every ground it sits on", () => {
    expect(floor(sets[name], TEXT, 4.5)).toEqual([]);
  });

  it("gives icons and borders 3:1", () => {
    expect(floor(sets[name], NON_TEXT, 3)).toEqual([]);
  });
});
