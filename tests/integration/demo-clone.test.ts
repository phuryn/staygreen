import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Real SQL/transactions/privileges. Local fixtures only; no provider or hosted database.
const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
if (url && !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error("PROBE_DATABASE_URL must be local");
if (!url) console.warn('[integration] SKIPPED "demo clone": PROBE_DATABASE_URL is not set. No database was reached.');
const hex = () => randomBytes(6).toString("hex");
const suite = url ? describe : describe.skip;

suite("demo clone", () => {
  let db: pg.Pool;
  let source: string, dest: string, app: string, page: string, slug: string;
  const workspaces: string[] = [];
  beforeAll(() => { db = new pg.Pool({ connectionString: url, max: 4 }); });
  beforeEach(async () => {
    const workspace = async () => {
      const id = (await db.query("insert into workspaces(clerk_org_id) values($1) returning id", [`org_demotest${hex()}`])).rows[0].id;
      workspaces.push(id); return id;
    };
    source = await workspace(); dest = await workspace(); slug = `demo-${hex()}`;
    app = (await db.query("insert into apps(workspace_id,name,url,accent) values($1,'Poteto','https://poteto.example','#123456') returning id", [source])).rows[0].id;
    page = (await db.query("insert into status_pages(workspace_id,app_id,slug,name,logo_text,homepage,theme,accent,demo) values($1,$2,$3,'Poteto status','Poteto','https://poteto.example','dark','#123456',true) returning id", [source, app, slug])).rows[0].id;
  });
  afterAll(async () => {
    try { await db.query("delete from workspaces where id = any($1)", [workspaces]); }
    finally { await db.end(); }
  });

  const monitor = async (type: string, name: string, position: number, options: { secret?: boolean; config?: object; host?: string } = {}) => {
    const host = options.host ?? "poteto.example";
    const target = type === "http" ? `https://${host}/${position}` : type === "tcp" ? `${host}:443` : type === "dns" ? `A ${host}` : host;
    const id = (await db.query(`insert into monitors(workspace_id,app_id,type,name,target,target_host,interval_sec,config,heartbeat_token_hash,heartbeat_token_sealed)
      values($1,$2,$3,$4,$5,$6,60,$7,$8,$9) returning id`,
    [source, app, type, name, target, host, options.config ?? {}, type === "heartbeat" ? randomBytes(32).toString("hex") : null,
      type === "heartbeat" ? "v1.HEARTBEAT.SEALED" : null])).rows[0].id;
    if (options.secret) await db.query("insert into monitor_secrets(monitor_id,workspace_id,name,sealed) values($1,$2,'Authorization','v1.NEVER.READ')", [id, source]);
    const c = (await db.query("insert into page_components(workspace_id,page_id,name,position,in_app) values($1,$2,$3,$4,true) returning id", [source, page, name, position])).rows[0].id;
    await db.query("insert into component_monitors(workspace_id,component_id,monitor_id) values($1,$2,$3)", [source, c, id]);
    return id;
  };
  const copy = async (limits: { apps?: number; pages?: number; monitors?: number; assertions?: number; host?: number; interval?: number; white?: boolean } = {}) =>
    (await db.query("select clone_demo_page($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result",
      [dest, slug, `copy-${hex()}`, limits.apps ?? 1, limits.pages ?? 1, limits.monitors ?? 50, limits.assertions ?? 3, limits.host ?? 5, limits.interval ?? 180, limits.white ?? false])).rows[0].result;
  const count = async (table: string) => Number((await db.query(`select count(*) from ${table} where workspace_id=$1`, [dest])).rows[0].count);

  it("lets the clone action spend its own budget, through the real function", async () => {
    const spend = async () => (await db.query("select spend_budget(p_workspace_id => $1, p_user_id => $2, p_action => 'demo_clone', p_member_limit => 1, p_member_window_sec => 60, p_workspace_limit => 20, p_workspace_window_sec => 60) as v", [dest, "user_demobudget"])).rows[0].v;
    expect(await spend()).toEqual({ ok: true });
    expect(await spend()).toMatchObject({ ok: false });
  });

  it("migration is repeatable, defaults false, and refuses demo plus members-only", async () => {
    for (const file of ["20261028090000_demo_clone.sql", "20261028220000_demo_clone_branding.sql"])
      await db.query(readFileSync(`supabase/migrations/${file}`, "utf8"));
    await expect(db.query("update status_pages set members_only=true where id=$1", [page])).rejects.toMatchObject({ code: "23514", constraint: "status_pages_demo_public" });
    expect((await db.query("select public_status_snapshot($1) as v", [slug])).rows[0].v.page.demo).toBe(true);
    const result = await copy();
    expect((await db.query("select demo,members_only from status_pages where id=$1", [result.pageId])).rows[0]).toEqual({ demo: false, members_only: true });
  });

  it.each(["image/png", "image/webp", "image/jpeg", null])("uses the page's brand when the app has no logo/accent (%s)", async mime => {
    await db.query("update apps set accent=null where id=$1", [app]);
    const imageId = `asset_${randomBytes(16).toString("hex")}`;
    const pixels = Buffer.from("page image pixels");
    if (mime) await db.query("insert into page_assets(id,workspace_id,page_id,kind,mime,content) values($1,$2,$3,'logo',$4,$5)", [imageId, source, page, mime, pixels]);
    const preview = (await db.query("select demo_clone_source($1) as v", [slug])).rows[0].v;
    expect(preview.app).toMatchObject({ accent: "#123456", logoUrl: mime ? `/page-assets/${imageId}` : null });
    const r = await copy();
    expect((await db.query("select accent from apps where id=$1", [r.appId])).rows[0].accent).toBe("#123456");
    const logos = (await db.query("select id,mime,content from app_logos where app_id=$1", [r.appId])).rows;
    if (mime) {
      expect(logos).toEqual([{ id: expect.any(String), mime, content: pixels }]);
      expect(logos[0].id).not.toBe(imageId);
      // uploadAppLogo({ keep: true }) uses this app_id conflict with DO NOTHING.
      // Even a new scan's different image cannot replace the independently copied logo.
      const imported = await db.query("insert into app_logos(id,workspace_id,app_id,mime,content) values($1,$2,$3,'image/png',$4) on conflict(app_id) do nothing returning id",
        [`asset_${randomBytes(16).toString("hex")}`, dest, r.appId, Buffer.from("scan pixels")]);
      expect(imported.rows).toEqual([]);
      // Removing the source cannot remove or change the copied app artwork.
      await db.query("delete from page_assets where page_id=$1", [page]);
      expect((await db.query("select content from app_logos where app_id=$1", [r.appId])).rows[0].content).toEqual(pixels);
    } else expect(logos).toEqual([]);
  });

  it("accepts the page's uppercase default accent while keeping the app's lowercase storage contract", async () => {
    await db.query("update apps set accent=null where id=$1", [app]);
    await db.query("update status_pages set accent='#1F2DE6' where id=$1", [page]);
    const preview = (await db.query("select demo_clone_source($1) as v", [slug])).rows[0].v;
    expect(preview.app.accent).toBe("#1f2de6");
    const r = await copy();
    expect((await db.query("select accent from apps where id=$1", [r.appId])).rows[0].accent).toBe("#1f2de6");
    expect((await db.query("select accent from status_pages where id=$1", [r.pageId])).rows[0].accent).toBe("#1F2DE6");
  });

  it("prefers app artwork and independently falls back only for its missing accent", async () => {
    const appImage = `asset_${randomBytes(16).toString("hex")}`;
    await db.query("insert into app_logos(id,workspace_id,app_id,mime,content) values($1,$2,$3,'image/png',$4)", [appImage, source, app, Buffer.from("app pixels")]);
    await db.query("insert into page_assets(id,workspace_id,page_id,kind,mime,content) values($1,$2,$3,'logo','image/png',$4)", [`asset_${randomBytes(16).toString("hex")}`, source, page, Buffer.from("page pixels")]);
    await db.query("update status_pages set accent='#abcdef' where id=$1", [page]);
    for (const accent of ["#123456", null]) {
      await db.query("update apps set accent=$2 where id=$1", [app, accent]);
      const preview = (await db.query("select demo_clone_source($1) as v", [slug])).rows[0].v;
      expect(preview.app).toMatchObject({ accent: accent ?? "#abcdef", logoUrl: `/page-assets/${appImage}` });
    }
    const r = await copy();
    expect((await db.query("select accent from apps where id=$1", [r.appId])).rows[0].accent).toBe("#abcdef");
    expect((await db.query("select content from app_logos where app_id=$1", [r.appId])).rows[0].content).toEqual(Buffer.from("app pixels"));
  });

  it("copies allowlisted checks/branding/order, with new assets, no state, history, pauses or secrets", async () => {
    const config = { method: "POST", expect: "202", keyword: "ok", slowMs: 2400, timeoutSec: 12, assertions: [{ path: "ok", op: "==", value: "true" }] };
    const http = await monitor("http", "Website", 0, { config });
    await monitor("ssl", "Certificate", 1, { config: { host: "poteto.example" } });
    await monitor("dns", "DNS", 2, { config: { record: "A", name: "poteto.example", expected: "192.0.2.10" } });
    await monitor("tcp", "Port", 3, { config: { host: "poteto.example", port: 443, tls: true, slowMs: 1000 } });
    for (const [i, type] of ["heartbeat", "supabase", "stripe", "mcp"].entries()) await monitor(type, type, i + 4, { secret: type !== "heartbeat", config: { excluded: "NEVER COPY THIS" } });
    await monitor("http", "Private headers", 8, { secret: true, config: { excluded: "NEVER COPY THIS" } });
    await db.query("update monitors set state='down',state_since=now(),paused_at=now(),pause_reason='source only' where id=$1", [http]);
    const pixels = Buffer.from("89504e470d0a1a0a0000000d49484452000000300000003008060000005702f987", "hex");
    const asset = `asset_${randomBytes(16).toString("hex")}`;
    await db.query("insert into app_logos(id,workspace_id,app_id,mime,content,favicon_mime,favicon_content) values($1,$2,$3,'image/png',$4,'image/png',$4)", [asset, source, app, pixels]);
    await db.query("insert into page_assets(id,workspace_id,page_id,kind,mime,content) values($1,$2,$3,'logo','image/png',$4)", [`asset_${randomBytes(16).toString("hex")}`, source, page, pixels]);
    const result = await copy();
    expect(result.copied).toEqual(["Website", "Certificate", "DNS", "Port"]);
    // The page's own certificate check took over the automatic one, so the copy added nothing by itself.
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual(["heartbeat", "supabase", "stripe", "mcp", "Private headers"].map(name => ({ name, reason: "needs_key" })));
    const rows = (await db.query("select type,name,config,interval_sec,state,paused_at,heartbeat_token_sealed from monitors where app_id=$1 order by name", [result.appId])).rows;
    expect(rows).toHaveLength(4);
    expect(rows.find(m => m.type === "http")).toMatchObject({ config, interval_sec: 180 });
    expect(rows.find(m => m.type === "tcp")?.interval_sec).toBe(180);
    expect(rows.find(m => m.type === "dns")?.interval_sec).toBe(600);
    expect(rows.find(m => m.type === "ssl")?.interval_sec).toBe(21600);
    for (const row of rows) expect(row).toMatchObject({ state: null, paused_at: null, heartbeat_token_sealed: null });
    expect(await count("monitor_secrets")).toBe(0); expect(await count("incidents")).toBe(0); expect(await count("page_domains")).toBe(0);
    const p = (await db.query("select name,logo_text,accent,theme,homepage,history_days,powered_by,members_only,demo from status_pages where id=$1", [result.pageId])).rows[0];
    expect(p).toMatchObject({ name: "Poteto status", logo_text: "Poteto", accent: "#123456", theme: "dark", homepage: "https://poteto.example", history_days: 90, powered_by: true, members_only: true, demo: false });
    expect((await db.query("select name,in_app from page_components where page_id=$1 order by position", [result.pageId])).rows).toEqual(result.copied.map((name: string) => ({ name, in_app: true })));
    const logo = (await db.query("select * from app_logos where app_id=$1", [result.appId])).rows[0];
    expect(logo.id).not.toBe(asset); expect(logo.content).toEqual(pixels); expect(logo.favicon_content).toEqual(pixels);
    expect(await count("page_assets")).toBe(1);
    expect((await db.query("select public_status_snapshot(slug) as v from status_pages where id=$1", [result.pageId])).rows[0].v).toBeNull();
  });

  it("the source read succeeds with no SELECT privilege on either sealed column", async () => {
    await monitor("http", "Public", 0);
    await monitor("http", "Secret", 1, { secret: true, config: { excluded: "HIDDEN CONFIG" } });
    await monitor("heartbeat", "Job", 2, { config: { excluded: "HIDDEN CONFIG" } });
    const role = `demo_reader_${hex()}`;
    const c = await db.connect();
    try {
      await c.query("begin");
      await c.query(`create role ${role} nologin bypassrls`);
      await c.query(`grant usage on schema public to ${role}`);
      await c.query(`grant select on apps,status_pages,page_components,component_monitors to ${role}`);
      await c.query(`grant select(id,app_id) on app_logos to ${role}`);
      await c.query(`grant select(id,page_id,kind) on page_assets to ${role}`);
      await c.query(`grant select(id,workspace_id,type,name,target,target_host,config) on monitors to ${role}`);
      await c.query(`grant select(monitor_id) on monitor_secrets to ${role}`);
      await c.query(`grant execute on function demo_clone_source(text) to ${role}`);
      await c.query(`set local role ${role}`);
      const data = (await c.query("select demo_clone_source($1) as v", [slug])).rows[0].v;
      expect(data.monitors[1]).toEqual({ id: expect.any(String), name: "Secret", type: "http", copyable: false });
      expect(data.monitors[2]).toEqual({ id: expect.any(String), name: "Job", type: "heartbeat", copyable: false });
      expect(JSON.stringify(data)).not.toMatch(/NEVER|SEALED|HIDDEN CONFIG/);
      expect((await c.query("select has_column_privilege(current_user,'monitor_secrets','sealed','select') as secret, has_column_privilege(current_user,'monitors','heartbeat_token_sealed','select') as heartbeat")).rows[0]).toEqual({ secret: false, heartbeat: false });
    } finally { await c.query("rollback"); c.release(); }
  });

  it("rolls back the app, its automatic SSL, copied monitors and logo when page creation fails", async () => {
    await monitor("http", "Website", 0);
    await expect(copy({ pages: 0 })).rejects.toMatchObject({ message: "page_limit" });
    for (const table of ["apps", "monitors", "status_pages", "app_logos", "page_assets", "page_components"]) expect(await count(table)).toBe(0);
  });

  it("preserves the demo flag without entitlement and keeps a Free clone editable and publishable", async () => {
    const save = (workspace: string, pageId: string, pageSlug: string, demo: boolean | null, members: boolean) => db.query(
      "select save_demo_page($1,$2,$3,'Edited','Logo',null,'#123456','visitor',true,false,30,'[]',false,false,$4,null,$5)",
      [workspace, pageId, pageSlug, members, demo]);
    await save(source, page, slug, null, false);
    expect((await db.query("select demo from status_pages where id=$1", [page])).rows[0].demo).toBe(true);
    await save(source, page, slug, false, false);
    expect((await db.query("select demo from status_pages where id=$1", [page])).rows[0].demo).toBe(false);
    await save(source, page, slug, true, false);
    const r = await copy();
    const copiedSlug = (await db.query("select slug from status_pages where id=$1", [r.pageId])).rows[0].slug;
    await save(dest, r.pageId, copiedSlug, null, true);
    await save(dest, r.pageId, copiedSlug, null, false);
    expect((await db.query("select members_only,demo from status_pages where id=$1", [r.pageId])).rows[0]).toEqual({ members_only: false, demo: false });
  });

  it("refuses Free's full app allowance before any copy writes", async () => {
    await db.query("insert into apps(workspace_id,name) values($1,'Existing')", [dest]);
    await monitor("http", "Website", 0);
    await expect(copy()).rejects.toMatchObject({ message: "app_limit" });
    expect(await count("apps")).toBe(1); expect(await count("monitors")).toBe(0); expect(await count("status_pages")).toBe(0);
  });

  it("skips only quota refusals in component order, leaves off empty components, and keeps independent checks", async () => {
    await monitor("http", "First", 0);
    await monitor("http", "Host full", 1);
    await monitor("http", "Too many assertions", 2, { host: "assert.example", config: { assertions: [{}, {}, {}, {}] } });
    await monitor("tcp", "Other host", 3, { host: "other.example" });
    await monitor("http", "Monitor full", 4, { host: "last.example" });
    const r = await copy({ monitors: 2, host: 1 });
    expect(r.copied).toEqual(["First", "Other host"]);
    // The HTTPS check brought its host's free certificate check, which the receipt names too.
    expect(r.added).toEqual(["poteto.example"]);
    expect(r.skipped).toEqual([{ name: "Host full", reason: "host_limit" }, { name: "Too many assertions", reason: "assertion_limit" }, { name: "Monitor full", reason: "monitor_limit" }]);
    expect(Number((await db.query("select count(*) from monitors where workspace_id=$1 and not auto", [dest])).rows[0].count)).toBe(2);
    expect((await db.query("select name from page_components where page_id=$1 order by position", [r.pageId])).rows.map(r => r.name)).toEqual(["First", "Other host"]);
  });

  it("serializes concurrent retries, returning the existing app before a now-full quota", async () => {
    const results = await Promise.all([copy(), copy()]);
    const made = results.find(r => r.appId); const duplicate = results.find(r => r.duplicateAppId);
    expect(duplicate).toEqual({ duplicateAppId: made.appId });
    expect(await count("apps")).toBe(1); expect(await count("status_pages")).toBe(1);
  });

  it("holds the source public until the copy commits, so a later private image cannot enter it", async () => {
    const copying = await db.connect(); const editing = await db.connect();
    try {
      await copying.query("begin");
      await copying.query("select clone_demo_page($1,$2,$3,1,1,50,3,5,180,false)", [dest, slug, `copy-${hex()}`]);
      await editing.query("begin; set local lock_timeout = '100ms'");
      await expect(editing.query("update status_pages set demo=false,members_only=true where id=$1", [page])).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await copying.query("rollback"); await editing.query("rollback"); copying.release(); editing.release();
    }
  });

  it.each(["not-demo", "private", "withdrawn", "missing"])("refuses %s like missing and writes nothing", async kind => {
    if (kind === "not-demo") await db.query("update status_pages set demo=false where id=$1", [page]);
    if (kind === "private") await db.query("update status_pages set demo=false,members_only=true where id=$1", [page]);
    if (kind === "withdrawn") await db.query("update status_pages set edge_withdrawn=true where id=$1", [page]);
    if (kind === "missing") slug = `absent-${hex()}`;
    expect((await db.query("select demo_clone_source($1) as v", [slug])).rows[0].v).toBeNull();
    await expect(copy()).rejects.toMatchObject({ code: "PT404", message: "not_found" });
    expect(await count("apps")).toBe(0);
  });
});
