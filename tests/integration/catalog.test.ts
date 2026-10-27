import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { describeTarget, readTarget } from "../support/integration";
import { DEFINER_FUNCTIONS, INGEST_FUNCTIONS, PROBE_FUNCTIONS, WATCHDOG_FUNCTIONS } from "../support/probe-functions";

/* The schema catalog suite (`docs/TESTS.md`, the Schema catalog row;
   `AGENTS.md § 1.4`). One read-only query enumerates every relation and function
   in `public` — future objects included — and every assertion below runs over
   that enumeration, not over a fixed list.

   Route: `npx supabase db query --linked --project-ref <ref> --file <sql>
   --output-format json`, through the developer's `supabase login`. The ref is
   the one `SUPABASE_URL` names, never a link or a config file, and the SQL goes
   through a temp file because a multi-line argument is mangled by the shell on
   Windows (`§ Rules that came from bugs`). No fixtures, nothing written.

   The first assertions prove the query arrived: the product's own tables and
   functions are there, and the migration ledger holds every file in
   `supabase/migrations/`. Every other assertion expects an empty list, which an
   empty or wrong project would pass. */

const target = readTarget();

const PRODUCT_TABLES = [
  "api_tokens",
  "agent_budgets",
  "agent_requests",
  "agent_activity",
  "agent_calls",
  "response_rollups",
  "alert_channels",
  "alert_deliveries",
  "alert_events",
  "alert_exclusions",
  "alert_suppressions",
  "app_logos",
  "apps",
  "budgets",
  "component_monitors",
  "domain_registrations",
  "heartbeat_latest",
  "incident_notes",
  "incidents",
  "monitor_secrets",
  "monitors",
  "page_assets",
  "page_components",
  "probe_flush_receipts",
  "rollups_1d",
  "status_pages",
  "workspaces",
];

const PRODUCT_FUNCTIONS = [
  "agent_token_create(text,text,text,text,text,text)",
  "agent_budget(text,integer)",
  "agent_create_monitor(text,text,jsonb,jsonb)",
  "agent_write(text,text,text,text,text,uuid,text,jsonb,jsonb)",
  "agent_published_notes(text,text[])",
  "agent_check_times(text)",
  "agent_history(text,text,integer,integer,text)",
  "agent_response_times(text,text,integer,text,integer,integer)",
  "response_rollups_add()",
  "ack_incident(text,text,text)",
  "alert_claim(text,integer,integer,text)",
  "alert_events_from_incident()",
  "alert_expand(text,text[])",
  "alert_mark(text,text,text,text,text,integer,boolean)",
  "alert_members_channel()",
  "alert_overview(text,integer)",
  "alert_pending_events(integer,text)",
  "alert_unsubscribe(text)",
  "bind_telegram_chat(text,integer,bigint,text)",
  "confirm_alert_address(text,integer)",
  "create_alert_address(text,text,text,text,boolean)",
  "create_app(text,text,text,integer)",
  "create_monitor(text,text,text,text,text,text,text,integer,jsonb,text,jsonb,integer,integer,integer,integer,integer,integer,text)",
  "create_status_page(text,text,text,text,text,text,integer)",
  "create_telegram_link(text,text,text)",
  "delete_app(text,text)",
  "delete_monitor(text,text)",
  "domain_registration_for(text[])",
  "ensure_workspace(text)",
  "forget_open_windows_on_edit()",
  "monitor_days(text[],integer)",
  "monitor_history(text,text)",
  "monitor_target_host(text,text)",
  "new_id(text)",
  "pause_monitor(text,text,integer,text)",
  "public_incident(text)",
  "public_status_snapshot(text)",
  "resume_monitor(text,text)",
  "rollups_1d_add()",
  "rollups_1d_merge()",
  "save_incident_note(text,text,text,text,text,boolean,text,text)",
  "save_service_monitor(text,text,text,text,text,text,jsonb,text,boolean,integer,integer,integer,integer)",
  "save_status_page(text,text,text,text,text,text,text,text,boolean,boolean,integer,jsonb,boolean,boolean)",
  "spend_budget(text,text,text,integer,integer,integer,integer)",
  "telegram_stop(bigint)",
  "update_monitor(text,text,text,text,text,integer,jsonb,jsonb,integer,integer,integer,integer)",
  "workspace_domains(text)",
  "workspace_history(text)",
  "workspace_snapshot(text)",
];

