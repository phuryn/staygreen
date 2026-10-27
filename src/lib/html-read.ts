/* Reading the parts of a page someone else wrote that the suggestion run needs: tags and their
   attributes, the page's base address, and the text of its `<style>` blocks. Regular
   expressions over text, never a DOM: nothing is parsed into anything that could run, fetch or
   load, and what a malformed page yields is fewer matches, never an error.

   Pure and browser-safe. */

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const BASE = /<base\b([^>]*)>/i;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#x27": "'", "#x2f": "/", "#47": "/", "#35": "#", "#x23": "#" };
export const decodeEntities = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => ENTITIES[e.toLowerCase()] ?? all);

/** A tag's attributes, names lowercased, the first of a repeated name kept, entities decoded. */
export function attrs(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(ATTR)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

/** The page with its comments, scripts' bodies and styles' bodies taken out, so a tag written
 *  inside one of them is never read as the page's own. */
export function markup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<script\b[^>]*>)[\s\S]*?<\/script\s*>/gi, "$1</script>")
    .replace(/(<style\b[^>]*>)[\s\S]*?<\/style\s*>/gi, "$1</style>");
}

/** Every opening tag of `name` in the page, in order, as its attributes. */
export function tagsOf(html: string, name: string, limit = 500): Map<string, string>[] {
  const re = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  const out: Map<string, string>[] = [];
  for (const m of markup(html).matchAll(re)) {
    out.push(attrs(m[1]));
    if (out.length >= limit) break;
  }
  return out;
}

/** An http, https or (for images) data address, resolved against `base`; null for anything else. */
export function resolvedUrl(href: string, base: string, data = false): string | null {
  const h = href.trim();
  if (!h) return null;
  if (data && /^data:image\//i.test(h)) return h;
  try {
    const u = new URL(h, base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** The address the page's relative links resolve against: its `<base href>`, else its own. */
export function baseOf(html: string, pageUrl: string): string {
  const tag = BASE.exec(markup(html));
  const href = tag ? attrs(tag[1]).get("href") : undefined;
  return (href && resolvedUrl(href, pageUrl)) || pageUrl;
}

/** The text of the page's `<style>` blocks and of the `style` attributes on `<html>` and
 *  `<body>`, where a site sets its custom properties inline. */
export function inlineCss(html: string): string {
  const text = html.replace(/<!--[\s\S]*?-->/g, "");
  const blocks = [...text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]);
  for (const name of ["html", "body"]) {
    const style = tagsOf(text, name, 1)[0]?.get("style");
    if (style) blocks.push(`${name}{${style}}`);
  }
  return blocks.join("\n");
}

