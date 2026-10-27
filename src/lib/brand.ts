import { colourDistance, parseColour, usableAccent } from "./colour";
import { attrs, markup, tagsOf } from "./html-read";

/* A site's brand colour, read from its own page, so a new status page for the app starts with
   it as its accent (`docs/flows.md § Suggested checks`). Pure: the suggestion run hands over what
   it fetched (the page, its stylesheets, its manifest's theme colour, its icon's main colour) and
   gets back candidates, ranked. The one model call a run makes may pick another of them
   (`site-model.ts`); nothing outside this list is ever an accent.

   Where a candidate comes from, strongest first:
   - **the background of what looks like the page's primary button**: a link or button with a
     class naming it primary or a call to action, or wearing a background utility (Tailwind's
     `bg-indigo-600`, `bg-[#635bff]`), resolved through the page's own CSS;
   - **a custom property named for the brand or its primary colour** (`--brand`, `--color-primary`,
     `--bs-primary`), on the page's root and never in its dark theme, `var()` chains followed;
   - **a CSS rule for a primary button** (`.btn-primary`, `.button--cta`);
   - **`<meta name="theme-color">`** and the manifest's **`theme_color`**;
   - **the icon's main saturated colour** (`icon-colour.ts`);
   - **an accent custom property** and **`msapplication-TileColor`**, the weakest.

   The same colour from several places is one candidate with every source, and ranks by all of
   them together. Neutral greys, near-black and near-white never count (`isBrandColour`). */

export type AccentSource = "button" | "brand-variable" | "primary-variable" | "primary-rule" | "theme-color" | "manifest" | "icon" | "accent-variable" | "tile";

const WEIGHT: Record<AccentSource, number> = {
  button: 4,
  "brand-variable": 4,
  "primary-variable": 3.5,
  "primary-rule": 3,
  "theme-color": 2.5,
  manifest: 2.5,
  icon: 2,
  "accent-variable": 1.5,
  tile: 1.5,
};

export type AccentCandidate = { hex: string; sources: AccentSource[]; score: number; detail: string[] };

export type BrandInputs = {
  html: string;
  /** The page's inline CSS and its stylesheets' text, in the order the page applies them. */
  css: readonly string[];
  manifestThemeColour?: string | null;
  iconColour?: string | null;
};

/** At most this many candidates go further: enough for every source to be heard. */
export const MAX_CANDIDATES = 8;
/** Colours this close are one colour written two ways (`colourDistance`). */
const SAME = 0.03;
/** How much CSS is read, in all. A site's own stylesheet is rarely more. */
const CSS_BUDGET = 1024 * 1024;

// ── CSS, read as text ──────────────────────────────────────────────────────

export type CssRule = { selector: string; decls: Map<string, string>; dark: boolean };

/** Every block of declarations, with its selector and whether a dark theme scopes it: a
 *  `.dark` or `[data-theme=dark]` selector, or a `prefers-color-scheme: dark` query around it.
 *  A brace-matching walk rather than a parser: at-rules nest, and what it can't follow it skips. */
export function cssRules(text: string): CssRule[] {
  const css = text.slice(0, CSS_BUDGET).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") {
      stack.push(css.slice(start, i).trim());
      start = i + 1;
    } else if (ch === "}") {
      const prelude = stack.pop();
      if (prelude !== undefined && !prelude.startsWith("@")) {
        const body = css.slice(start, i);
        if (body.includes(":")) {
          const decls = new Map<string, string>();
          for (const d of body.split(";")) {
            const at = d.indexOf(":");
            if (at > 0) decls.set(d.slice(0, at).trim().toLowerCase(), d.slice(at + 1).trim());
          }
          const context = [...stack, prelude].join(" ");
          out.push({ selector: prelude, decls, dark: DARK.test(context) });
        }
      }
      start = i + 1;
    } else if (ch === ";" && !stack.length) start = i + 1;
  }
  return out;
}

