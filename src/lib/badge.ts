import { headline, type PublicView } from "./public-page";
import type { State } from "./model";

/* The README badge (spec.md § 7): one standalone SVG of a status page's overall state. The route
   at `/s/<slug>/badge.svg` serves it from the public snapshot, and the widget screen's preview
   draws the same markup from the dashboard's workspace (`viewFromSim`), so the two can't disagree.

   It is an image on someone else's page, a README on GitHub's light or dark theme, so it can't
   read the kit's tokens. Its colours are the light set's, copied from `design/tokens.css`, and
   `tests/unit/badge.test.ts` holds them equal to the stylesheet and to their contrast floors.
   The page's name is the builder's text on a public URL: every string is XML-escaped here, and
   characters XML 1.0 can't carry are dropped, so no name can break the file or add to it. */

export const BADGE_COLOURS = {
  ink: "#0b0c0e",
  onInk: "#ffffff",
  surface: "#ffffff",
  line: "#d3d7de",
  washWarn: "#fdf3e1",
  washDown: "#fdecec",
  up: "#12a150",
  warn: "#c27a00",
  down: "#cc1f1f",
  paused: "#8a919d",
  unchecked: "#8a919d",
} as const;

const c = BADGE_COLOURS;
const HEIGHT = 20;
const LABEL_MAX = 40;

/** What the page's headline says, in a badge's few words. The state is the headline's own. */
const words: Record<State, string> = { up: "operational", degraded: "degraded", down: "outage", paused: "paused", unchecked: "not checked yet" };

// Characters XML 1.0 forbids, and a surrogate without its pair: either makes the whole file refuse to parse.
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text for an SVG element or attribute. */
export function xmlText(text: string): string {
  return text.replace(NOT_XML, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

type PageName = Pick<PublicView["page"], "name" | "logoText">;

/** The page's own name as its header shows it: the logo text, or the page name when there is none. */
export function badgeName(page: PageName): string {
  return (page.logoText.trim() || page.name.trim()).replace(NOT_XML, "").replace(/\s+/g, " ");
}

/** "Harbor status", for the image's alt text and title; a name that already says status keeps it. */
export function badgePhrase(page: PageName): string {
  const name = badgeName(page);
  return /\bstatus$/i.test(name) ? name : `${name} status`;
}

/** Verdana's advance widths at 11px, near enough. `textLength` fits the text to the box whatever
 *  font the viewer has, so this only decides how much room each word gets. */
function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (/[iljI.,:;!'|]/.test(ch)) w += 3.4;
    else if (/[ ftr()\-[\]]/.test(ch)) w += 4.4;
    else if (/[mwMW]/.test(ch)) w += 10;
    else if (/[A-Z]/.test(ch)) w += 7.6;
    else if (/[a-z0-9]/.test(ch)) w += 6.8;
    else w += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 11 : 7.2;
  }
  return Math.max(1, w);
}

/** `StateIcon`'s shapes (`src/components/State.tsx`) on its 16-unit grid, painted with fixed
 *  colours; `cut` is the fill behind the icon, which the strokes inside the shape are drawn in. */
function icon(state: State, cut: string): string {
  if (state === "up") return `<circle cx="8" cy="8" r="4.5" fill="${c.up}"/>`;
  if (state === "degraded")
    return `<path d="M8 1.2 15.2 14.3H.8z" fill="${c.warn}" stroke-linejoin="round"/><path d="M8 6v3.8" stroke="${cut}" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="12" r="1" fill="${cut}"/>`;
  if (state === "down")
    return `<rect x="1" y="1" width="14" height="14" rx="2.5" fill="${c.down}"/><path d="M5.3 5.3l5.4 5.4M10.7 5.3l-5.4 5.4" stroke="${cut}" stroke-width="1.9" stroke-linecap="round"/>`;
  if (state === "unchecked") return `<circle cx="8" cy="8" r="6.5" fill="none" stroke="${c.unchecked}" stroke-width="2"/>`;
  return `<circle cx="8" cy="8" r="7.5" fill="${c.paused}"/><path d="M6.2 5v6M9.8 5v6" stroke="${cut}" stroke-width="1.9" stroke-linecap="round"/>`;
}

const n = (x: number) => String(Math.round(x * 10) / 10);

export type Badge = { svg: string; width: number; height: number; state: State; label: string; word: string; title: string };

/** The badge for what a page shows: the Staygreen name on Free, the page's own name with white
 *  label (the same `poweredBy` that decides the page's footer), then its headline's state.
 *  "Operational" only when every component is up, as the page's headline has it. */
export function badgeFor(view: PublicView): Badge {
  const state = headline(view).state;
  const word = !view.components.length
    ? "nothing to show yet"
    : state === "up" && view.components.some((x) => x.state !== "up")
      ? "no problems found"
      : words[state];
  const chars = [...(view.page.poweredBy ? "Staygreen" : badgeName(view.page) || "Status")];
  const label = chars.length > LABEL_MAX ? `${chars.slice(0, LABEL_MAX - 1).join("")}…` : chars.join("");
  const title = `${badgePhrase(view.page)}: ${word}`;

  // A problem gets its tint; the word keeps the weight a healthy one has (design/README.md, weight does not mark state).
  const fill = state === "down" ? c.washDown : state === "degraded" ? c.washWarn : c.surface;
  const lt = textWidth(label);
  const wt = textWidth(word);
  const lw = Math.ceil(lt + 14);
  const rw = Math.ceil(wt + 31);
  const width = lw + rw;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img">` +
    `<title>${xmlText(title)}</title>` +
    `<rect width="${width}" height="${HEIGHT}" rx="3" fill="${fill}"/>` +
    `<path d="M3 0h${lw - 3}v${HEIGHT}H3a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3z" fill="${c.ink}"/>` +
    `<rect x=".5" y=".5" width="${width - 1}" height="${HEIGHT - 1}" rx="2.5" fill="none" stroke="${c.line}"/>` +
    `<g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="7" y="14" fill="${c.onInk}" textLength="${n(lt)}" lengthAdjust="spacingAndGlyphs">${xmlText(label)}</text>` +
    `<g transform="translate(${lw + 7} 4) scale(.75)">${icon(state, fill)}</g>` +
    `<text x="${lw + 24}" y="14" fill="${c.ink}" textLength="${n(wt)}" lengthAdjust="spacingAndGlyphs">${xmlText(word)}</text>` +
    `</g></svg>`;
  return { svg, width, height: HEIGHT, state, label, word, title };
}

/** The image as a `data:` address, for the widget screen's preview. */
export const badgeDataUrl = (b: Badge) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(b.svg)}`;

/** The Markdown a builder pastes into a README: the badge, linking to the page. `origin` is the
 *  app's public address (`APP_URL`); square brackets in the name are escaped so the link holds. */
export function badgeMarkdown(origin: string, page: PageName & { slug: string }): string {
  const alt = badgePhrase(page).replace(/[\\[\]]/g, "\\$&");
  const base = `${origin.replace(/\/+$/, "")}/s/${page.slug}`;
  return `[![${alt}](${base}/badge.svg)](${base})`;
}
