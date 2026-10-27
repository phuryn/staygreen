// The accent presets the status page editor offers. These are data, a builder's choice for their
// own page, never the dashboard's colours, which live only in `design/tokens.css`. The page stores
// whichever hex the builder picks (`status_pages.accent`).
export const ACCENT_PRESETS = [
  { hex: "#f5a524", name: "Amber" },
  { hex: "#2f6f9f", name: "Blue" },
  { hex: "#7c4dcc", name: "Violet" },
  { hex: "#0e7c86", name: "Teal" },
  { hex: "#c43d7a", name: "Raspberry" },
  { hex: "#4a5560", name: "Graphite" },
] as const;

/* What the accent does on a public page: the page's own controls, never a status and never a fill
   behind content (`design/README.md § Surfaces pinned outside the theme`). The builder picks one
   colour; each theme gets the shade of its hue that reads there (WCAG 2.2 § 1.4.3 and § 1.4.11),
   and a colour that already reads keeps exactly the value picked.

   A shade moves only HSL lightness. Hue and saturation stay, and every channel rises with
   lightness, so contrast against a ground is monotonic in it and a search finds the nearest
   passing shade. Black passes on the light grounds and white on the dark ones, so a shade always
   exists, and the one found sits strictly between them, so a colour with a hue keeps it. */

export type AccentTheme = "light" | "dark";
export type AccentShades = {
  /** The focus ring, a selected or pressed control, and the one filled button: 3:1 on the grounds. */
  accent: string;
  /** The filled button under the pointer, still 3:1, with the same ink passing on it. */
  hover: string;
  /** Links: 4.5:1 on the grounds. */
  text: string;
  /** The theme's dark or light ink, whichever reads at 4.5:1 on `accent`. */
  onAccent: string;
};

/** The `.public-neutral` sets in `design/tokens.css`: the grounds a page's controls sit on
 *  (`--ground`, `--surface`) and its two inks (`--ink`, `--on-ink`). Copied, because the shades
 *  are computed in the browser and on the server alike; `tests/unit/accents.test.ts` holds the
 *  copy equal to the stylesheet. */
export const PAGE_NEUTRALS: Record<AccentTheme, { grounds: readonly string[]; inks: readonly string[] }> = {
  light: { grounds: ["#ffffff", "#ffffff"], inks: ["#111113", "#ffffff"] },
  dark: { grounds: ["#0f0f11", "#17171a"], inks: ["#f1f1f3", "#0f0f11"] },
};

export const TEXT_RATIO = 4.5;
export const MARK_RATIO = 3;

export const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v);

type Rgb = [number, number, number];
const rgbOf = (hex: string): Rgb => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const hexOf = (rgb: Rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;

/** WCAG relative luminance of a six-digit hex colour. */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue in degrees, saturation and lightness from 0 to 1. */
export function hslOf(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = rgbOf(hex).map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return hexOf([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

const passes = (hex: string, against: readonly string[], ratio: number) => against.every((g) => contrast(hex, g) >= ratio);

/** The lightness nearest `hex`'s own, going `direction`, at which `ok` holds. `ok` must flip at
 *  most once along the way and hold at the far end (black or white). The search tests the rounded
 *  hex, so what it returns is what it checked. */
function nearest(hex: string, direction: "darker" | "lighter", ok: (hex: string) => boolean): string {
  if (ok(hex)) return hex.toLowerCase();
  const { h, s, l } = hslOf(hex);
  let fails = l;
  let holds = direction === "darker" ? 0 : 1;
  for (let i = 0; i < 32; i++) {
    const mid = (fails + holds) / 2;
    if (ok(fromHsl(h, s, mid))) holds = mid;
    else fails = mid;
  }
  return fromHsl(h, s, holds);
}

/** The shade of `hex`'s hue nearest to it that reads at `ratio` on every ground of `theme`. */
export function shadeFor(hex: string, theme: AccentTheme, ratio: number): string {
  return nearest(hex, theme === "light" ? "darker" : "lighter", (c) => passes(c, PAGE_NEUTRALS[theme].grounds, ratio));
}

const inkOn = (fill: string, theme: AccentTheme) => {
  const [a, b] = PAGE_NEUTRALS[theme].inks;
  return contrast(a, fill) >= contrast(b, fill) ? a : b;
};

export function accentShades(hex: string, theme: AccentTheme): AccentShades {
  const { grounds } = PAGE_NEUTRALS[theme];
  // A mid-tone can read on the grounds while neither ink reads on it, so the fill moves on, away
  // from the grounds, until one does. Moving away only gains it contrast with them.
  const accent = nearest(shadeFor(hex, theme, MARK_RATIO), theme === "light" ? "darker" : "lighter", (c) => contrast(inkOn(c, theme), c) >= TEXT_RATIO);
  const onAccent = inkOn(accent, theme);
  // Hover steps away from the ink, which only gains the ink contrast, unless that loses the
  // grounds; then towards it, by less each time; and if nothing holds, hover is the accent.
  const { h, s, l } = hslOf(accent);
  const fromInk = luminance(onAccent) > luminance(accent) ? -1 : 1;
  const hover = [0.06, 0.04, 0.02]
    .flatMap((step) => [fromInk * step, -fromInk * step])
    .map((step) => fromHsl(h, s, Math.min(1, Math.max(0, l + step))))
    .find((c) => c !== accent && passes(c, grounds, MARK_RATIO) && contrast(onAccent, c) >= TEXT_RATIO) ?? accent;
  return { accent, hover, text: shadeFor(hex, theme, TEXT_RATIO), onAccent };
}

/** The custom properties a public page sets on its own element, for both themes; `design/tokens.css`
 *  maps them onto `--accent`, `--accent-hover`, `--accent-text` and `--on-accent` for the theme the
 *  page shows. An invalid colour sets none, and the page falls back to its ink. */
export function accentStyle(hex: string): Record<`--page-${string}`, string> {
  const out: Record<`--page-${string}`, string> = {};
  if (!isHex(hex)) return out;
  for (const theme of ["light", "dark"] as const) {
    const s = accentShades(hex, theme);
    out[`--page-accent-${theme}`] = s.accent;
    out[`--page-accent-hover-${theme}`] = s.hover;
    out[`--page-accent-text-${theme}`] = s.text;
    out[`--page-on-accent-${theme}`] = s.onAccent;
  }
  return out;
}
