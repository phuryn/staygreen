-- 030: authenticated MCP/REST, token tombstones, atomic writes/receipts, and history reads.
-- Additive: no existing RPC signature, probe binary or dashboard contract changes.
begin;

create table if not exists public.api_tokens (
  id text primary key default public.new_id('tok'),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 60),
  kid text not null unique check (kid ~ '^[0-9a-f]{24}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  scope text not null check (scope in ('read','write')),
  created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz
);
create index if not exists api_tokens_workspace_idx on public.api_tokens(workspace_id, created_at desc);

-- Infrastructure counters, including a verified OAuth user before their workspace exists.
-- The key is purpose-separated HMAC, not a user/org id or token. No application data lives here.
create table if not exists public.agent_budgets (
  key text primary key check (key ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null, used integer not null check (used >= 0)
);
create table if not exists public.agent_requests (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  actor text not null check (char_length(actor) between 1 and 128), request_id uuid not null,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  tool text not null check (tool in ('provision_app','create_monitor','pause','draft_incident_update')),
  result jsonb not null, created_at timestamptz not null default now(),
  primary key(workspace_id, actor, request_id)
);
create table if not exists public.agent_activity (
  id text primary key default public.new_id('act'),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  actor text not null check (char_length(actor) between 1 and 128),
  client text not null check (char_length(client) between 1 and 160),
  tool text not null check (tool in ('provision_app','create_monitor','pause','draft_incident_update')),
  resource_id text not null, created_at timestamptz not null default now()
);
create index if not exists agent_activity_workspace_idx on public.agent_activity(workspace_id, created_at desc, id);
create table if not exists public.agent_calls (
  id text primary key default public.new_id('call'),
  workspace_id text references public.workspaces(id) on delete cascade,
  actor text, client text check (char_length(client) <= 160),
  auth text not null check (auth in ('none','api_token','oauth')),
  source text not null check (source in ('mcp','rest')),
  method text not null check (char_length(method) <= 100),
  tool text check (char_length(tool) <= 80),
  status integer not null check (status between 100 and 599),
  outcome text not null check (char_length(outcome) <= 80),
  duration_ms integer not null check (duration_ms >= 0), created_at timestamptz not null default now()
);
create index if not exists agent_calls_workspace_idx on public.agent_calls(workspace_id, created_at desc);

alter table public.api_tokens enable row level security;
alter table public.agent_budgets enable row level security;
alter table public.agent_requests enable row level security;
alter table public.agent_activity enable row level security;
alter table public.agent_calls enable row level security;
revoke all on public.api_tokens, public.agent_budgets, public.agent_requests, public.agent_activity, public.agent_calls from public, anon, authenticated;
grant select, insert, update, delete on public.api_tokens, public.agent_budgets, public.agent_requests, public.agent_activity, public.agent_calls to service_role;

create or replace function public.agent_token_create(p_workspace_id text,p_id text,p_name text,p_kid text,p_hash text,p_scope text)
returns void language plpgsql security invoker set search_path = '' as $fn$
begin
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found then raise exception 'not_found' using errcode='PT404'; end if;
  if (select count(*) from public.api_tokens where workspace_id=p_workspace_id and revoked_at is null)>=100 then raise exception 'token_limit'; end if;
  insert into public.api_tokens(id,workspace_id,name,kid,hash,scope) values(p_id,p_workspace_id,p_name,p_kid,p_hash,p_scope);
end;
$fn$;
revoke all on function public.agent_token_create(text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.agent_token_create(text,text,text,text,text,text) to service_role;

create or replace function public.agent_budget(p_key text, p_limit integer)
returns integer language plpgsql security invoker set search_path = '' as $fn$
declare b public.agent_budgets;
begin
  if p_limit is null or p_limit < 1 or p_limit > 120 then raise exception 'limits_required' using errcode = '22004'; end if;
  insert into public.agent_budgets values(p_key, now(), 0) on conflict do nothing;
  select * into b from public.agent_budgets where key = p_key for update;
  if b.started_at + interval '1 minute' > now() and b.used >= p_limit then
    return greatest(1, ceil(extract(epoch from b.started_at + interval '1 minute' - now())))::int;
  end if;
  update public.agent_budgets set started_at = case when b.started_at + interval '1 minute' <= now() then now() else b.started_at end,
    used = case when b.started_at + interval '1 minute' <= now() then 1 else b.used + 1 end where key = p_key;
  return 0;
end;
$fn$;

-- Internal service-only helper: the same type/quota RPCs as dashboard saves. No generic
-- update primitive is exposed. Only freshly sealed credentials enter this function.
create or replace function public.agent_create_monitor(p_workspace_id text, p_app_id text, p_row jsonb, p_limits jsonb)
returns text language plpgsql security invoker set search_path = '' as $fn$
declare m public.monitors; v_id text := p_row->>'id';
begin
  -- The service resolves the app first; this keeps the database's answer the same on its own.
  if not exists (select 1 from public.apps where id = p_app_id and workspace_id = p_workspace_id) then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  if p_row->>'type' in ('stripe','supabase') then
    perform public.save_service_monitor(p_workspace_id, v_id, p_app_id, p_row->>'type', p_row->>'name', p_row->>'target',
      p_row->'config', p_row->>'service_sealed', false, (p_limits->>'monitors')::int,
      case when p_row->>'type' = 'stripe' then (p_limits->>'stripeAccounts')::int else (p_limits->>'supabaseMonitors')::int end,
      (p_limits->>'perHost')::int, (p_row->>'interval_sec')::int);
  else
    m := public.create_monitor(p_workspace_id, v_id, p_app_id, p_row->>'type', p_row->>'name', p_row->>'target',
      p_row->>'target_host', (p_row->>'interval_sec')::int, p_row->'config', p_row->>'heartbeat_hash',
      p_row->'secrets', (p_limits->>'monitors')::int, (p_limits->>'heartbeats')::int, (p_limits->>'assertions')::int,
      (p_limits->>'heartbeatAssertions')::int, (p_limits->>'perHost')::int, (p_limits->>'minInterval')::int,
      p_row->>'heartbeat_sealed');
    v_id := m.id;
  end if;
  return v_id;
end;
$fn$;

create or replace function public.agent_write(
  p_workspace_id text, p_actor text, p_client text, p_scope text, p_tool text,
  p_request_id uuid, p_input_hash text, p_payload jsonb, p_limits jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $fn$
declare
  prior public.agent_requests; a public.apps; p public.status_pages; n public.incident_notes;
  r jsonb; result jsonb; resource text; component text; monitor_id text; paused timestamptz;
  ids text[] := '{}'; made jsonb := '[]'; heartbeats jsonb := '[]'; k text; is_new boolean := false;
  app_name text; name_base text; name_suffix text; name_number integer := 1;
begin
  if p_scope is distinct from 'write' then raise exception 'insufficient_scope' using errcode = 'PT403'; end if;
  if p_tool is null or p_tool not in ('provision_app','create_monitor','pause','draft_incident_update') then raise exception 'unknown_tool' using errcode = '22023'; end if;
  if p_request_id is null or p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$' then raise exception 'request_id_required' using errcode = '22023'; end if;
  foreach k in array array['apps','monitors','heartbeats','assertions','heartbeatAssertions','perHost','minInterval','statusPages','stripeAccounts','supabaseMonitors'] loop
    if coalesce((p_limits->>k)::int, 0) < 1 then raise exception 'limits_required' using errcode = '22004'; end if;
  end loop;
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  -- Revocation completed before this transaction takes effect even if HTTP admission raced it.
  if p_actor like 'tok_%' then
    perform 1 from public.api_tokens where id = p_actor and workspace_id = p_workspace_id and revoked_at is null and scope = 'write' for share;
    if not found then raise exception 'invalid_token' using errcode = 'PT401'; end if;
  elsif p_actor is null or p_actor !~ '^[0-9a-f]{64}$' then raise exception 'invalid_actor' using errcode = '22023'; end if;
  select * into prior from public.agent_requests where workspace_id = p_workspace_id and actor = p_actor and request_id = p_request_id;
  if found then
    if prior.input_hash <> p_input_hash or prior.tool <> p_tool then raise exception 'request_conflict' using errcode = 'PT409'; end if;
    return prior.result;
  end if;

  case p_tool
  when 'provision_app' then
    -- Serializes normalized-URL setup with every dashboard create and quota check.
    select * into a from public.apps where workspace_id = p_workspace_id and rtrim(url, '/') = rtrim(p_payload->>'url', '/') order by created_at, id limit 1;
    if not found then
      app_name := p_payload->>'name';
      if app_name is null then
        -- Choose under the workspace lock, including names created by the dashboard.
        -- Explicit names are never rewritten: their constraints produce a plain refusal.
        name_base := left(coalesce(nullif(btrim(p_payload->>'name_base'), ''), 'App'), 60);
        app_name := name_base;
        while exists(select 1 from public.apps where workspace_id = p_workspace_id and lower(name) = lower(app_name)) loop
          name_number := name_number + 1;
          name_suffix := ' (' || name_number || ')';
          app_name := left(name_base, 60 - char_length(name_suffix)) || name_suffix;
        end loop;
      end if;
      a := public.create_app(p_workspace_id, app_name, p_payload->>'url', (p_limits->>'apps')::int);
      is_new := true;
      for r in select value from jsonb_array_elements(p_payload->'monitors') loop
        monitor_id := public.agent_create_monitor(p_workspace_id, a.id, r, p_limits);
        if r->>'type' = 'heartbeat' then
          -- Creation receipt only, sealed; never an arbitrary read of a monitor's ping token.
          heartbeats := heartbeats || jsonb_build_array(jsonb_build_object('monitor', monitor_id, 'name', r->>'name', 'sealed', r->>'heartbeat_sealed'));
        end if;
      end loop;
    end if;
    select * into p from public.status_pages where app_id = a.id and workspace_id = p_workspace_id;
    if not found then
      p := public.create_status_page(p_workspace_id, a.id, p_payload->>'slug', a.name, left(a.name,40), a.url, (p_limits->>'statusPages')::int);
      -- Only the website check is public by default. Cron and service monitors stay private.
      select id into monitor_id from public.monitors where app_id = a.id and workspace_id = p_workspace_id and type = 'http' order by created_at,id limit 1;
      if monitor_id is not null then
        insert into public.page_components(workspace_id,page_id,name,position,in_app) values(p_workspace_id,p.id,'Website',0,false) returning id into component;
        insert into public.component_monitors values(component,monitor_id,p_workspace_id);
      end if;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id',m.id,'type',m.type,'name',m.name) order by m.id),'[]') into made from public.monitors m where m.app_id = a.id and m.workspace_id = p_workspace_id;
    resource := a.id;
    result := jsonb_build_object('app', a.id, 'created', is_new, 'monitors', made, 'heartbeats', heartbeats, 'slug', p.slug,
      'skipped', coalesce(p_payload->'skipped','[]') || case when is_new then '[]'::jsonb else '[{"item":"configuration","reason":"This app already exists; its monitors were kept. Use create_monitor to add checks."}]'::jsonb end);
  when 'create_monitor' then
    resource := public.agent_create_monitor(p_workspace_id, p_payload->>'app', p_payload->'monitor', p_limits);
    result := jsonb_build_object('monitor', resource, 'first_check', p_payload->'first_check');
  when 'pause' then
    if coalesce((p_payload->>'minutes')::int,0) not between 1 and 1440 or ((p_payload->>'app' is null) = (p_payload->>'monitor' is null)) then raise exception 'pause_window_invalid' using errcode = '22023'; end if;
    if p_payload->>'app' is not null then
      perform 1 from public.apps where id = p_payload->>'app' and workspace_id = p_workspace_id;
      if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
    end if;
    paused := now() + make_interval(mins => (p_payload->>'minutes')::int);
    for monitor_id in select id from public.monitors where workspace_id = p_workspace_id and
      (id = p_payload->>'monitor' or app_id = p_payload->>'app') order by id loop
      perform public.pause_monitor(p_workspace_id, monitor_id, (p_payload->>'minutes')::int, 'Paused by an agent');
      ids := array_append(ids, monitor_id);
    end loop;
    if p_payload->>'monitor' is not null and cardinality(ids) = 0 then raise exception 'not_found' using errcode = 'PT404'; end if;
    resource := coalesce(p_payload->>'app',p_payload->>'monitor');
    result := jsonb_build_object('monitors', to_jsonb(ids), 'paused_until', paused);
  when 'draft_incident_update' then
    -- Fixed false and null: no input can publish, overwrite a note or impersonate a member.
    n := public.save_incident_note(p_workspace_id,p_payload->>'incident',null,p_payload->>'state',p_payload->>'text',false,null,left(p_client,60));
    resource := n.incident_id;
    result := jsonb_build_object('draft',n.id,'incident',n.incident_id,'published',false);
  end case;
  insert into public.agent_requests(workspace_id,actor,request_id,input_hash,tool,result) values(p_workspace_id,p_actor,p_request_id,p_input_hash,p_tool,result);
  insert into public.agent_activity(workspace_id,actor,client,tool,resource_id) values(p_workspace_id,p_actor,p_client,p_tool,resource);
  return result;
end;
$fn$;

-- Retain response envelopes when the 5-minute tier is purged. Stored percentiles cannot
-- be merged into exact request percentiles; each larger bucket explicitly reports maxima.
create table if not exists public.response_rollups (
  monitor_id text not null references public.monitors(id) on delete cascade,
  location text not null, resolution text not null check (resolution in ('1h','1d')),
  bucket timestamptz not null, p50_ms integer, p95_ms integer,
  primary key(monitor_id,location,resolution,bucket)
);
alter table public.response_rollups enable row level security;
revoke all on public.response_rollups from public,anon,authenticated;
grant select,insert,update,delete on public.response_rollups to service_role;
-- Probe flush RPCs already run as their owner, including their invoker triggers.
-- No new table grant to the function-only probe role is needed.
create or replace function public.response_rollups_add()
returns trigger language plpgsql security invoker set search_path = '' as $fn$
begin
  insert into public.response_rollups as r(monitor_id,location,resolution,bucket,p50_ms,p95_ms)
  select a.monitor_id,a.location,v.resolution,date_trunc(v.part,a.window_start,'UTC'),max(a.p50_ms),max(a.p95_ms)
    from response_added a cross join (values('1h','hour'),('1d','day')) v(resolution,part) group by 1,2,3,4
  on conflict(monitor_id,location,resolution,bucket) do update set p50_ms=greatest(r.p50_ms,excluded.p50_ms),p95_ms=greatest(r.p95_ms,excluded.p95_ms);
  return null;
end;
$fn$;
create or replace trigger agent_response_insert after insert on public.rollups_5m referencing new table as response_added for each statement execute function public.response_rollups_add();
create or replace trigger agent_response_update after update on public.rollups_5m referencing new table as response_added for each statement execute function public.response_rollups_add();
insert into public.response_rollups as r(monitor_id,location,resolution,bucket,p50_ms,p95_ms)
select a.monitor_id,a.location,v.resolution,date_trunc(v.part,a.window_start,'UTC'),max(a.p50_ms),max(a.p95_ms)
from public.rollups_5m a cross join (values('1h','hour'),('1d','day')) v(resolution,part) group by 1,2,3,4
on conflict(monitor_id,location,resolution,bucket) do update set p50_ms=greatest(r.p50_ms,excluded.p50_ms),p95_ms=greatest(r.p95_ms,excluded.p95_ms);

create or replace function public.agent_response_times(p_workspace_id text,p_monitor_id text,p_days int,p_location text,p_offset int,p_limit int)
returns jsonb language plpgsql stable security invoker set search_path = '' as $fn$
declare result jsonb;
begin
  if p_days is null or p_days not in (1,7,30,90,365) or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset not between 0 and 100000 then raise exception 'invalid_history' using errcode = '22023'; end if;
  perform 1 from public.monitors where id=p_monitor_id and workspace_id=p_workspace_id;
  if not found then raise exception 'not_found' using errcode='PT404'; end if;
  with points as (
    select window_start as at,location,p50_ms,p95_ms from public.rollups_5m where p_days=1 and monitor_id=p_monitor_id and window_start>=now()-interval '24 hours' and window_start<=now()
    union all
    select bucket,location,p50_ms,p95_ms from public.response_rollups where p_days>1 and monitor_id=p_monitor_id and resolution=case when p_days<=30 then '1h' else '1d' end and bucket>=now()-make_interval(days=>p_days) and bucket<=now()
  ), page as (select * from points where (p_location is null or location=p_location) order by at,location limit p_limit+1 offset p_offset)
  select coalesce(jsonb_agg(to_jsonb(page) order by at,location),'[]') into result from page;
  return result;
end;
$fn$;

create or replace function public.agent_history(p_workspace_id text,p_monitor_id text,p_days int,p_limit int,p_after text)
returns jsonb language plpgsql stable security invoker set search_path = '' set jit=off as $fn$
declare result jsonb;
begin
  if p_days is null or p_days not in (1,7,30,90,365) or p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_history' using errcode='22023'; end if;
  if p_monitor_id <> '*' and not exists(select 1 from public.monitors where id=p_monitor_id and workspace_id=p_workspace_id) then raise exception 'not_found' using errcode='PT404'; end if;
  with mon as materialized (
    select id,interval_sec,type from public.monitors where workspace_id=p_workspace_id and (p_monitor_id='*' or id=p_monitor_id) and (p_after is null or id>p_after) order by id limit p_limit+1
  ), days as materialized (
    select d.* from public.monitor_days((select coalesce(array_agg(id),'{}') from mon),case when p_days=1 then 2 else p_days end) d
  ), coverage as (
    select m.id,least(86400,coalesce((select (case when m.type='heartbeat' then sum(r.checks) else count(distinct r.window_start) end)*greatest(300,m.interval_sec) from public.rollups_5m r where r.monitor_id=m.id and r.window_start>=now()-interval '24 hours' and r.window_start<=now()),0))::numeric as seconds,
      coalesce((select sum(r.failures)::numeric/nullif(sum(r.checks),0) from public.rollups_5m r where r.monitor_id=m.id and r.window_start>=now()-interval '24 hours' and r.window_start<=now()),0) as failure_share from mon m
  ), totals as (
    select m.id,
      case when p_days=1 then c.seconds else coalesce((select sum(d.covered) from days d where d.monitor_id=m.id),0) end as covered,
      case when p_days=1 and m.type='heartbeat' then ceil(c.seconds*c.failure_share)
        when p_days=1 then coalesce((select sum(extract(epoch from least(coalesce(i.resolved_at,now()),now())-greatest(i.opened_at,now()-interval '24 hours'))) from public.incidents i where i.monitor_id=m.id and i.workspace_id=p_workspace_id and i.severity='down' and coalesce(i.resolved_at,now())>now()-interval '24 hours'),0)
        else coalesce((select sum(d.down) from days d where d.monitor_id=m.id),0) end as down
    from mon m join coverage c on c.id=m.id
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'uptime_pct',case when t.covered>0 then trunc(100*(t.covered-least(t.covered,t.down))/t.covered,3) else null end,
    'downtime_minutes',least(t.covered,t.down)/60,'covered_minutes',t.covered/60,
    'incident_count',(select count(*) from public.incidents i where i.monitor_id=t.id and i.workspace_id=p_workspace_id and i.opened_at>=now()-make_interval(days=>p_days)),
    'daily',(select coalesce(jsonb_agg(jsonb_build_object('day',d.day,'uptime_pct',d.up,'downtime_minutes',d.down/60.0,'covered_minutes',d.covered/60.0) order by d.day),'[]') from days d where d.monitor_id=t.id)) order by t.id),'[]') into result from totals t;
  return result;
end;
$fn$;

-- Steady passes don't update probe_outcome_at. A latest rollup gives a five-minute
-- interval, not a fabricated exact check time. Heartbeat judgements are timestamped.
create or replace function public.agent_check_times(p_workspace_id text)
returns jsonb language sql stable security invoker set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id,
    'at',case when w.at is not null and (exact.at is null or w.at+interval '5 minutes'>exact.at) then w.at else exact.at end,
    'precision',case when greatest(exact.at,w.at) is null then 'none'
      when w.at is not null and (exact.at is null or w.at+interval '5 minutes'>exact.at) then '5m_window_start' else 'exact' end)),'[]')
  from public.monitors m
  left join public.heartbeat_latest h on h.monitor_id=m.id
  cross join lateral (select greatest(m.probe_outcome_at,h.judged_at) as at) exact
  cross join lateral (select max(r.window_start) as at from public.rollups_5m r
    where r.monitor_id=m.id and r.window_start<=now()
      and (m.state is not null or r.window_start+interval '5 minutes'>m.updated_at)) w
  where m.workspace_id=p_workspace_id