const DARK = /\.dark\b|\[data-(?:theme|mode|color-scheme)=["']?dark|prefers-color-scheme\s*:\s*dark|\.theme-dark\b/i;

/** A block on the page's root: `:root`, `:host`, `html`, `body`, or a light theme's attribute. A
 *  property a class scopes (`.host-askone { --brand: … }`) may belong to a widget, an embed or a
 *  demo inside the page rather than to the page (staygreen.io's own AskOne sample, 2026-10-23). */
const ROOT = /^(?::root|:host|html|body)(?![\w-])|^\[data-(?:theme|mode|color-scheme|bs-theme)=["']?light/i;
const onRoot = (selector: string) => selector.split(",").some((part) => ROOT.test(part.trim()));

/** Custom properties from every block that isn't a dark theme's, the last one written winning:
 *  the root's, and every block's with the root's taking precedence, which is what `var()` reads. */
function customProperties(rules: readonly CssRule[]): { root: Map<string, string>; all: Map<string, string> } {
  const root = new Map<string, string>();
  const scoped = new Map<string, string>();
  for (const r of rules) {
    if (r.dark) continue;
    const into = onRoot(r.selector) ? root : scoped;
    for (const [name, value] of r.decls) if (name.startsWith("--")) into.set(name, value);
  }
  return { root, all: new Map([...scoped, ...root]) };
}

/** `value` with each `var(--x, fallback)` replaced by what `--x` holds, four levels deep. */
function resolved(value: string, props: ReadonlyMap<string, string>, depth = 0): string {
  if (depth > 4 || !value.includes("var(")) return value;
  return resolved(
    value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (all, name: string, fallback?: string) => props.get(name.toLowerCase()) ?? fallback ?? all),
    props,
    depth + 1,
  );
}

/** The colour a `background` or `background-color` value paints, when it is one flat colour. */
function backgroundOf(decls: ReadonlyMap<string, string>, props: ReadonlyMap<string, string>): string | null {
  for (const name of ["background-color", "background"]) {
    const raw = decls.get(name);
    if (!raw) continue;
    const value = resolved(raw, props).trim();
    const hex = parseColour(value) ?? parseColour(value.split(/\s+(?![^(]*\))/)[0] ?? "");
    if (hex) return hex;
  }
  return null;
}

/* A property's name says what it is for. `--brand`, `--color-primary`, `--bs-primary`,
   `--chakra-colors-brand-500` and Radix's solid `--accent-9` are the colour; `--primary-foreground`
   is the text on it, `--primary-100` a wash, and `--color-graph-primary-stroke` or
   `--player-accent-color` a widget's own colour (measured on mastodon.social, 2026-10-22). */
const ROLE = /^(brand|primary|accent)$/;
const NOT_THE_COLOUR = /^(foreground|fg|text|contrast|content|on|bg|background|border|ring|muted|hover|active|focus|focused|pressed|disabled|light|lighter|lightest|dark|darker|darkest|subtle|soft|alpha|shadow|outline|graph|chart|stroke|player|syntax|code|highlight|selection|scrollbar|placeholder|50|100|200|300|800|900|950|1|2|3|4|5|6|7|11|12)$/;

function variableRole(name: string): AccentSource | null {
  if (!/^--[a-z0-9_-]{1,60}$/.test(name)) return null;
  const tokens = name.replace(/^--/, "").toLowerCase().split(/[-_]+/).filter(Boolean);
  const role = tokens.find((t) => ROLE.test(t));
  if (!role || tokens.some((t) => NOT_THE_COLOUR.test(t)) || tokens.length > 5) return null;
  return role === "brand" ? "brand-variable" : role === "primary" ? "primary-variable" : "accent-variable";
}

const PRIMARY_SELECTOR = /(?:btn|button|cta)[-_]{1,2}(?:primary|brand|cta|main)\b|\b(?:primary|brand)[-_]{1,2}(?:btn|button|cta)\b|\.cta\b|\[data-variant=["']?primary/i;
const STATEFUL = /:(?:hover|focus|focus-visible|focus-within|active|disabled|visited)|\[disabled|\[aria-disabled|\.(?:disabled|is-disabled)\b/i;

// ── the page's primary button ──────────────────────────────────────────────

/** CSS's escapes undone in a class selector: `.bg-\[\#635bff\]` is the class `bg-[#635bff]`. */
const unescapeCss = (s: string) => s.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1");

/** The background each single-class rule paints: `.bg-indigo-600 { background-color: … }`. */
function classBackgrounds(rules: readonly CssRule[], props: ReadonlyMap<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rules) {
    if (r.dark) continue;
    const m = /^\.((?:\\.|[\w-])+)$/.exec(r.selector);
    if (!m) continue;
    const hex = backgroundOf(r.decls, props);
    if (hex) out.set(unescapeCss(m[1]), hex);
  }
  return out;
}

const BG_UTILITY = /^bg-(?!white$|black$|transparent$|none$|clip-|cover$|contain$|center|fixed|local|scroll|repeat|no-repeat|opacity-|gradient|origin-|blend-|left|right|top|bottom|auto$|inherit$|current$|(?:gray|grey|slate|zinc|neutral|stone)-)/;

/** The backgrounds of the page's first few primary-looking links and buttons, in page order. */
function buttonBackgrounds(html: string, rules: readonly CssRule[], props: ReadonlyMap<string, string>): string[] {
  const byClass = classBackgrounds(rules, props);
  const out: string[] = [];
  let seen = 0;
  for (const m of markup(html).matchAll(/<(?:a|button)\b([^>]*)>/gi)) {
    if (++seen > 300 || out.length >= 3) break;
    const a = attrs(m[1]);
    const classes = (a.get("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 60);
    const style = a.get("style") ?? "";
    const named = classes.some((c) => /(?:^|[-_])(?:primary|cta)(?:$|[-_])/i.test(c)) || a.get("data-variant") === "primary";
    // A variant (`hover:bg-blue-700`, `dark:bg-…`) paints another state than the one a visitor sees.
    const utility = classes.filter((c) => !c.includes(":") && BG_UTILITY.test(c));
    if (!named && !utility.length && !/background/i.test(style)) continue;
    let hex: string | null = null;
    if (style) {
      const decls = new Map(style.split(";").map((d) => [d.slice(0, d.indexOf(":")).trim().toLowerCase(), d.slice(d.indexOf(":") + 1).trim()] as [string, string]));
      hex = backgroundOf(decls, props);
    }
    for (const c of [...utility, ...classes]) {
      if (hex) break;
      const arbitrary = /^bg-\[(.+)\]$/.exec(c);
      hex = arbitrary ? parseColour(arbitrary[1].replace(/_/g, " ")) : (byClass.get(c) ?? null);
    }
    if (hex) out.push(hex);
  }
  return out;
}

// ── meta tags ──────────────────────────────────────────────────────────────

function metaColours(html: string): { hex: string; source: AccentSource }[] {
  const out: { hex: string; source: AccentSource }[] = [];
  for (const a of tagsOf(html, "meta", 200)) {
    const name = (a.get("name") ?? "").toLowerCase();
    if (name !== "theme-color" && name !== "msapplication-tilecolor") continue;
    if (/dark/i.test(a.get("media") ?? "")) continue;
    const hex = parseColour(a.get("content") ?? "");
    if (hex) out.push({ hex, source: name === "theme-color" ? "theme-color" : "tile" });
  }
  return out;
}

// ── candidates ─────────────────────────────────────────────────────────────

/** Every colour the page offers as its brand, merged and ranked, the strongest first. */
export function accentCandidates(i: BrandInputs): AccentCandidate[] {
  const rules = i.css.flatMap((text) => cssRules(text));
  const { root, all: props } = customProperties(rules);
  const found: { hex: string; source: AccentSource; detail: string; weight?: number }[] = [];

  buttonBackgrounds(i.html, rules, props).forEach((hex, n) => found.push({ hex, source: "button", detail: n === 0 ? "the background of the page's first primary-looking button" : "the background of another primary-looking button" }));
  for (const [name, value] of props) {
    const role = variableRole(name);
    const hex = role ? parseColour(resolved(value, props)) : null;
    // A scale's lighter and darker solid steps rank just under its main one (500, 600, 9).
    const off = /[-_](?:400|700|8|10)$/.test(name) ? 0.5 : 0;
    // Only the root's own value speaks at full weight; one a class scopes is heard at half.
    const rooted = root.get(name) === value;
    if (role && hex) found.push({ hex, source: role, detail: `the CSS custom property ${name}${rooted ? "" : " on a scoped element"}`, weight: (WEIGHT[role] - off) * (rooted ? 1 : 0.5) });
  }
  for (const r of rules) {
    if (r.dark || !PRIMARY_SELECTOR.test(r.selector) || STATEFUL.test(r.selector)) continue;
    const hex = backgroundOf(r.decls, props);
    if (hex) found.push({ hex, source: "primary-rule", detail: "the background a CSS rule gives a primary button" });
  }
  for (const m of metaColours(i.html)) found.push({ ...m, detail: m.source === "theme-color" ? "the page's theme-color meta tag" : "the page's Windows tile colour" });
  const manifest = i.manifestThemeColour ? parseColour(i.manifestThemeColour) : null;
  if (manifest) found.push({ hex: manifest, source: "manifest", detail: "the web app manifest's theme_color" });
  if (i.iconColour) found.push({ hex: i.iconColour, source: "icon", detail: "the main colour of the site's icon" });

  // Each source counts once per candidate, at its strongest; the colour is named as the strongest
  // of all wrote it.
  const merged: { hex: string; detail: string[]; bySource: Map<AccentSource, number>; at: number; weight: number }[] = [];
  for (const f of found) {
    if (!usableAccent(f.hex)) continue;
    const weight = f.weight ?? WEIGHT[f.source];
    let same = merged.find((c) => colourDistance(c.hex, f.hex) < SAME);
    if (!same) {
      same = { hex: f.hex, detail: [], bySource: new Map(), at: merged.length, weight };
      merged.push(same);
    }
    if (!same.detail.includes(f.detail) && same.detail.length < 4) same.detail.push(f.detail);
    same.bySource.set(f.source, Math.max(same.bySource.get(f.source) ?? 0, weight));
    if (weight > same.weight) {
      same.hex = f.hex;
      same.weight = weight;
    }
  }
  return merged
    .map((c) => ({ hex: c.hex, sources: [...c.bySource.keys()], detail: c.detail, score: [...c.bySource.values()].reduce((a, b) => a + b, 0), at: c.at }))
    .sort((x, y) => y.score - x.score || x.at - y.at)
    .slice(0, MAX_CANDIDATES)
    .map(({ hex, sources, score, detail }) => ({ hex, sources, score, detail }));
}

/** The stylesheets a page links, on its own site, in order: the ones that can carry its brand. A
 *  stylesheet on another site (a font service, a widget's CDN) styles something else. */
export function stylesheetHrefs(html: string, pageUrl: string, base: string): string[] {
  const page = new URL(pageUrl);
  const out: string[] = [];
  for (const a of tagsOf(html, "link")) {
    const rel = (a.get("rel") ?? "").toLowerCase().split(/\s+/);
    const isSheet = rel.includes("stylesheet") || (rel.includes("preload") && a.get("as") === "style");
    if (!isSheet || rel.includes("alternate")) continue;
    try {
      const u = new URL(a.get("href") ?? "", base);
      if ((u.protocol === "https:" || u.protocol === "http:") && sameSite(u.hostname, page.hostname) && !out.includes(u.href)) out.push(u.href);
    } catch {
      // not an address
    }
  }
  return out;
}

/** The same host, or two hosts sharing their last two labels (`www.example.com` and
 *  `cdn.example.com`). Not the public suffix list: a miss here costs one candidate, never a fetch
 *  the guard wouldn't make anyway. */
export function sameSite(a: string, b: string): boolean {
  if (a === b) return true;
  const tail = (h: string) => h.toLowerCase().split(".").slice(-2).join(".");
  return /\./.test(a) && /\./.test(b) && !/^[\d.]+$/.test(a) && tail(a) === tail(b);
}
