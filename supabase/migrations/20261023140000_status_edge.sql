-- 029: status edge. Additive; existing dashboard/probe/sender signatures remain valid.
begin;
alter table public.status_pages add column if not exists members_only boolean not null default false;
alter table public.status_pages add column if not exists edge_withdrawn boolean not null default false;
alter table public.status_pages add column if not exists visibility_version integer not null default 0;
-- Validate existing rows too: a conflicting slug must fail the migration loudly, not strand
-- a page whose later saves or private transitions would fail this check.
alter table public.status_pages drop constraint if exists status_pages_edge_slug_check;
alter table public.status_pages add constraint status_pages_edge_slug_check check
  (slug not in ('health','ask','page-assets','w','robots','favicon','summary','badge','_edge'));

create table if not exists public.page_domains (
  host text primary key check (host = lower(host) and char_length(host) <= 253
    and host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
    and host <> 'staygreen.io' and host not like '%.staygreen.io'),
  workspace_id text not null,
  page_id text not null unique,
  -- A new reservation always needs a new DNS change. The shared parent alone proves nothing:
  -- a removed page/workspace may leave its old CNAME behind.
  cname_target text not null unique
    default (replace(pg_catalog.gen_random_uuid()::text,'-','') || '.domains.staygreen.io')
    check (cname_target ~ '^[a-f0-9]{32}\.domains\.staygreen\.io$'),
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  monitor_id text,
  foreign key (page_id,workspace_id) references public.status_pages(id,workspace_id) on delete cascade,
  foreign key (monitor_id,workspace_id) references public.monitors(id,workspace_id) on delete set null (monitor_id)
);
alter table public.page_domains enable row level security;
revoke all on public.page_domains from public,anon,authenticated;
grant select,insert,update,delete on public.page_domains to service_role;

create or replace function public.status_page_snapshot(p_slug text, p_workspace_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select jsonb_build_object(
    'page', jsonb_build_object(
      'slug', p.slug, 'name', p.name, 'logoText', p.logo_text, 'homepage', p.homepage,
      'logoUrl', (select '/page-assets/' || a.id from public.page_assets a where a.page_id = p.id and a.kind = 'logo'),
      'faviconUrl', (select '/page-assets/' || a.id from public.page_assets a where a.page_id = p.id and a.kind = 'favicon'),
      'accent', p.accent, 'theme', p.theme, 'poweredBy', p.powered_by, 'noindex', p.noindex,
      'historyDays', p.history_days
    ),
    'components', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', c.position, 'name', c.name, 'inApp', c.in_app,
               'states', (select coalesce(jsonb_agg(
                                   case when m.paused_at is not null and (m.paused_until is null or m.paused_until > now())
                                        then 'paused' else m.state end), '[]'::jsonb)
                            from public.component_monitors cm
                            join public.monitors m on m.id = cm.monitor_id
                           where cm.component_id = c.id),
               'daily', (select coalesce(jsonb_agg(jsonb_build_object('d', x.day, 'up', x.up) order by x.day), '[]'::jsonb)
                           from (select md.day, min(md.up) as up
                                   from public.monitor_days(array(select cm.monitor_id from public.component_monitors cm where cm.component_id = c.id),
                                                            least(p.history_days, 90)) md
                                  group by md.day) x)
             ) order by c.position)
        from public.page_components c
       where c.page_id = p.id
         and exists (select 1 from public.component_monitors cm where cm.component_id = c.id)
    ), '[]'::jsonb),
    'incidents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'title', i.title, 'severity', i.severity,
               'openedAt', i.opened_at, 'resolvedAt', i.resolved_at,
               'components', (select jsonb_agg(c.position order by c.position)
                                from public.page_components c
                                join public.component_monitors cm on cm.component_id = c.id
                               where c.page_id = p.id and cm.monitor_id = i.monitor_id),
               'notes', (select jsonb_agg(jsonb_build_object('id', n.id, 'state', n.state, 'body', n.body, 'at', n.published_at)
                                          order by n.published_at desc)
                           from public.incident_notes n
                          where n.incident_id = i.id and n.status = 'published')
             ) order by i.opened_at desc)
        from public.incidents i
       where i.workspace_id = p.workspace_id
         and coalesce(i.resolved_at, now()) >= now() - make_interval(days => p.history_days)
         and exists (select 1 from public.incident_notes n where n.incident_id = i.id and n.status = 'published')
         and exists (select 1
                       from public.component_monitors cm
                       join public.page_components c on c.id = cm.component_id
                      where c.page_id = p.id and cm.monitor_id = i.monitor_id)
    ), '[]'::jsonb)
  )
  from public.status_pages p
  where p.slug = p_slug and ((not p.members_only and not p.edge_withdrawn) or p.workspace_id = p_workspace_id)
