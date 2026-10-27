import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A monitor's numbers sit in one strip whose cells share a row on a phone, about 130px of text
// each, and the strip clips what spills (`overflow: hidden`, for its rounded corners). A number
// never wraps; a phrase in a number's place — a heartbeat's schedule, a DNS monitor's resolvers —
// must, or it is cut mid-word with nothing to say so (`2026-10-22`, review 31: "Every Wednes").
// The design method: no hidden tail stands in for text (`.claude/skills/design/references/method.md`).

const KIT = readFileSync(fileURLToPath(new URL("../../design/kit.css", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const at = KIT.split("}").find((block) => block.split("{")[0].trim() === selector);
  if (!at) throw new Error(`no rule for ${selector} in design/kit.css`);
  return at.split("{")[1];
}

describe("a stat's value", () => {
  it("keeps a number on one line", () => {
    expect(rule(".stat-value")).toMatch(/white-space:\s*nowrap/);
  });
  it("lets a phrase in a number's place wrap, and leaves an address to .addr", () => {
    expect(rule(".stat-value small:not(.addr)")).toMatch(/white-space:\s*normal/);
  });
});
