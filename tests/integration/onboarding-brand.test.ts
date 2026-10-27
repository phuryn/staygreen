import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/* Migration 021 against a real Postgres with every migration applied (`probe/README.md` § A local
   Postgres): an app's brand colour (`apps.accent`) and its logo's favicon copy
   (`app_logos.favicon_mime`, `favicon_content`), each refused by the table on its own when it is
   anything the actions wouldn't write. `PROBE_DATABASE_URL` names the local database; missing,
   the file skips and says so. The same columns through the actions, on the development database,
   are `app-logos.test.ts`. */

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
const local = /^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
if (url && !local) throw new Error("PROBE_DATABASE_URL must name a Postgres on this machine (127.0.0.1 or localhost)");

const suite = url ? describe : describe.skip;
if (!url) console.warn('[integration] SKIPPED "onboarding brand columns": PROBE_DATABASE_URL is not set. Nothing in this file reached a database.');

const hex = (n: number) => randomBytes(n).toString("hex");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000300000003008060000005702f987", "hex");

suite("onboarding brand columns", () => {
  let db: pg.Pool;
  let ws = "";
  let app = "";

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url, max: 2 });
    ws = (await db.query("insert into public.workspaces (clerk_org_id) values ($1) returning id", [`org_brandtest${hex(6)}`])).rows[0].id;
    app = (await db.query("insert into public.apps (workspace_id, name) values ($1, 'brand test') returning id", [ws])).rows[0].id;
  });

  afterAll(async () => {
    try {
      if (ws) await db.query("delete from public.workspaces where id = $1", [ws]);
    } finally {
      await db?.end();
    }
  });

  /** The SQLSTATE a statement fails with, or null when it succeeds. */
  const code = async (sql: string, params: unknown[]) => {
    try {
      await db.query(sql, params);
      return null;
    } catch (e) {
      return (e as { code?: string }).code ?? "unknown";
    }
  };

  it("starts every app with no colour, and takes six lowercase hex digits", async () => {
    expect((await db.query("select accent from public.apps where id = $1", [app])).rows[0].accent).toBeNull();
    expect(await code("update public.apps set accent = $2 where id = $1", [app, "#635bff"])).toBeNull();
    expect(await code("update public.apps set accent = null where id = $1", [app])).toBeNull();
  });

  it.each(["#635BFF", "#63f", "635bff", "red", "#635bff ", "#635bffff", ""])("refuses %j as an app's colour", async (accent) => {
    expect(await code("update public.apps set accent = $2 where id = $1", [app, accent])).toBe("23514");
  });

  const logo = (over: Record<string, unknown> = {}) => {
    const row = { id: `asset_${hex(16)}`, workspace_id: ws, app_id: app, mime: "image/png", content: PNG, favicon_mime: null, favicon_content: null, ...over };
    return code(
      `insert into public.app_logos (id, workspace_id, app_id, mime, content, favicon_mime, favicon_content) values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (app_id) do update set id = excluded.id, mime = excluded.mime, content = excluded.content, favicon_mime = excluded.favicon_mime, favicon_content = excluded.favicon_content`,
      [row.id, row.workspace_id, row.app_id, row.mime, row.content, row.favicon_mime, row.favicon_content],
    );
  };

  it("keeps a logo with no favicon copy, and one with a PNG copy", async () => {
    expect(await logo()).toBeNull();
    expect(await logo({ favicon_mime: "image/png", favicon_content: PNG })).toBeNull();
    const row = (await db.query("select favicon_mime, favicon_content from public.app_logos where app_id = $1", [app])).rows[0];
    expect(row.favicon_mime).toBe("image/png");
    expect(Buffer.from(row.favicon_content)).toEqual(PNG);
  });

  it("refuses a favicon copy without its type, a type without its copy, a copy that isn't a PNG, and one too large or empty", async () => {
    expect(await logo({ favicon_mime: "image/png" })).toBe("23514");
    expect(await logo({ favicon_content: PNG })).toBe("23514");
    expect(await logo({ favicon_mime: "image/webp", favicon_content: PNG })).toBe("23514");
    expect(await logo({ favicon_mime: "image/x-icon", favicon_content: PNG })).toBe("23514");
    expect(await logo({ favicon_mime: "image/png", favicon_content: Buffer.alloc(512 * 1024 + 1) })).toBe("23514");
    expect(await logo({ favicon_mime: "image/png", favicon_content: Buffer.alloc(0) })).toBe("23514");
  });

  it("reaches neither column from the roles the public and the probes use", async () => {
    // Table grants are the table's: anon and authenticated have none on these tables (`deny-all.test.ts`),
    // and the probe and ingest roles reach the database only through their definer functions.
    for (const role of ["anon", "authenticated", "probe", "ingest"]) {
      const r = await db.query("select has_column_privilege($1, 'public.apps', 'accent', 'select') as a, has_column_privilege($1, 'public.app_logos', 'favicon_content', 'select') as f", [role]);
      expect(r.rows[0], role).toEqual({ a: false, f: false });
    }
  });
});