$fn$;

create or replace function public.public_status_snapshot(p_slug text) returns jsonb
language sql stable security invoker set search_path='' as $fn$
  select public.status_page_snapshot(p_slug, null);
$fn$;

-- Access metadata carries no page content. Only the Next server has these invoker functions.
create or replace function public.status_page_access(p_slug text, p_incident_id text default null) returns jsonb
language sql stable security invoker set search_path='' as $fn$
  select jsonb_build_object('id',p.id,'slug',p.slug,'workspaceId',p.workspace_id,
    'orgId',w.clerk_org_id)
  from public.status_pages p join public.workspaces w on w.id=p.workspace_id
  where (p.members_only or p.edge_withdrawn) and (p.slug=p_slug or (p_incident_id is not null and exists (
    select 1 from public.incidents i join public.component_monitors cm on cm.monitor_id=i.monitor_id
    join public.page_components c on c.id=cm.component_id
    where i.id=p_incident_id and c.page_id=p.id and i.workspace_id=p.workspace_id
      and exists(select 1 from public.incident_notes n where n.incident_id=i.id and n.status='published'))))
  order by p.created_at limit 1;
$fn$;

-- Retire the feed before asking the renderer to drop its in-memory and CDN copies.
-- The page id and version fence a refresh started before withdrawal, without fencing a new
-- page that reuses the slug. A later republish of this page advances its own version.
create or replace function public.begin_private_page(p_workspace_id text,p_page_id text,p_private_pages boolean)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare p public.status_pages;
begin
  select * into p from public.status_pages where id=p_page_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'not_found' using errcode='PT404'; end if;
  if p.members_only then return null; end if;
  if p_private_pages is distinct from true then raise exception 'private_pages_required' using errcode='P0001'; end if;
  update public.status_pages set edge_withdrawn=true,visibility_version=visibility_version+1 where id=p_page_id returning * into p;
  return jsonb_build_object('pageId',p.id,'slug',p.slug,'version',p.visibility_version);
end $fn$;
revoke all on function public.begin_private_page(text,text,boolean) from public,anon,authenticated,probe,ingest,watchdog,alert_sender;
grant execute on function public.begin_private_page(text,text,boolean) to service_role;

-- Separate function preserves old save_status_page callers during rollout.
create or replace function public.save_status_page_access(
  p_workspace_id text,p_page_id text,p_slug text,p_name text,p_logo_text text,p_homepage text,
  p_accent text,p_theme text,p_powered_by boolean,p_noindex boolean,p_history_days integer,
  p_components jsonb,p_white_label boolean,p_private_pages boolean,p_members_only boolean,p_withdrawal_version integer default null
) returns public.status_pages language plpgsql security invoker set search_path='' as $fn$
declare v public.status_pages;
begin
  select * into v from public.status_pages where id=p_page_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'not_found' using errcode='PT404'; end if;
  if p_members_only is null then raise exception 'limits_required' using errcode='22004'; end if;
  -- Losing an entitlement never publishes a private page. Existing private pages stay private.
  if p_members_only and not v.members_only and p_private_pages is distinct from true then
    raise exception 'private_pages_required' using errcode='P0001';
  end if;
  if p_members_only and not v.members_only and
    (not v.edge_withdrawn or p_withdrawal_version is distinct from v.visibility_version) then
    raise exception 'withdrawal_required' using errcode='P0001';
  end if;
  perform public.save_status_page(p_workspace_id,p_page_id,p_slug,p_name,p_logo_text,p_homepage,
    p_accent,p_theme,p_powered_by,p_noindex,p_history_days,p_components,p_white_label,p_private_pages);
  update public.status_pages set members_only=p_members_only,edge_withdrawn=false,visibility_version=visibility_version+1 where id=p_page_id returning * into v;
  return v;
