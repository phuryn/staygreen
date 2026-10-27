import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// One look per button role (`design/README.md § Buttons`). The quiet button (`.btn-quiet`, no
// border at rest) is for an icon-only button that says what it does in its `aria-label`, and for a
// toggle in a panel's own head. Every other text button that isn't the primary is the bordered
// `.btn`: a borderless Cancel beside a filled primary reads as a label, not as something to press.
// "A stated invariant with no test is a comment" (`tokens-guard.test.ts`), so this is the test. It
// reads every `.tsx` and `.ts` file under `src/`, finds each opening tag whose class names
// `btn-quiet`, and reports `file:line: tag` for one that is neither an icon button nor allowed below.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Quiet text buttons that are allowed, each with why. Every entry must still match exactly one
 *  tag, so the list can't outlive the button it excuses. */
const ALLOWED: { file: string; has: string; why: string }[] = [
  {
    file: "src/components/charts.tsx",
    has: "aria-pressed={asTable}",
    why: "Show table / Show chart: a toggle in the chart panel's own head, beside its legend",
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Where the JSX opening tag that starts at `start` ends: the `>` outside every quote and brace. */
function tagEnd(src: string, start: number): number {
  type Mode = "tag" | "code" | "tpl" | '"' | "'";
  const stack: Mode[] = ["tag"];
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    const mode = stack[stack.length - 1];
    if (mode === '"' || mode === "'") {
      if (c === "\\") i++;
      else if (c === mode) stack.pop();
    } else if (mode === "tpl") {
      if (c === "\\") i++;
      else if (c === "`") stack.pop();
      else if (c === "$" && src[i + 1] === "{") { stack.push("code"); i++; }
    } else if (c === '"' || c === "'") stack.push(c);
    else if (c === "`" && mode === "code") stack.push("tpl");
    else if (c === "{") stack.push("code");
    else if (c === "}" && mode === "code") stack.pop();
    else if (c === ">" && mode === "tag") return i;
  }
  return -1;
}

type Quiet = { file: string; line: number; tag: string; className: string };

/** Every opening tag whose class names `btn-quiet`, with the class string that names it. */
function quietTags(file: string): Quiet[] {
  const src = readFileSync(file, "utf8");
  const name = relative(ROOT, file).replace(/\\/g, "/");
  const out: Quiet[] = [];
  for (const m of src.matchAll(/\bbtn-quiet\b/g)) {
    const at = m.index!;
    // The innermost tag around it: the nearest `<Name` before it whose tag reaches past it.
    const starts = [...src.slice(0, at).matchAll(/<[A-Za-z][\w.]*(?=[\s>/])/g)].map((s) => s.index!).reverse();
    const start = starts.find((s) => tagEnd(src, s) > at);
    if (start === undefined) continue;
    const tag = src.slice(start, tagEnd(src, start) + 1);
    const offset = at - start;
    const literal = [...tag.matchAll(/"[^"]*"|'[^']*'|`[^`]*`/g)].find((l) => l.index! <= offset && offset < l.index! + l[0].length);
    out.push({ file: name, line: src.slice(0, at).split("\n").length, tag: tag.replace(/\s+/g, " "), className: literal?.[0] ?? "" });
  }
  return out;
}

const all = walk(join(ROOT, "src"))
  .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
  .flatMap(quietTags);

const isIcon = (q: Quiet) => /\bbtn-icon\b/.test(q.className) && /\saria-label=/.test(q.tag);
const allowedBy = (q: Quiet) => ALLOWED.find((a) => a.file === q.file && q.tag.includes(a.has));

describe("quiet buttons", () => {
  it("are seen where they belong (the scanner finds the icon buttons)", () => {
    const icons = all.filter(isIcon).map((q) => q.file);
    expect(icons).toEqual(expect.arrayContaining(["src/components/Shell.tsx", "src/app/(app)/app/monitors/[id]/MonitorScreen.tsx"]));
    expect(icons.length).toBeGreaterThanOrEqual(6);
  });

  it("are icon-only buttons with an aria-label, or an allowed in-panel toggle", () => {
    const wrong = all.filter((q) => !isIcon(q) && !allowedBy(q)).map((q) => `${q.file}:${q.line}: ${q.tag}`);
    expect(wrong).toEqual([]);
  });

  it("each allowed toggle is still there, once", () => {
    for (const a of ALLOWED) {
      expect(all.filter((q) => allowedBy(q) === a), `${a.file}: ${a.why}`).toHaveLength(1);
    }
  });

  it("an icon button's class keeps btn-icon, and its tag an aria-label", () => {
    // The guard's own rule, against two tags it must refuse: a quiet text button, and an icon
    // button with no name for a screen reader.
    const text: Quiet = { file: "x.tsx", line: 1, tag: '<button type="button" className="btn btn-quiet">Cancel</button>', className: '"btn btn-quiet"' };
    const unnamed: Quiet = { file: "x.tsx", line: 1, tag: '<button type="button" className="btn btn-quiet btn-icon">', className: '"btn btn-quiet btn-icon"' };
    expect(isIcon(text) || !!allowedBy(text)).toBe(false);
    expect(isIcon(unnamed)).toBe(false);
  });
});
