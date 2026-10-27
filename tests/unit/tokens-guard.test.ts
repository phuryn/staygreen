import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The token guard (`design/README.md § Files`, `AGENTS.md § 2.3` item 6):
// `design/tokens.css` holds every raw value and is the only file with colour
// literals; the kit and every surface read the tokens. "A stated invariant with
// no test is a comment" (`docs/TESTS.md`), so this is the test, inside `npm test`. It scans every .css and .tsx file under src/, and
// the kit's own stylesheets, and reports each literal as `file:line: literal`.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOKENS = join(ROOT, "design", "tokens.css");

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and the colour functions. Not an HTML entity (`&#123;`). */
const LITERAL = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\(/gi;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Comments are prose, not styles: blank them, keeping line numbers. */
function withoutComments(text: string, file: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (file.endsWith(".tsx")) out = out.replace(/^\s*\/\/.*$/gm, blank);
  return out;
}

function literalsIn(file: string): string[] {
  const lines = withoutComments(readFileSync(file, "utf8"), file).split("\n");
  return lines.flatMap((line, i) => [...line.matchAll(LITERAL)].map((m) => `${relative(ROOT, file).replace(/\\/g, "/")}:${i + 1}: ${m[0]}`));
}

const scanned = [...walk(join(ROOT, "src")).filter((f) => f.endsWith(".css") || f.endsWith(".tsx")), ...walk(join(ROOT, "design")).filter((f) => f.endsWith(".css") && f !== TOKENS)];

describe("colour literals", () => {
  it("are seen where they belong (the scanner can see one at all)", () => {
    expect(literalsIn(TOKENS).length).toBeGreaterThan(20);
  });

  it("scans the kit, the stylesheets and the components", () => {
    const names = scanned.map((f) => relative(ROOT, f).replace(/\\/g, "/"));
    expect(names).toEqual(expect.arrayContaining(["design/kit.css", "src/styles/app.css", "src/styles/status.css", "src/app/layout.tsx", "src/components/ui.tsx"]));
  });

  it("live only in design/tokens.css", () => {
    expect(scanned.flatMap(literalsIn)).toEqual([]);
  });
});
