import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadPublicIncident, loadPublicView } from "@/lib/public-data";

/* The two reads behind `/s/<slug>` and `/i/<id>` (`src/lib/public-data.ts`).
   The database is the unit harness's fake side (`docs/TESTS.md`), so the one
   database module is replaced at its own seam, `db()`, by a stand-in whose
   `rpc` answers what the test hands it. What is real: the id and slug guards,
   the DTO parse, and the mapping to the view. */

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => ({ rpc }) }));

/** The id shape `public.new_id` produces, read from the migrations rather than copied:
 *  the prefix, an underscore, then every `substr(…, 1, N)` it concatenates. */
function newIdHexLength(): number {
  const dir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
  const bodies = [...sql.matchAll(/create or replace function public\.new_id\(p_prefix text\)[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/g)];
  const body = bodies.at(-1)?.[1] ?? "";
  return [...body.matchAll(/substr\(.*?,\s*1\s*,\s*(\d+)\)/g)].reduce((n, m) => n + Number(m[1]), 0);
}

const HEX = newIdHexLength();
const realId = (prefix: string) => `${prefix}_${"0123456789abcdef".repeat(4).slice(0, HEX)}`;

const snapshot = {
  page: { slug: "askone", name: "AskOne status", logoText: "AskOne", homepage: null, accent: "#1F2DE6", theme: "visitor", poweredBy: true, noindex: false, historyDays: 90 },
  components: [{ key: 0, name: "API", inApp: true, states: ["up"], daily: [] }],
  incidents: [],
};

beforeEach(() => {
  rpc.mockReset();
});

describe("the id shape", () => {
  it("is read from public.new_id", () => {
    expect(HEX).toBeGreaterThan(0);
  });
});

describe("loadPublicView", () => {
  it("reads the snapshot for a well-formed slug", async () => {
    rpc.mockResolvedValue({ data: snapshot, error: null });
    const v = await loadPublicView("askone");
    expect(rpc).toHaveBeenCalledWith("public_status_snapshot", { p_slug: "askone" });
    expect(v?.page.slug).toBe("askone");
    expect(v?.components.map((c) => c.state)).toEqual(["up"]);
  });

  it.each(["AskOne", "-x", "a_b", "a".repeat(41), "../etc", ""])("answers the malformed slug %j as missing without a query", async (slug) => {
    expect(await loadPublicView(slug)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("answers a slug no page has as missing", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await loadPublicView("askone")).toBeNull();
  });

  it("refuses to show a snapshot that does not parse", async () => {
    rpc.mockResolvedValue({ data: { ...snapshot, page: { ...snapshot.page, accent: "red" } }, error: null });
    await expect(loadPublicView("askone")).rejects.toThrow();
  });

  it("names the failing function and the code, never the database's message", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied for table monitor_secrets" } });
    const failure = loadPublicView("askone");
    await expect(failure).rejects.toThrow(/public_status_snapshot.*42501/);
    await expect(failure).rejects.not.toThrow(/monitor_secrets/);
  });
});

describe("loadPublicIncident", () => {
  // The id guard and `public.new_id` must agree on the length, read from the migration, or
  // every short link alerts carry (`/i/<id>`) is a 404 before the query (it was 12 against 24).
  it("reads the incident for an id shaped the way public.new_id makes it", async () => {
    const id = realId("inc");
    rpc.mockResolvedValue({ data: { ...snapshot, incidentId: id }, error: null });
    const found = await loadPublicIncident(id);
    expect(rpc).toHaveBeenCalledWith("public_incident", { p_incident_id: id });
    expect(found?.incidentId).toBe(id);
  });

  it.each(["inc_XYZ", "inc_0123456789ab", "mon_0123456789abcdef01234567", "inc_0123456789abcdef01234567x", "", "inc_'; drop table incidents; --"])("answers the malformed id %j as missing without a query", async (id) => {
    expect(await loadPublicIncident(id)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
