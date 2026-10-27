/* Colours as a site writes them, read into the one form a status page's accent takes: six hex
   digits (`status_pages.accent`). And the question the suggestion run asks of each one it finds
   (`brand.ts`): is it a brand colour at all, or a grey, a near-black or a near-white.

   Pure and browser-safe. OKLCH is the same arithmetic as the design skill's
   `.claude/skills/design/scripts/color.py`, so a number here is the number that script prints. */

type Rgb = [number, number, number];

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const toHex = (rgb: Rgb) => `#${rgb.map((c) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, "0")).join("")}`;
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function channels(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** OKLab of a six-digit hex colour. */
export function oklab(hex: string): { L: number; a: number; b: number } {
  const [r, g, b] = channels(hex).map((c) => toLinear(c / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLCH: lightness 0 to 1, chroma, hue in degrees. */
export function oklch(hex: string): { L: number; C: number; H: number } {
  const { L, a, b } = oklab(hex);
  return { L, C: Math.hypot(a, b), H: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

function fromOklch(L: number, C: number, H: number): string {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb: Rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return toHex(rgb.map((c) => fromLinear(clamp(c)) * 255) as Rgb);
}

function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const hh = ((h % 360) + 360) % 360;
  const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x];
  return toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/** A number as CSS writes one: `12`, `.5`, `40%`, `120deg`. Percent and angle units are kept for
 *  the caller to read. */
const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const parts = (body: string) => body.trim().replace(/\s*\/\s*/, " / ").split(/[\s,]+/).filter(Boolean);
const num = (v: string | undefined) => (v !== undefined && new RegExp(`^${NUM}(%|deg)?$`, "i").test(v) ? parseFloat(v) : NaN);
const pct = (v: string | undefined, of: number) => (v?.endsWith("%") ? (num(v) / 100) * of : num(v));
/** Opaque enough to be a colour a page shows as itself, not a tint over something else. */
const OPAQUE = 0.9;
const alphaOk = (v: string | undefined) => v === undefined || pct(v, 1) >= OPAQUE;

/** A colour as written in CSS, a meta tag or a manifest, as six lowercase hex digits; null for
 *  anything else, a colour mostly transparent included. Reads hex (3, 4, 6 or 8 digits), `rgb()`,
 *  `hsl()` and `oklch()` in either syntax, and the bare channel lists design systems keep in
 *  custom properties to wrap later: `222 47% 11%` (HSL, as shadcn writes it) and `99 91 255`
 *  (RGB). Named colours are not read: a site's brand colour is never written as one. */
export function parseColour(raw: string): string | null {
  // An alpha left to a custom property, as Tailwind 3 writes every colour utility
  // (`rgb(79 70 229/var(--tw-bg-opacity))`), is the opacity the utility sets: 1.
  const v = raw.trim().toLowerCase().replace(/\s*!important$/, "").replace(/\s*[/,]\s*var\([^()]*\)\s*\)$/, ")");
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) {
      if (h.length === 4 && parseInt(h[3] + h[3], 16) / 255 < OPAQUE) return null;
      return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    }
    if (h.length === 6) return `#${h}`;
    if (h.length === 8) return parseInt(h.slice(6), 16) / 255 < OPAQUE ? null : `#${h.slice(0, 6)}`;
    return null;
  }
  m = /^(rgba?|hsla?|oklch)\(([^()]*)\)$/.exec(v);
  const [fn, body] = m ? [m[1], m[2]] : [null, v];
  const p = parts(body);
  const slash = p.indexOf("/");
  const values = slash >= 0 ? p.slice(0, slash) : p.slice(0, 3);
  const alpha = slash >= 0 ? p[slash + 1] : fn && !fn.startsWith("oklch") ? p[3] : undefined;
  if (values.length !== 3 || (!fn && p.length !== 3) || !alphaOk(alpha)) return null;
  if (fn?.startsWith("rgb") || (!fn && values.every((x) => /^\d{1,3}$/.test(x)))) {
    const rgb = values.map((x) => pct(x, 255)) as Rgb;
    return rgb.every((c) => Number.isFinite(c) && c >= 0 && c <= 255) ? toHex(rgb) : null;
  }
  if (fn?.startsWith("hsl") || (!fn && values[1].endsWith("%") && values[2].endsWith("%"))) {
    const [h, s, l] = [num(values[0].replace(/deg$/, "")), pct(values[1], 1), pct(values[2], 1)];
    return [h, s, l].every(Number.isFinite) && s >= 0 && s <= 1 && l >= 0 && l <= 1 ? fromHsl(h, s, l) : null;
  }
  if (fn === "oklch") {
    const [L, C, H] = [pct(values[0], 1), pct(values[1], 0.4), num(values[2].replace(/deg$/, ""))];
    return [L, C, H].every(Number.isFinite) && L >= 0 && L <= 1 && C >= 0 ? fromOklch(L, C, H) : null;
  }
  return null;
}

/* What counts as a brand colour, in OKLCH, measured with `color.py` (2026-10-22):
   - **Neutral:** chroma under 0.05. Tailwind's slates, the greys sites set text in, run 0.02 to
     0.042 (`#64748b` is 0.041); the navies brands use start at 0.06 (`#0a2540`, `#1b2a4a`).
   - **Near-black:** lightness under 0.22, whatever its hue: deep purple `#1a1033` and Tailwind's
     slate-900 `#0f172a` (both 0.21) read black; Stripe's navy `#0a2540` (0.26) reads navy.
   - **Near-white:** lightness over 0.9 with chroma under 0.1, the pale washes sites put behind
     content (`#e0e7ff`, 0.93 / 0.04). Pure yellow (0.97 / 0.21) stays a colour. */
export const NEUTRAL_CHROMA = 0.05;
export const NEAR_BLACK = 0.22;
export const NEAR_WHITE = { lightness: 0.9, chroma: 0.1 };

export function isBrandColour(hex: string): boolean {
  const { L, C } = oklch(hex);
  if (C < NEUTRAL_CHROMA || L < NEAR_BLACK) return false;
  return !(L > NEAR_WHITE.lightness && C < NEAR_WHITE.chroma);
}

/** How far apart two colours look: OKLab distance, where about 0.02 is the step a person stops
 *  telling apart side by side. */
export function colourDistance(x: string, y: string): number {
  const a = oklab(x);
  const b = oklab(y);
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
}

/** A colour a new status page may start with. Its shades come from `accentShades`, which already
 *  holds every contrast floor the kit sets for a page's accent in both themes, so a brand colour
 *  needs no test of its own beyond being one. */
export const usableAccent = isBrandColour;