const CLIENT_ROLES = ["anon", "authenticated"];

const CATALOG_SQL = `
with rel as (
  select c.oid, c.relname, c.relkind::text as kind, c.relrowsecurity as rls, c.relowner,
         coalesce(to_json(c.reloptions), '[]'::json) as options,
         c.relacl
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
),
fn as (
  select p.oid, p.proname, p.prokind::text as kind, p.prosecdef, p.proowner, p.proacl,
         coalesce(to_json(p.proconfig), '[]'::json) as config
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
),
owners as (
  select distinct relowner as owner from rel where kind in ('r', 'p')
),
kinds(objtype, code) as (values ('r', 'r'), ('S', 's'), ('f', 'f'))
select json_build_object(
  'migrations', (select coalesce(json_agg(version order by version), '[]'::json) from supabase_migrations.schema_migrations),
  'relations', (select coalesce(json_agg(json_build_object(
      'name', r.relname,
      'kind', r.kind,
      'rls', r.rls,
      'options', r.options,
      'grantees', (select coalesce(json_agg(a.privilege_type || ' to ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end), '[]'::json)
                     from aclexplode(coalesce(r.relacl, acldefault(case when r.kind = 'S' then 's' else 'r' end::"char", r.relowner))) a),
      'columnGrantees', (select coalesce(json_agg(att.attname || ': ' || a.privilege_type || ' to ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end), '[]'::json)
                           from pg_attribute att, aclexplode(att.attacl) a
                          where att.attrelid = r.oid and att.attacl is not null),
      'clientPrivileges', (select coalesce(json_agg(x.role || ' ' || x.priv), '[]'::json)
                             from (select role, priv
                                     from unnest(array['anon', 'authenticated']) as role,
                                          unnest(case when r.kind = 'S' then array['USAGE', 'SELECT', 'UPDATE']
                                                      else array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] end) as priv
                                    where case when r.kind = 'S' then has_sequence_privilege(role, r.oid, priv)
                                               else has_table_privilege(role, r.oid, priv)
                                                    or (priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege(role, r.oid, priv)) end) x),
      'serviceRole', case when r.kind in ('r', 'p') then json_build_object(
                       'select', has_table_privilege('service_role', r.oid, 'SELECT'),
                       'insert', has_table_privilege('service_role', r.oid, 'INSERT'),
                       'update', has_table_privilege('service_role', r.oid, 'UPDATE'),
                       'delete', has_table_privilege('service_role', r.oid, 'DELETE')) end
    ) order by r.relname), '[]'::json) from rel r),
  'policies', (select coalesce(json_agg(pol.tablename || '.' || pol.policyname order by pol.tablename, pol.policyname), '[]'::json)
                 from pg_policies pol where pol.schemaname = 'public'),
  'functions', (select coalesce(json_agg(json_build_object(
      'signature', f.oid::regprocedure::text,
      'kind', f.kind,
      'securityDefiner', f.prosecdef,
      'config', f.config,
      'extension', exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = f.oid and d.deptype = 'e'),
      'grantees', (select coalesce(json_agg(a.privilege_type || ' to ' || case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end), '[]'::json)
                     from aclexplode(coalesce(f.proacl, acldefault('f'::"char", f.proowner))) a),
      'anonExecute', has_function_privilege('anon', f.oid, 'EXECUTE'),
      'authenticatedExecute', has_function_privilege('authenticated', f.oid, 'EXECUTE'),
      'serviceRoleExecute', has_function_privilege('service_role', f.oid, 'EXECUTE'),
      'probeExecute', has_function_privilege('probe', f.oid, 'EXECUTE'),
      'ingestExecute', has_function_privilege('ingest', f.oid, 'EXECUTE'),
      'watchdogExecute', has_function_privilege('watchdog', f.oid, 'EXECUTE')
    ) order by f.oid::regprocedure::text), '[]'::json) from fn f),
  'creatorDefaults', (select coalesce(json_agg(json_build_object(
      'role', pg_get_userbyid(o.owner),
      'objtype', k.objtype,
      'grantees', (select coalesce(json_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end), '[]'::json)
                     from (select coalesce((select d.defaclacl from pg_default_acl d
                                             where d.defaclrole = o.owner and d.defaclnamespace = 0 and d.defaclobjtype = k.objtype::"char"),
                                           acldefault(k.code::"char", o.owner)) as acl
                           union all
                           select d.defaclacl from pg_default_acl d
                            where d.defaclrole = o.owner and d.defaclnamespace = 'public'::regnamespace and d.defaclobjtype = k.objtype::"char") s,
                          aclexplode(s.acl) a)
    ) order by k.objtype), '[]'::json) from owners o cross join kinds k),
  'schemaPrivileges', (select coalesce(json_agg(role || ' ' || priv order by role, priv), '[]'::json)
                        from unnest(array['anon', 'authenticated']) as role, unnest(array['USAGE', 'CREATE']) as priv
                       where has_schema_privilege(role, 'public', priv)),
  'published', (select coalesce(json_agg(pt.pubname || ': ' || pt.tablename order by pt.pubname, pt.tablename), '[]'::json)
                  from pg_publication_tables pt where pt.schemaname = 'public'),
  'publicSchemaDefaults', (select coalesce(json_agg(json_build_object(
      'role', pg_get_userbyid(d.defaclrole),
      'objtype', d.defaclobjtype::text,
      'clientGrantees', (select coalesce(json_agg(case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end order by a.grantee), '[]'::json)
                           from aclexplode(d.defaclacl) a
                          where a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon', 'authenticated'))
    ) order by pg_get_userbyid(d.defaclrole), d.defaclobjtype::text), '[]'::json)
     from pg_default_acl d where d.defaclnamespace = 'public'::regnamespace)
) as catalog;
`;