$fn$;
revoke all on function public.agent_check_times(text) from public,anon,authenticated;
grant execute on function public.agent_check_times(text) to service_role;

create index if not exists agent_latest_note_idx on public.incident_notes(incident_id,published_at desc,id) where status='published';
create or replace function public.agent_published_notes(p_workspace_id text,p_incident_ids text[])
returns jsonb language sql stable security invoker set search_path = '' as $fn$
  select coalesce(jsonb_agg(to_jsonb(n)),'[]') from (
    select distinct on (incident_id) id,incident_id,state,body,published_at from public.incident_notes
    where workspace_id=p_workspace_id and incident_id=any(p_incident_ids) and status='published'
    order by incident_id,published_at desc,id
  ) n
$fn$;
revoke all on function public.agent_published_notes(text,text[]) from public,anon,authenticated;
grant execute on function public.agent_published_notes(text,text[]) to service_role;

revoke all on function public.agent_budget(text,integer), public.agent_create_monitor(text,text,jsonb,jsonb), public.agent_write(text,text,text,text,text,uuid,text,jsonb,jsonb), public.response_rollups_add(), public.agent_response_times(text,text,integer,text,integer,integer), public.agent_history(text,text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.agent_budget(text,integer), public.agent_create_monitor(text,text,jsonb,jsonb), public.agent_write(text,text,text,text,text,uuid,text,jsonb,jsonb), public.response_rollups_add(), public.agent_response_times(text,text,integer,text,integer,integer), public.agent_history(text,text,integer,integer,text) to service_role;
commit;
