import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { linkSchema, NOTE_STATES, pageDraftErrors, pageDraftSchema, RESERVED_SLUGS, type PageDraft } from "@/lib/page-input";

/* What the status page editor sends (`src/lib/page-input.ts`), validated in
   the browser, again in `actions.ts`, and a third time by the table checks in
   `supabase/migrations/`. The first problem per field, keyed as the editor
   names its fields. */

const MON = "mon_0123456789abcdef01234567";

const draft = (over: Partial<PageDraft> = {}): PageDraft => ({
  slug: "askone",
  name: "AskOne status",
  logoText: "AskOne",
  homepage: "https://askone.org",
  accent: "#1F2DE6",
  theme: "visitor",
  poweredBy: true,
  noindex: false,
  historyDays: 90,
  components: [{ name: "API", inApp: true, monitorIds: [MON] }],
  ...over,
});

const fields = (d: unknown) => Object.keys(pageDraftErrors(d)).sort();

/** Every migration, in order: the third copy of these rules (read as text; no database). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");

/** The message the schema gives a slug that is merely the wrong shape. */
const SHAPE = pageDraftErrors(draft({ slug: "-x" })).slug;

describe("a valid draft", () => {
  it("has no errors", () => {
    expect(pageDraftErrors(draft())).toEqual({});
  });

  it("lowercases and trims the slug", () => {
    expect(pageDraftSchema.parse(draft({ slug: "  AskOne  " })).slug).toBe("askone");
  });

  it.each(["a", "a1", "my-app", "0day", "a".repeat(40), `a${"-".repeat(38)}b`])("accepts the slug %j", (slug) => {
    expect(pageDraftErrors(draft({ slug }))).toEqual({});
  });

  it.each(["", "https://askone.org", "http://askone.org/status"])("accepts the homepage %j", (homepage) => {
    expect(pageDraftErrors(draft({ homepage }))).toEqual({});
  });

  // Every visitor gets the href in full, and a click sends the credentials as Basic auth.
  it.each(["https://user:token@askone.org", "https://user@askone.org/health", "http://:secret@askone.org"])("refuses credentials in the homepage %j", (homepage) => {
    expect(pageDraftErrors(draft({ homepage })).homepage).toMatch(/credentials/);
  });

  // An address the parser rejects can't be checked for credentials, so it isn't stored either.
  it.each(["https://admin:s3cret@askone.org:99999", "https://admin:s3cret@askone.org:abc", "https://admin:s3cret@", "https://askone.org:99999"])("refuses a homepage a browser can't parse, %j", (homepage) => {
    expect(pageDraftErrors(draft({ homepage })).homepage).toMatch(/browser can open/);
    expect(linkSchema.safeParse(homepage).success).toBe(false);
  });

  it("holds an app's address, which a new page takes as its homepage, to the same rule", () => {
    expect(linkSchema.safeParse("https://user:token@askone.org").success).toBe(false);
    expect(linkSchema.safeParse("HTTPS://askone.org").success).toBe(false);
    expect(linkSchema.safeParse("https://askone.org").success).toBe(true);
    expect(linkSchema.safeParse("").success).toBe(true);
  });

  it("accepts the limits: 50 components of 50 monitors, a 40-character logo", () => {
    const components = Array.from({ length: 50 }, (_, i) => ({ name: `C${i}`, inApp: false, monitorIds: Array.from({ length: 50 }, () => MON) }));
    expect(pageDraftErrors(draft({ components, logoText: "L".repeat(40) }))).toEqual({});
  });
});

describe("slug", () => {
  it.each(["-abc", "abc-", "a_b", "a.b", "a b", "ąbc", "a".repeat(41), "", "   "])("refuses %j", (slug) => {
    expect(fields(draft({ slug }))).toEqual(["slug"]);
  });

  it.each(RESERVED_SLUGS)("refuses the reserved slug %s, with its own reason", (slug) => {
    const e = pageDraftErrors(draft({ slug }));
    expect(Object.keys(e)).toEqual(["slug"]);
    expect(e.slug).not.toBe(SHAPE);
  });

  it("refuses a reserved slug however it is typed", () => {
    expect(fields(draft({ slug: " WWW " }))).toEqual(["slug"]);
    expect(fields(draft({ slug: "Status" }))).toEqual(["slug"]);
  });

  it("refuses the same reserved list and shape the table does (status_pages_slug_check)", () => {
    const check = MIGRATIONS.match(/slug\s+text not null unique check \(\s*slug ~ '([^']+)'\s*and slug not in \(([^)]*)\)/);
    expect(check, "the slug check in supabase/migrations/").not.toBeNull();
    const [, pattern, list] = check!;
    const extra = MIGRATIONS.match(/status_pages_edge_slug_check check\s*\(slug not in \(([^)]*)\)/)?.[1];
    expect(extra).toBeDefined();
    expect([list, extra!].flatMap(part => part.split(",").map(s => s.trim().replace(/^'|'$/g, "")))
      .filter(s => s !== "_edge")).toEqual(RESERVED_SLUGS);
    const tableShape = new RegExp(pattern);
    for (const slug of ["a", "my-app", "0day", "a".repeat(40), "-abc", "abc-", "a".repeat(41), "a_b", "a.b"]) {
      expect(tableShape.test(slug), slug).toBe(pageDraftSchema.shape.slug.safeParse(slug).success);
    }
  });
});