end $fn$;

create or replace function public.reserve_page_domain(p_workspace_id text,p_page_id text,p_host text)
returns public.page_domains language plpgsql security invoker set search_path='' as $fn$
declare v public.page_domains;
begin
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not exists(select 1 from public.status_pages where id=p_page_id and workspace_id=p_workspace_id and not members_only) then
    raise exception 'not_found' using errcode='PT404'; end if;
  delete from public.page_domains where verified_at is null and created_at <= now()-interval '7 days';
  select * into v from public.page_domains where page_id=p_page_id;
  if v.host=p_host then return v; end if;
  if (select count(*) from public.page_domains where workspace_id=p_workspace_id and verified_at is null and page_id<>p_page_id)>=3 then
    raise exception 'pending_domain_limit' using errcode='P0001'; end if;
  -- Never reset an existing verified domain implicitly; remove it explicitly first.
  if v.host is not null then raise exception 'domain_exists' using errcode='P0001'; end if;
  insert into public.page_domains(host,workspace_id,page_id) values(p_host,p_workspace_id,p_page_id) returning * into v;
  return v;
end $fn$;

-- DNS is checked by the server. Bind its proof to both the timestamp and random target:
-- an old CNAME or an in-flight check from a removed claim cannot admit a new reservation.
create or replace function public.verify_page_domain(p_workspace_id text,p_page_id text,p_host text,p_created_at timestamptz,
  p_cname_target text,p_max_monitors integer,p_max_per_host integer) returns boolean
language plpgsql security invoker set search_path='' as $fn$
declare d public.page_domains; p public.status_pages; m public.monitors;
begin
  perform 1 from public.workspaces where id=p_workspace_id for update;
  select * into d from public.page_domains where page_id=p_page_id and workspace_id=p_workspace_id
    and host=p_host and created_at=p_created_at and cname_target=p_cname_target for update;
  if not found or (d.verified_at is null and d.created_at<=now()-interval '7 days') then return false; end if;
  select * into p from public.status_pages where id=p_page_id and workspace_id=p_workspace_id and not members_only;
  if not found then return false; end if;
  if d.verified_at is not null and d.monitor_id is not null then return true; end if;
  if p_max_monitors is null or p_max_per_host is null then raise exception 'limits_required' using errcode='22004'; end if;
  select * into m from public.create_monitor(p_workspace_id=>p_workspace_id,p_id=>public.new_id('mon'),p_app_id=>p.app_id,
    p_type=>'dns',p_name=>left(p.name || ' CNAME',80),p_target=>'CNAME ' || d.host,p_target_host=>d.host,
    p_config=>jsonb_build_object('record','CNAME','name',d.host,'expected',d.cname_target),
    p_interval_sec=>600,p_max_monitors=>p_max_monitors,p_per_host=>p_max_per_host,
    p_heartbeat_token_hash=>null,p_secrets=>'[]'::jsonb,p_max_heartbeat_assertions=>0,
    p_max_heartbeats=>0,p_max_assertions=>0,p_min_interval_sec=>600);
  update public.page_domains set verified_at=now(),monitor_id=m.id where host=d.host;
  return true;
end $fn$;

create or replace function public.edge_domain_allowed(p_host text) returns boolean
language sql stable security invoker set search_path='' as $fn$
  select exists(select 1 from public.page_domains d join public.status_pages p on p.id=d.page_id
    where d.host=p_host and d.verified_at is not null and not p.members_only and not p.edge_withdrawn);
$fn$;