type Relation = {
  name: string;
  kind: string;
  rls: boolean;
  options: string[];
  grantees: string[];
  columnGrantees: string[];
  clientPrivileges: string[];
  serviceRole: { select: boolean; insert: boolean; update: boolean; delete: boolean } | null;
};
type Fn = {
  signature: string;
  kind: string;
  securityDefiner: boolean;
  config: string[];
  extension: boolean;
  grantees: string[];
  anonExecute: boolean;
  authenticatedExecute: boolean;
  serviceRoleExecute: boolean;
  probeExecute: boolean;
  ingestExecute: boolean;
  watchdogExecute: boolean;
};
type Catalog = {
  migrations: string[];
  relations: Relation[];
  policies: string[];
  functions: Fn[];
  creatorDefaults: { role: string; objtype: string; grantees: string[] }[];
  publicSchemaDefaults: { role: string; objtype: string; clientGrantees: string[] }[];
  schemaPrivileges: string[];
  published: string[];
};

/** One `supabase db query` through a temp file; the exit code and stdout are read, never guessed. */
function queryCatalog(ref: string): Catalog {
  const dir = mkdtempSync(join(tmpdir(), "staygreen-catalog-"));
  const file = join(dir, "catalog.sql");
  try {
    writeFileSync(file, CATALOG_SQL, "utf8");
    const run = spawnSync("npx", ["supabase", "db", "query", "--linked", "--project-ref", ref, "--file", `"${file}"`, "--output-format", "json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: process.platform === "win32",
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (run.error) throw new Error(`supabase db query did not run: ${run.error.message}`);
    if (run.status !== 0) throw new Error(`supabase db query exited ${run.status}: ${(run.stderr || run.stdout).slice(0, 2000)}`);
    const out = JSON.parse(run.stdout) as { rows?: { catalog?: Catalog }[] };
    const catalog = out.rows?.[0]?.catalog;
    if (!catalog) throw new Error(`supabase db query returned no catalog row: ${run.stdout.slice(0, 500)}`);
    return catalog;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const isClient = (grant: string) => / to (PUBLIC|anon|authenticated)$/.test(grant);

describeTarget("schema catalog: public posture on the development project", target, (t) => {
  let catalog: Catalog;

  beforeAll(() => {
    catalog = queryCatalog(t.ref);
  }, 150_000);

  const tables = () => catalog.relations.filter((r) => r.kind === "r" || r.kind === "p");
  const views = () => catalog.relations.filter((r) => r.kind === "v" || r.kind === "m");

  // ── the target arrived ──────────────────────────────────────────────────────

  it("names the development project, and finds the product's own tables there", () => {
    expect(t.ref).toBe("xxxxxxxxxxxxxxxxxxxx");
    expect(tables().map((r) => r.name)).toEqual(expect.arrayContaining(PRODUCT_TABLES));
  });

  it("finds every product function, by its full signature", () => {
    expect(catalog.functions.map((f) => f.signature)).toEqual(expect.arrayContaining(PRODUCT_FUNCTIONS));
  });

  it("has applied every migration in supabase/migrations/, and none the repo lacks", () => {
    const files = readdirSync(join(process.cwd(), "supabase", "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => f.split("_")[0])
      .sort();
    expect(files.length).toBeGreaterThan(0);
    expect(catalog.migrations).toEqual(files);
  });

  // ── tables ──────────────────────────────────────────────────────────────────

  it("has RLS on for every table in public", () => {
    expect(tables().length).toBeGreaterThanOrEqual(PRODUCT_TABLES.length);
    expect(tables().filter((r) => !r.rls).map((r) => r.name)).toEqual([]);
  });

  it("has zero policies in public", () => {
    expect(catalog.policies).toEqual([]);
  });

  it("grants nothing on any relation to PUBLIC, anon or authenticated (table, column or inherited)", () => {
    expect(catalog.relations.length).toBeGreaterThan(0);
    expect(catalog.relations.flatMap((r) => r.grantees.filter(isClient).map((g) => `${r.name}: ${g}`))).toEqual([]);
    expect(catalog.relations.flatMap((r) => r.columnGrantees.filter(isClient).map((g) => `${r.name}.${g}`))).toEqual([]);
    expect(catalog.relations.flatMap((r) => r.clientPrivileges.map((p) => `${r.name}: ${p}`))).toEqual([]);
  });

  it("lets service_role read and write product tables; probe receipts belong only to the operator APIs", () => {
    // The dashboard never needs operational liveness receipts, so this table earns no secret-key grant.
    expect(tables().filter((r) => r.name !== "probe_flush_receipts" && !(r.serviceRole?.select && r.serviceRole.insert && r.serviceRole.update && r.serviceRole.delete)).map((r) => r.name)).toEqual([]);
    expect(tables().find((r) => r.name === "probe_flush_receipts")?.serviceRole).toEqual({ select: false, insert: false, update: false, delete: false });
  });

  it("has only security_invoker views", () => {
    const invoker = (r: Relation) => r.kind === "v" && r.options.some((o) => /^security_invoker=(true|on|1|yes)$/i.test(o));
    expect(views().filter((r) => !invoker(r)).map((r) => `${r.name} (${r.kind})`)).toEqual([]);
  });

  it("lets anon and authenticated use schema public (PostgREST needs it to reach a refusal) but never create in it", () => {
    expect(catalog.schemaPrivileges).toEqual(["anon USAGE", "authenticated USAGE"]);
  });

  it("publishes no public table to Realtime or any other publication (polling, not Realtime)", () => {
    expect(catalog.published).toEqual([]);
  });

  // ── functions ───────────────────────────────────────────────────────────────

  it("lets neither anon nor authenticated execute any function in public", () => {
    expect(catalog.functions.length).toBeGreaterThanOrEqual(PRODUCT_FUNCTIONS.length);
    expect(catalog.functions.filter((f) => f.anonExecute).map((f) => f.signature)).toEqual([]);
    expect(catalog.functions.filter((f) => f.authenticatedExecute).map((f) => f.signature)).toEqual([]);
    expect(catalog.functions.flatMap((f) => f.grantees.filter(isClient).map((g) => `${f.signature}: ${g}`))).toEqual([]);
  });

  it("lets service_role execute every function except the exact probe-only and ingest-only APIs", () => {
    expect(catalog.functions.filter((f) => !f.serviceRoleExecute).map((f) => f.signature).sort()).toEqual(DEFINER_FUNCTIONS);
  });

  it("allows SECURITY DEFINER, probe execution and ingest execution only for the exact bounded APIs", () => {
    // These exceptions are the explicit Part A and Part B briefs. A prefix match would bless
    // future APIs without reviewing their privilege, so every side pins full signatures instead.
    expect(catalog.functions.filter((f) => f.securityDefiner).map((f) => f.signature).sort()).toEqual(DEFINER_FUNCTIONS);
    expect(catalog.functions.filter((f) => f.probeExecute).map((f) => f.signature).sort()).toEqual(PROBE_FUNCTIONS);
    // The heartbeat Worker's role runs one function and nothing else (migration 019).
    expect(catalog.functions.filter((f) => f.ingestExecute).map((f) => f.signature).sort()).toEqual(INGEST_FUNCTIONS);
    expect(catalog.functions.filter((f) => f.watchdogExecute).map((f) => f.signature).sort()).toEqual(WATCHDOG_FUNCTIONS);
  });

  it("pins every function's search_path to empty, as the migrations declare", () => {
    expect(catalog.functions.filter((f) => !f.config.includes('search_path=""')).map((f) => f.signature)).toEqual([]);
  });

  it("holds no extension-owned function in public", () => {
    expect(catalog.functions.filter((f) => f.extension).map((f) => f.signature)).toEqual([]);
  });

  // ── what the migration role creates next ───────────────────────────────────

  it("the migration role's defaults give a NEW table, sequence or function in public to nobody but itself and service_role", () => {
    // Effective default = the role's global entry (or Postgres's hard-wired default when it
    // has none) merged with its per-schema entry for `public`. A per-schema REVOKE cannot
    // remove a global grant, and Postgres's hard-wired default for functions is EXECUTE to
    // PUBLIC (`ALTER DEFAULT PRIVILEGES`, Notes).
    expect(catalog.creatorDefaults.length).toBe(3 * new Set(catalog.creatorDefaults.map((d) => d.role)).size);
    const leaks = catalog.creatorDefaults.flatMap((d) =>
      d.grantees.filter((g) => g === "PUBLIC" || CLIENT_ROLES.includes(g)).map((g) => `${d.role} ${d.objtype} -> ${g}`),
    );
    expect([...new Set(leaks)].sort()).toEqual([]);
  });

  it("pins the platform's own default grants in public as known debt: supabase_admin's, which the migration role cannot alter", () => {
    const clientDefaults = catalog.publicSchemaDefaults
      .filter((d) => d.clientGrantees.length > 0)
      .map((d) => `${d.role} ${d.objtype}: ${[...new Set(d.clientGrantees)].sort().join(",")}`)
      .sort();
    expect(clientDefaults).toEqual(["supabase_admin S: anon,authenticated", "supabase_admin f: anon,authenticated", "supabase_admin r: anon,authenticated"]);
  });
});