describe("homepage, against the table", () => {
  // `status_pages.homepage`'s check, read from the migration rather than copied.
  const check = MIGRATIONS.match(/homepage\s+text check \(homepage is null or \(homepage ~ '([^']+)' and char_length\(homepage\) <= (\d+)\)\)/);

  it("is found in supabase/migrations/", () => {
    expect(check).not.toBeNull();
  });

  // The editor and the table agree both ways: what one accepts the other accepts, so a save
  // never passes validation and then fails on status_pages_homepage_check.
  it.each(["https://askone.org", "http://askone.org/status", "HTTPS://askone.org", "Https://askone.org", "ftp://askone.org"])("the editor and the table agree on %s", (homepage) => {
    const [, pattern, max] = check!;
    const editor = !("homepage" in pageDraftErrors(draft({ homepage })));
    const table = new RegExp(pattern).test(homepage) && homepage.length <= Number(max);
    expect(editor).toBe(table);
  });

  it("accepts an ordinary address in both", () => {
    expect(pageDraftErrors(draft({ homepage: "https://askone.org" }))).toEqual({});
  });
});

describe("the other fields", () => {
  it.each([
    [{ name: "" }, "name"],
    [{ name: "   " }, "name"],
    [{ name: "n".repeat(81) }, "name"],
    [{ logoText: "L".repeat(41) }, "logoText"],
    [{ homepage: "askone.org" }, "homepage"],
    [{ homepage: "ftp://askone.org" }, "homepage"],
    [{ homepage: "javascript:alert(1)" }, "homepage"],
    [{ homepage: "https://askone.org/a b" }, "homepage"],
    [{ homepage: `https://askone.org/${"a".repeat(2048)}` }, "homepage"],
    [{ accent: "1F2DE6" }, "accent"],
    [{ accent: "#1F2DE" }, "accent"],
    [{ accent: "#1F2DE6FF" }, "accent"],
    [{ accent: "red" }, "accent"],
    [{ accent: "rgb(0,0,0)" }, "accent"],
    [{ theme: "sepia" as never }, "theme"],
    [{ historyDays: 60 as never }, "historyDays"],
    [{ poweredBy: "yes" as never }, "poweredBy"],
    [{ noindex: 1 as never }, "noindex"],
  ] as [Partial<PageDraft>, string][])("refuses %j on the %s field", (over, field) => {
    expect(fields(draft(over))).toEqual([field]);
  });

  it.each([
    [[{ name: "", inApp: false, monitorIds: [] }]],
    [[{ name: "n".repeat(81), inApp: false, monitorIds: [] }]],
    [[{ name: "API", inApp: false, monitorIds: ["mon_123"] }]],
    [[{ name: "API", inApp: false, monitorIds: Array.from({ length: 51 }, () => MON) }]],
    [Array.from({ length: 51 }, (_, i) => ({ name: `C${i}`, inApp: false, monitorIds: [] }))],
  ])("refuses the components %j on the components field", (components) => {
    expect(fields(draft({ components }))).toEqual(["components"]);
  });

  it("keeps the first problem per field and names every field at once", () => {
    const e = pageDraftErrors(draft({ slug: "", name: "", accent: "x" }));
    expect(Object.keys(e).sort()).toEqual(["accent", "name", "slug"]);
    for (const message of Object.values(e)) expect(message.length).toBeGreaterThan(0);
  });

  it("answers something that is not a draft with a form-level error", () => {
    expect(fields(null)).toEqual(["form"]);
    expect(fields("askone")).toEqual(["form"]);
  });
});

describe("NOTE_STATES", () => {
  it("are the incident note states of spec.md § 2, in order", () => {
    expect([...NOTE_STATES]).toEqual(["investigating", "identified", "monitoring", "resolved"]);
  });
});