-- A read-only runtime identity: no public table or function grants, no service credential.
do $fn$ begin
  if not exists(select 1 from pg_roles where rolname='edge') then
    create role edge nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $fn$;
create schema if not exists status_edge authorization postgres;
revoke all on schema status_edge from public,anon,authenticated,service_role,probe,ingest,watchdog,alert_sender,edge;
grant usage on schema status_edge to edge;
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema status_edge revoke all on functions from public,anon,authenticated,service_role,edge;

-- One bounded page of public snapshots plus only their pixels. Called by the background refresh,
-- inside a repeatable-read transaction; never called by an HTTP request.
create or replace function status_edge.pages(p_after text default '',p_limit integer default 100)
returns setof jsonb language sql stable security definer set search_path='' as $fn$
  with pages as materialized (
    select p.*,public.public_status_snapshot(p.slug) as snapshot from public.status_pages p
    where not p.members_only and not p.edge_withdrawn and p.slug>coalesce(p_after,'')
    order by p.slug limit least(greatest(coalesce(p_limit,100),1),100)
  )
  -- The existing app DTO has an internal incident-title fallback. The edge needs only component
  -- names to build visitor titles, so never give this narrower login that internal text.
  select jsonb_build_object('snapshot',jsonb_set(p.snapshot,'{incidents}',
      (select coalesce(jsonb_agg(i.value || jsonb_build_object('title','Incident') order by i.position),'[]'::jsonb)
       from jsonb_array_elements(p.snapshot->'incidents') with ordinality i(value,position))),
    'pageId',p.id,'version',p.visibility_version,
    'domain',(select d.host from public.page_domains d where d.page_id=p.id and d.verified_at is not null),
    'assets',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'mime',a.mime,'content',encode(a.content,'base64')))
      from public.page_assets a where a.page_id=p.id),'[]'::jsonb))
  from pages p order by p.slug;
$fn$;
alter function status_edge.pages(text,integer) owner to postgres;
revoke all on all functions in schema status_edge from public,anon,authenticated,service_role,probe,ingest,watchdog,alert_sender,edge;
grant execute on function status_edge.pages(text,integer) to edge;

-- Notification payloads contain no customer data. Transactional NOTIFY coalesces changes;
-- the poll also observes time-based history expiry, pause expiry and a lost listener.
create or replace function public.status_edge_changed() returns trigger
language plpgsql security invoker set search_path='' as $fn$
begin perform pg_catalog.pg_notify('status_edge_changed',''); return null; end $fn$;
do $fn$ declare t text; begin
  foreach t in array array['status_pages','page_components','component_monitors','page_assets','page_domains','monitors','incidents','incident_notes','rollups_1d'] loop
    execute format('drop trigger if exists status_edge_changed on public.%I',t);
    execute format('create trigger status_edge_changed after insert or update or delete on public.%I for each statement execute function public.status_edge_changed()',t);
  end loop;
end $fn$;

revoke all on function public.status_page_snapshot(text,text), public.status_page_access(text,text),
  public.save_status_page_access(text,text,text,text,text,text,text,text,boolean,boolean,integer,jsonb,boolean,boolean,boolean,integer),
  public.reserve_page_domain(text,text,text),public.verify_page_domain(text,text,text,timestamptz,text,integer,integer),
  public.edge_domain_allowed(text),public.status_edge_changed()
  from public,anon,authenticated,probe,ingest,watchdog,alert_sender,edge;
grant execute on function public.status_page_snapshot(text,text),public.status_page_access(text,text),
  public.save_status_page_access(text,text,text,text,text,text,text,text,boolean,boolean,integer,jsonb,boolean,boolean,boolean,integer),
  public.reserve_page_domain(text,text,text),public.verify_page_domain(text,text,text,timestamptz,text,integer,integer),
  public.edge_domain_allowed(text),public.status_edge_changed() to service_role;
alter table public.budgets drop constraint if exists budgets_action_check;
alter table public.budgets add constraint budgets_action_check check(action in ('test_check','alert_test','alert_confirm','domain_check'));
commit;
