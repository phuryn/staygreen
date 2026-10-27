import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The front door reads no session (`AGENTS.md § 1.3`, `architecture.md § Template choices`):
// `/` and every public page are the same for everyone, so nothing under `src/app/(public)/`, the
// root layout, or the frame those pages render in (`src/components/landing/`) imports Clerk's
// server SDK or the session seam, calls `auth()` or `currentUser()`, or renders `<Show>`; and the
// root `<ClerkProvider>` takes no `dynamic`, which would read the session into every page it
// wraps. Comments are stripped first, since they name what they forbid.

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const code = (path: string) =>
  readFileSync(join(ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const SESSION_READ = [
  /from ["']@clerk\/nextjs\/server["']/,
  /from ["']@\/lib\/session["']/,
  /\bauth\(\)/,
  /\bcurrentUser\(\)/,
  /<Show[\s>]/,
];

describe("the front door reads no session", () => {
  const front = [...files("src/app/(public)"), "src/app/layout.tsx", ...files("src/components/landing")];

  it("nothing public imports the session or renders on it", () => {
    expect(front).toContain("src/app/(public)/page.tsx");
    expect(front).toContain("src/app/(public)/bot/page.tsx");
    for (const path of front) {
      const source = code(path);
      for (const re of SESSION_READ) expect(source, `${path} matches ${re}`).not.toMatch(re);
    }
  });

  it("the root provider takes the nonce and never `dynamic`", () => {
    const tag = /<ClerkProvider\b[^>]*>/.exec(code("src/app/layout.tsx"))?.[0] ?? "";
    expect(tag).toContain("nonce={nonce}");
    expect(tag).not.toMatch(/\bdynamic\b/);
  });
});
