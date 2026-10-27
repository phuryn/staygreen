import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeDatabase, servicePool } from "../support/probe-database";

const url = process.env.PROBE_DATABASE_URL?.trim() ?? "";
if (url && !/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw Error("Local Postgres only");
if (!url) console.warn('[integration] SKIPPED "status edge": PROBE_DATABASE_URL is absent; no database was reached.');
const suite = url ? describe : describe.skip;

suite("029 status edge, real roles and publication boundaries", () => {
  let runtime: Awaited<ReturnType<typeof probeDatabase>>;
  let server: Awaited<ReturnType<typeof probeDatabase>>;
  let edge: Pool, sql: Pool;
  const workspaces: string[] = [];
  let ws: string, foreign: string, page: any, incident: string;
  const tag = randomBytes(6).toString("hex");
  beforeAll(async () => {
    runtime = await probeDatabase(url, "edge"); server = await probeDatabase(url, "service_role");
    edge = new Pool({ connectionString: runtime.probeUrl }); sql = servicePool(server.probeUrl);
    for (let n = 0; n < 2; n++) workspaces.push((await runtime.admin.query("insert into public.workspaces(clerk_org_id) values($1) returning id", [`org_edge${tag}${n}`])).rows[0].id);
    [ws, foreign] = workspaces;
    page = await newPage(ws, "public");
    const monitor = (await runtime.admin.query("insert into public.monitors(workspace_id,app_id,type,name,target,interval_sec) values($1,$2,'http','SECRET MONITOR','https://example.com',180) returning id", [ws, page.app_id])).rows[0].id;
    const hidden = (await runtime.admin.query("insert into public.monitors(workspace_id,app_id,type,name,target,interval_sec) values($1,$2,'http','HIDDEN MONITOR','https://private.example.com',180) returning id", [ws, page.app_id])).rows[0].id;
    const component = (await runtime.admin.query("insert into public.page_components(workspace_id,page_id,name,position,in_app) values($1,$2,'Public API',0,true) returning id", [ws, page.id])).rows[0].id;
    await runtime.admin.query("insert into public.component_monitors(workspace_id,component_id,monitor_id) values($1,$2,$3)", [ws, component, monitor]);
    for (const [mon, title] of [[monitor, "INTERNAL INCIDENT TITLE"], [hidden, "HIDDEN INCIDENT"]]) {
      const id = (await runtime.admin.query("insert into public.incidents(workspace_id,monitor_id,title,severity) values($1,$2,$3,'down') returning id", [ws, mon, title])).rows[0].id;
      if (mon === monitor) incident = id;
      await runtime.admin.query("insert into public.incident_notes(workspace_id,incident_id,state,body,status,published_at,author_user_id) values($1,$2,'identified',$3,'published',now(),'user_edgetest'),($1,$2,'investigating','DRAFT SECRET','draft',null,'user_edgetest')", [ws, id, mon === monitor ? "Published note" : "HIDDEN NOTE"]);
    }
    const privatePage = await newPage(foreign, "private");
    await runtime.admin.query("update public.status_pages set members_only=true,name='PRIVATE PAGE' where id=$1", [privatePage.id]);
  });
  afterAll(async () => {
    if (runtime) await runtime.admin.query("delete from public.workspaces where id=any($1)", [workspaces]);
    await edge?.end(); await sql?.end(); await server?.close(); await runtime?.close();
  });
  async function newPage(workspace: string, suffix: string) {
    const app = (await runtime.admin.query("insert into public.apps(workspace_id,name) values($1,$2) returning id", [workspace, `Edge test ${suffix}`])).rows[0].id;
    return (await runtime.admin.query("insert into public.status_pages(workspace_id,app_id,slug,name) values($1,$2,$3,'Page') returning *", [workspace, app, `e-${tag}-${suffix}`])).rows[0];
  }
  const feed = async () => (await edge.query("select status_edge.pages('',100) as value")).rows.map(r => r.value);
  const save = (members: boolean, version: number | null) => sql.query("select public.save_status_page_access($1,$2,$3,'Page','',null,'#1F2DE6','visitor',true,false,90,'[]',true,true,$4,$5)", [ws, page.id, page.slug, members, version]);
  it("the bare edge login has one read function, no tables, private snapshots, writes or role escalation", async () => {
    const entries = await feed(); const text = JSON.stringify(entries);
    expect(entries.find(e => e.snapshot.page.slug === page.slug)).toMatchObject({ pageId: page.id, version: 0 });
    expect(text).toContain("Public API"); expect(text).toContain("Published note");
    for (const secret of ["SECRET MONITOR", "HIDDEN MONITOR", "INTERNAL INCIDENT TITLE", "HIDDEN INCIDENT", "HIDDEN NOTE", "DRAFT SECRET", "PRIVATE PAGE", foreign]) expect(text).not.toContain(secret);
    for (const command of ["select * from public.status_pages", "select * from public.monitor_secrets", "select public.status_page_snapshot('x','y')", "select public.reserve_page_domain('x','y','status.example.com')", "set role service_role", "set role postgres", "create table public.edge_escalation(x int)"]) {
      await expect(edge.query(command)).rejects.toMatchObject({ code: "42501" });
    }
    const grants = await runtime.admin.query("select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','status_edge','alert_sender') and has_function_privilege($1,p.oid,'EXECUTE') order by 1", [runtime.role]);
    expect(grants.rows.map(r => r.signature)).toEqual(["status_edge.pages(text,integer)"]);
    expect((await edge.query("select status_edge.pages('',10000) as value")).rowCount).toBeLessThanOrEqual(100);
  });
  it("refuses private save without a fenced withdrawal, excludes it immediately, and keeps old public RPCs safe", async () => {
    await expect(save(true, null)).rejects.toMatchObject({ message: "withdrawal_required" });
    const ticket = (await sql.query("select public.begin_private_page($1,$2,true) as value", [ws, page.id])).rows[0].value;
    expect(ticket).toEqual({ pageId: page.id, slug: page.slug, version: 1 });
    expect((await feed()).some(e => e.snapshot.page.slug === page.slug)).toBe(false);
    expect((await sql.query("select public.public_status_snapshot($1) as value", [page.slug])).rows[0].value).toBeNull();
    await expect(save(true, ticket.version - 1)).rejects.toMatchObject({ message: "withdrawal_required" });
    await save(true, ticket.version);
    expect((await sql.query("select public.public_incident($1) as value", [incident])).rows[0].value).toBeNull();
    expect((await sql.query("select public.status_page_snapshot($1,$2) as value", [page.slug, foreign])).rows[0].value).toBeNull();
    expect((await sql.query("select public.status_page_snapshot($1,$2) as value", [page.slug, ws])).rows[0].value.page.slug).toBe(page.slug);
    await save(false, null);
    expect((await feed()).find(e => e.snapshot.page.slug === page.slug)).toMatchObject({ pageId: page.id, version: 3 });
  });
  it("serializes pending quotas, keeps domains globally unique, and expires only unverified claims", async () => {
    const pages = await Promise.all([0, 1, 2, 3].map(i => newPage(ws, `domain${i}`)));
    const results = await Promise.allSettled(pages.map((p, i) => sql.query("select public.reserve_page_domain($1,$2,$3)", [ws, p.id, `s${i}-${tag}.example.com`])));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const first = (await sql.query("select * from public.page_domains where workspace_id=$1 order by host limit 1", [ws])).rows[0];
    const other = await newPage(foreign, "domain");
    await expect(sql.query("select public.reserve_page_domain($1,$2,$3)", [foreign, other.id, first.host])).rejects.toMatchObject({ code: "23505" });
    await expect(sql.query("select public.reserve_page_domain($1,$2,$3)", [foreign, page.id, "cross.example.com"])).rejects.toMatchObject({ code: "PT404" });
    expect((await sql.query("select public.edge_domain_allowed($1) as ok", [first.host])).rows[0].ok).toBe(false);
    await runtime.admin.query("update public.page_domains set created_at=now()-interval '8 days' where host=$1", [first.host]);
    expect((await sql.query("select public.verify_page_domain($1,$2,$3,$4,$5,50,5) as ok", [ws, first.page_id, first.host, first.created_at, first.cname_target])).rows[0].ok).toBe(false);
    await sql.query("select public.reserve_page_domain($1,$2,$3)", [foreign, other.id, first.host]);
    // pg's Date decoder drops microseconds. Verify the exact reservation timestamp, as the
    // PostgREST action does, rather than accidentally testing a different claim generation.
    const fresh = (await sql.query("select *,created_at::text as created_at from public.page_domains where page_id=$1", [other.id])).rows[0];
    expect(fresh.cname_target).not.toBe(first.cname_target);
    await expect(sql.query("select public.verify_page_domain($1,$2,$3,$4,$5,null,5)", [foreign, other.id, fresh.host, fresh.created_at, fresh.cname_target])).rejects.toMatchObject({ code: "22004" });
    expect((await sql.query("select public.verify_page_domain($1,$2,$3,$4,$5,50,5) as ok", [foreign, other.id, fresh.host, fresh.created_at, fresh.cname_target])).rows[0].ok).toBe(true);
    expect((await sql.query("select public.edge_domain_allowed($1) as ok", [fresh.host])).rows[0].ok).toBe(true);
    const monitors = await sql.query("select * from public.monitors where workspace_id=$1 and type='dns'", [foreign]);
    expect(monitors.rows).toHaveLength(1); expect(monitors.rows[0].config.expected).toBe(fresh.cname_target);
    await sql.query("select public.verify_page_domain($1,$2,$3,$4,$5,50,5)", [foreign, other.id, fresh.host, fresh.created_at, fresh.cname_target]);
    expect((await sql.query("select count(*)::int as n from public.monitors where workspace_id=$1 and type='dns'", [foreign])).rows[0].n).toBe(1);
  });
  it.each(["domain", "page", "workspace"])("requires fresh DNS proof after deleting the old %s", async removal => {
    const owners: string[] = [];
    for (const actor of ["victim", "attacker"]) {
      const id = (await runtime.admin.query("insert into public.workspaces(clerk_org_id) values($1) returning id", [`org_edge${tag}${removal}${actor}`])).rows[0].id;
      owners.push(id); workspaces.push(id);
    }
    const victim = await newPage(owners[0], `v-${removal}`);
    const attacker = await newPage(owners[1], `a-${removal}`);
    const host = `${removal}-${tag}.example.com`;
    const reserve = async (owner: string, id: string) => (await sql.query(
      "select d.*,d.created_at::text as created_at from public.reserve_page_domain($1,$2,$3) d", [owner, id, host])).rows[0];
    // These are the ordinary Free quotas. SQL receives only the proof the trusted action read.
    const verify = async (owner: string, id: string, claim: { created_at: string }, observedTarget: string | null) =>
      (await sql.query("select public.verify_page_domain($1,$2,$3,$4,$5,50,5) as ok", [owner, id, host, claim.created_at, observedTarget])).rows[0].ok;
    const before = await reserve(owners[0], victim.id);
    expect(before.cname_target).toMatch(/^[a-f0-9]{32}\.domains\.staygreen\.io$/);
    expect((await reserve(owners[0], victim.id)).cname_target).toBe(before.cname_target);
    expect(await verify(owners[0], victim.id, before, before.cname_target)).toBe(true);
    expect((await sql.query("select public.edge_domain_allowed($1) as ok", [host])).rows[0].ok).toBe(true);
    if (removal === "domain") await sql.query("delete from public.page_domains where page_id=$1 and workspace_id=$2", [victim.id, owners[0]]);
    if (removal === "page") await sql.query("delete from public.status_pages where id=$1 and workspace_id=$2", [victim.id, owners[0]]);
    if (removal === "workspace") await sql.query("delete from public.workspaces where id=$1", [owners[0]]);

    const after = await reserve(owners[1], attacker.id);
    expect(after.cname_target).not.toBe(before.cname_target);
    // Even with the new timestamp, a leftover CNAME does not prove this new claim. Nor does
    // an old in-flight result, a missing proof, or the former shared parent target.
    for (const proof of [before.cname_target, "domains.staygreen.io", null]) {
      expect(await verify(owners[1], attacker.id, after, proof)).toBe(false);
    }
    expect(await verify(owners[1], attacker.id, before, before.cname_target)).toBe(false);
    expect((await sql.query("select verified_at from public.page_domains where host=$1", [host])).rows[0].verified_at).toBeNull();
    expect((await sql.query("select count(*)::int as n from public.monitors where workspace_id=$1", [owners[1]])).rows[0].n).toBe(0);
    expect((await sql.query("select public.edge_domain_allowed($1) as ok", [host])).rows[0].ok).toBe(false);
    expect((await feed()).some(entry => entry.domain === host)).toBe(false);

    // Updating the real DNS record to this claim's target is the only successful path.
    expect(await verify(owners[1], attacker.id, after, after.cname_target)).toBe(true);
    const monitor = (await sql.query("select config from public.monitors where workspace_id=$1 and type='dns'", [owners[1]])).rows[0];
    expect(monitor.config.expected).toBe(after.cname_target);
    expect((await sql.query("select public.edge_domain_allowed($1) as ok", [host])).rows[0].ok).toBe(true);
  });
  it("accepts a configured claim target, preserves existing claims and verifies the exact stored target", async () => {
    const owner = (await runtime.admin.query("insert into public.workspaces(clerk_org_id) values($1) returning id", [`org_edge${tag}hosts`])).rows[0].id;
    workspaces.push(owner);
    const legacyPage = await newPage(owner, "legacyhost");
    const devPage = await newPage(owner, "devhost");
    const reserve = async (p: { id: string }, target?: string) => (await sql.query(
      "select d.*,d.created_at::text as created_at from public.reserve_page_domain($1,$2,$3,$4) d",
      [owner, p.id, `${p.id}.example.com`.replaceAll("_", "-"), target ?? null])).rows[0];
    const old = await reserve(legacyPage);
    expect(old.cname_target).toMatch(/^[a-f0-9]{32}\.domains\.staygreen\.io$/);
    const target = `${randomBytes(16).toString("hex")}.domains-dev.example.com`;
    expect((await reserve(legacyPage, target)).cname_target).toBe(old.cname_target);
    await expect(reserve(devPage, "not-a-claim.example.com")).rejects.toMatchObject({ code: "23514" });
    const fresh = await reserve(devPage, target);
    expect(fresh.cname_target).toBe(target);
    const verify = (proof: string) => sql.query("select public.verify_page_domain($1,$2,$3,$4,$5,50,5) as ok",
      [owner, devPage.id, fresh.host, fresh.created_at, proof]);
    expect((await verify(old.cname_target)).rows[0].ok).toBe(false);
    expect((await verify(target)).rows[0].ok).toBe(true);
    expect((await sql.query("select config->>'expected' as target from public.monitors where workspace_id=$1", [owner])).rows).toEqual([{ target }]);
    await expect(sql.query("select public.reserve_page_domain($1,$2,$3,$4)", [foreign, devPage.id, fresh.host, target])).rejects.toMatchObject({ code: "PT404" });
    await expect(edge.query("select public.reserve_page_domain($1,$2,$3,$4)", [owner, devPage.id, fresh.host, target])).rejects.toMatchObject({ code: "42501" });
  });
  it("validates reserved slugs at migration time and fails loudly on a pre-existing conflict", async () => {
    const constraint = (await runtime.admin.query("select convalidated,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='public.status_pages'::regclass and conname='status_pages_edge_slug_check'")).rows[0];
    expect(constraint.convalidated).toBe(true);
    const client = await runtime.admin.connect();
    try {
      await client.query("begin");
      await client.query("alter table public.status_pages drop constraint status_pages_edge_slug_check");
      await client.query("update public.status_pages set slug='health' where id=$1", [page.id]);
      await expect(client.query(`alter table public.status_pages add constraint status_pages_edge_slug_check ${constraint.definition}`)).rejects.toMatchObject({ code: "23514" });
    } finally { await client.query("rollback"); client.release(); }
  });
});
