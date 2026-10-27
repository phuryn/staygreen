-- 026 · Stripe and Supabase monitors. Additive rollout: old dashboard signatures and
-- probe_load_monitors stay unchanged; old probes never receive an unfamiliar type.
begin;

alter table public.monitors add column if not exists service_runtime jsonb not null default '{}'::jsonb;

-- New entry point, so deployed callers retain exactly their old contract. Counts and
-- per-host quotas use the same workspace lock as create_monitor. No quota defaults.
create or replace function public.save_service_monitor(
  p_workspace_id text, p_id text, p_app_id text, p_type text, p_name text, p_target text,
  p_config jsonb, p_sealed text, p_edit boolean, p_max_monitors integer, p_max_type integer,
  p_per_host integer, p_interval_sec integer
) returns text language plpgsql security invoker set search_path = '' as $fn$
declare
  old public.monitors;
  host text;
begin
  if p_max_monitors is null or p_max_type is null or p_per_host is null or p_interval_sec is null
    or p_max_monitors < 1 or p_max_type < 1 or p_per_host < 1 then
    raise exception 'limits_required' using errcode = '22004';
  end if;
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  if p_type is null or p_type not in ('stripe', 'supabase') or p_edit is null then
    raise exception 'type_not_available';
  end if;
  perform 1 from public.apps where id = p_app_id and workspace_id = p_workspace_id;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  if p_edit then
    select * into old from public.monitors where id = p_id and workspace_id = p_workspace_id for update;
    if not found or old.type <> p_type or old.app_id <> p_app_id then raise exception 'not_found' using errcode = 'PT404'; end if;
  else
    if (select count(*) from public.monitors where workspace_id = p_workspace_id and not auto) >= p_max_monitors then raise exception 'monitor_limit'; end if;
    if (select count(*) from public.monitors where workspace_id = p_workspace_id and type = p_type) >= p_max_type then raise exception 'service_monitor_limit'; end if;
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then raise exception 'service_config_invalid'; end if;
  if p_config is null or jsonb_typeof(p_config) <> 'object' or p_sealed is null
    or p_sealed !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then raise exception 'service_config_invalid'; end if;
  if p_type = 'supabase' then
    if p_target is null or p_target !~ '^https://[a-z0-9]{20}\.supabase\.co$'
      or p_config->>'projectUrl' is distinct from p_target
      or jsonb_typeof(p_config->'databaseRead') is distinct from 'string'
      or (p_config->>'databaseRead' <> '' and p_config->>'databaseRead' !~ '^(rpc/)?[a-z_][a-z0-9_]{0,62}$')
      or p_config - array['projectUrl', 'databaseRead'] <> '{}'::jsonb then raise exception 'service_config_invalid'; end if;
    host := substring(p_target from 9);
    if p_interval_sec not in (60, 180) then raise exception 'interval_not_allowed'; end if;
    if (not p_edit or host is distinct from old.target_host) and
      (select count(*) from public.monitors where workspace_id = p_workspace_id and target_host = host and type <> 'ssl' and id <> p_id) >= p_per_host then raise exception 'host_limit'; end if;
  else
    if p_target is distinct from 'https://api.stripe.com'
      or p_config - array['endpoints', 'critical', 'failureThreshold', 'windowMin', 'pendingMin'] <> '{}'::jsonb
      or jsonb_typeof(p_config->'endpoints') is distinct from 'array'
      or jsonb_typeof(p_config->'critical') is distinct from 'array' then raise exception 'service_config_invalid'; end if;
    if jsonb_array_length(p_config->'endpoints') not between 1 and 20 or jsonb_array_length(p_config->'critical') > 20
      or exists(select 1 from jsonb_array_elements_text(p_config->'endpoints') x where x is null or x !~ '^we_[A-Za-z0-9]{1,100}$')
      or exists(select 1 from jsonb_array_elements_text(p_config->'critical') x where x is null or char_length(x) > 150 or x !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?$')
      or coalesce((p_config->>'failureThreshold')::int, 0) not between 1 and 100
      or coalesce((p_config->>'windowMin')::int, 0) not between 1 and 1440
      or coalesce((p_config->>'pendingMin')::int, 0) not between 1 and 1440 then raise exception 'service_config_invalid'; end if;
    if p_interval_sec not in (300, 600) then raise exception 'interval_not_allowed'; end if;
  end if;
  if p_edit then
    update public.monitors set name = btrim(p_name), target = p_target, target_host = host,
      interval_sec = p_interval_sec, config = p_config, service_runtime = '{}', state = null, state_since = null, updated_at = clock_timestamp()
      where id = p_id and workspace_id = p_workspace_id;
    update public.incidents set resolved_at = greatest(now(), opened_at), timeline = timeline || jsonb_build_array(jsonb_build_object('t', now(), 'text', 'Monitor edited and verified, incident closed'))
      where monitor_id = p_id and workspace_id = p_workspace_id and resolved_at is null;
  else
    insert into public.monitors(id, workspace_id, app_id, type, name, target, target_host, interval_sec, config)
      values(p_id, p_workspace_id, p_app_id, p_type, btrim(p_name), p_target, host, p_interval_sec, p_config);
  end if;
  insert into public.monitor_secrets(monitor_id, workspace_id, name, sealed) values(p_id, p_workspace_id, 'service-key', p_sealed)
    on conflict (monitor_id, name) do update set sealed = excluded.sealed;
  return p_id;
end;
$fn$;
revoke all on function public.save_service_monitor(text,text,text,text,text,text,jsonb,text,boolean,integer,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.save_service_monitor(text,text,text,text,text,text,jsonb,text,boolean,integer,integer,integer,integer) to service_role;

-- Runtime holds Stripe's recovery cursor and Supabase's display label, never a refusal latch.
-- Existing lock/commit signatures and behaviour for old types remain compatible.
create or replace function public.probe_load_service_monitors(p_workspaces text[])
returns table (id text, workspace_id text, name text, type text, target text, interval_sec integer,
               config jsonb, version text, paused boolean, unchecked boolean, secrets jsonb)
language sql stable security definer set search_path = '' as $fn$
  select m.id, m.workspace_id, m.name, m.type, m.target, m.interval_sec,
         m.config || jsonb_build_object('__state', m.state, '__runtime', m.service_runtime - 'version')
         || case when m.type = 'supabase' then jsonb_build_object(
           '__failureStatus', (select f.status from public.check_failures f
             where f.monitor_id = m.id and f.at >= m.state_since order by f.at desc, f.id desc limit 1),
           '__incidentStatus', (select i.evidence->'status' from public.incidents i
             where i.monitor_id = m.id and i.resolved_at is null),
           -- A conservative restart bound from the existing counted outcome. Passes have
           -- no failure row; a later peer outcome can replace their location, but not time.
           '__outcomeAt', extract(epoch from m.probe_outcome_at)::float8
         ) else '{}'::jsonb end,
         (extract(epoch from m.updated_at) * 1000000)::bigint::text,
         (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())),
         (m.probe_outcome_at is null),
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', s.name, 'sealed', s.sealed))
                   from public.monitor_secrets s where s.monitor_id = m.id), '[]'::jsonb)
  from public.monitors m where m.type in ('stripe', 'supabase')
    and (p_workspaces is null or m.workspace_id = any(p_workspaces));
$fn$;

create or replace function public.probe_lock_monitor(p_id text)
returns table (id text, workspace_id text, name text, type text, target text, config jsonb, state text,
               paused boolean, version text, since double precision, probe_slow_streak integer,
               probe_pass_streak integer, probe_fail_streak integer, outcome_at double precision,
               probe_outcome_locations text[], target_host text, cert_host text,
               cert_expires_at double precision, cert_issuer text)
language sql volatile security definer set search_path = '' as $fn$
  select m.id, m.workspace_id, m.name, m.type, m.target, m.config || case when m.type in ('stripe','supabase') then jsonb_build_object('__state', m.state, '__runtime', m.service_runtime - 'version') else '{}'::jsonb end, m.state,
         (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())),
         (extract(epoch from m.updated_at) * 1000000)::bigint::text,
         extract(epoch from m.state_since)::float8,
         m.probe_slow_streak, m.probe_pass_streak, m.probe_fail_streak,
         extract(epoch from m.probe_outcome_at)::float8, m.probe_outcome_locations,
         m.target_host, m.cert_host, extract(epoch from m.cert_expires_at)::float8, m.cert_issuer
  from public.monitors m where m.id = p_id and m.type in ('http', 'tcp', 'ssl', 'dns', 'stripe', 'supabase') for update;
$fn$;

create or replace function public.probe_commit_monitor(
  p_id text, p_version text, p_at timestamptz, p_state text,
  p_slow integer, p_pass integer, p_fail integer, p_locations text[], p_effects jsonb
)
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  m public.monitors%rowtype;
  e jsonb;
  v_expires timestamptz;
begin
  select * into m from public.monitors where id = p_id for update;
  if not found then raise exception 'probe_monitor_missing' using errcode = '22023'; end if;
  if p_version is distinct from (extract(epoch from m.updated_at) * 1000000)::bigint::text then
    raise exception 'probe_monitor_moved' using errcode = '22023';
  end if;
  if m.type not in ('http', 'tcp', 'ssl', 'dns', 'stripe', 'supabase') or
     (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())) then
    raise exception 'probe_monitor_not_checkable' using errcode = '22023';
  end if;
  if (p_state is not null and p_state not in ('up', 'degraded', 'down')) or
     (p_state is null and m.state is not null) then
    raise exception 'probe_state_invalid' using errcode = '22023';
  end if;
  if p_effects is null or pg_catalog.jsonb_typeof(p_effects) <> 'array' or
     pg_catalog.jsonb_array_length(p_effects) > 6 then
    raise exception 'probe_effects_invalid' using errcode = '22023';
  end if;

  update public.monitors set state = p_state,
    state_since = case when state is distinct from p_state then p_at else state_since end,
    probe_slow_streak = p_slow, probe_pass_streak = p_pass, probe_fail_streak = p_fail,
    probe_outcome_at = p_at, probe_outcome_locations = p_locations where id = p_id;

  for e in select value from pg_catalog.jsonb_array_elements(p_effects) loop
    case e->>'kind'
      when 'transition' then
        if (e->>'from') is distinct from m.state or (e->>'to') is distinct from p_state or p_state is null then
          raise exception 'probe_transition_invalid' using errcode = '22023';
        end if;
        insert into public.transitions (monitor_id, from_state, to_state, at)
        values (p_id, e->>'from', e->>'to', p_at);
        if e->>'from' = 'down' then
          update public.incidents set resolved_at = greatest(p_at, opened_at),
            timeline = timeline || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              't', e->>'at', 'text', 'Two checks passed, incident closed'))
          where monitor_id = p_id and resolved_at is null;
        end if;
      when 'open_incident' then
        if p_state is distinct from 'down' then
          raise exception 'probe_incident_invalid' using errcode = '22023';
        end if;
        -- As 017 (reviews 34 and 35): an incident still open here describes something else, so it
        -- is closed and this outage gets its own row. Opening time is capped at the database
        -- clock (skew protection).
        update public.incidents set resolved_at = greatest(least(p_at, pg_catalog.now()), opened_at),
          timeline = timeline || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            't', pg_catalog.now(), 'text', 'A new outage opened its own incident, this one closed'))
        where monitor_id = p_id and resolved_at is null;
        insert into public.incidents (workspace_id, monitor_id, title, severity, opened_at, evidence, timeline)
        values (m.workspace_id, p_id, pg_catalog.left(m.name || ' is down', 200), 'down',
                least(p_at, pg_catalog.now()), e->'evidence', e->'timeline');
      when 'record_failure' then
        insert into public.check_failures (monitor_id, location, at, kind, message, status, ms, snippet, detail)
        values (p_id, e->>'location', p_at, e->>'failureKind', e->>'message',
                (e->>'status')::integer, (e->>'ms')::integer, e->>'snippet', nullif(e->'detail', 'null'::jsonb));
        delete from public.check_failures where monitor_id = p_id and id not in
          (select id from public.check_failures where monitor_id = p_id order by at desc, id desc limit 20);
      when 'cert' then
        -- An SSL monitor's alone, with an expiry a certificate can carry (above); otherwise
        -- skipped, never the outcome's failure.
        begin
          v_expires := (e->>'expiresAt')::timestamptz;
        exception when others then
          v_expires := null;
        end;
        if m.type = 'ssl' and m.target_host is not null and v_expires is not null and
           v_expires >= timestamptz '1950-01-01 00:00:00+00' and v_expires < timestamptz '10000-01-01 00:00:00+00' then
          update public.monitors set cert_host = m.target_host, cert_expires_at = v_expires,
            cert_issuer = case when pg_catalog.jsonb_typeof(e->'issuer') = 'string'
                               then pg_catalog.left(nullif(pg_catalog.btrim(e->>'issuer'), ''), 200) end
          where id = p_id;
        end if;
      when 'service_runtime' then
        if m.type not in ('stripe','supabase') or jsonb_typeof(e->'runtime') is distinct from 'object'
          or octet_length((e->'runtime')::text) > 250000
          or (e->'runtime') - array['seen','pausedOrDeleted'] <> '{}'::jsonb then
          raise exception 'probe_service_runtime_invalid' using errcode = '22023';
        end if;
        update public.monitors set service_runtime = (e->'runtime') || jsonb_build_object('version', p_version) where id = p_id;
      else raise exception 'probe_effect_invalid' using errcode = '22023';
    end case;
  end loop;
end;
$fn$;

revoke all on function public.probe_load_service_monitors(text[]) from public, anon, authenticated, service_role;
grant execute on function public.probe_load_service_monitors(text[]) to probe;
-- CREATE OR REPLACE retains the existing lock/commit ACLs.
create or replace trigger monitors_forget_open_windows
after update of updated_at on public.monitors
for each row when (new.type in ('http','tcp','ssl','dns','stripe','supabase') and old.updated_at is distinct from new.updated_at)
execute function public.forget_open_windows_on_edit();

-- Add only the safe service label to 024's snapshot; internal cursors never leave the server.
create or replace function public.workspace_snapshot(p_workspace_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
set jit = off
as $fn$
  select jsonb_build_object(
    'apps', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at, a.id)
        from public.apps a where a.workspace_id = p_workspace_id), '[]'::jsonb),
    'monitors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'workspace_id', m.workspace_id, 'app_id', m.app_id, 'type', m.type,
               'name', m.name, 'target', m.target, 'target_host', m.target_host,
               'interval_sec', m.interval_sec, 'config', m.config, 'auto', m.auto,
               'state', m.state, 'state_since', m.state_since, 'paused_at', m.paused_at,
               'paused_until', m.paused_until, 'pause_reason', m.pause_reason,
               'created_at', m.created_at, 'updated_at', m.updated_at,
               'service_status', case when m.type = 'supabase' and m.service_runtime->>'pausedOrDeleted' = 'true' then 'paused_or_deleted' end,
               'cert_host', m.cert_host, 'cert_expires_at', m.cert_expires_at, 'cert_issuer', m.cert_issuer)
             order by m.created_at, m.id)
        from public.monitors m where m.workspace_id = p_workspace_id), '[]'::jsonb),
    'monitor_secrets', coalesce((
      select jsonb_agg(jsonb_build_object('monitor_id', s.monitor_id, 'name', s.name) order by s.name, s.monitor_id)
        from public.monitor_secrets s where s.workspace_id = p_workspace_id), '[]'::jsonb),
    'incidents', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.opened_at desc, i.id)
        from public.incidents i where i.workspace_id = p_workspace_id), '[]'::jsonb),
    'incident_notes', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at, n.id)
        from public.incident_notes n where n.workspace_id = p_workspace_id), '[]'::jsonb),
    'status_pages', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.created_at, p.id)
        from public.status_pages p where p.workspace_id = p_workspace_id), '[]'::jsonb),
    'page_components', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.position, c.id)
        from public.page_components c where c.workspace_id = p_workspace_id), '[]'::jsonb),
    'component_monitors', coalesce((
      select jsonb_agg(jsonb_build_object('component_id', b.component_id, 'monitor_id', b.monitor_id) order by b.component_id, b.monitor_id)
        from public.component_monitors b where b.workspace_id = p_workspace_id), '[]'::jsonb),
    'page_assets', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'page_id', x.page_id, 'kind', x.kind) order by x.id)
        from public.page_assets x where x.workspace_id = p_workspace_id), '[]'::jsonb),
    'app_logos', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'app_id', l.app_id) order by l.id)
        from public.app_logos l where l.workspace_id = p_workspace_id), '[]'::jsonb),
    'heartbeat_latest', coalesce((
      select jsonb_agg(jsonb_build_object('monitor_id', h.monitor_id, 'ping_at', h.ping_at, 'ping_payload', h.ping_payload,
                                          'start_at', h.start_at, 'fail_at', h.fail_at, 'judged_at', h.judged_at,
                                          'run_at', h.run_at) order by h.monitor_id)
        from public.heartbeat_latest h where h.workspace_id = p_workspace_id), '[]'::jsonb),
    'domains', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.host)
        from public.workspace_domains(p_workspace_id) d), '[]'::jsonb),
    'alert_channels', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'audience', c.audience, 'address', c.address,
                                          'label', c.label, 'confirmed_at', c.confirmed_at) order by c.created_at, c.id)
        from public.alert_channels c where c.workspace_id = p_workspace_id), '[]'::jsonb),
    'alert_deliveries', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'event', d.event, 'incident_id', d.incident_id, 'channel_id', d.channel_id,
                                          'status', d.status, 'created_at', d.created_at, 'sent_at', d.sent_at)
                       order by d.created_at desc, d.id)
        from (select * from public.alert_deliveries x
               where x.workspace_id = p_workspace_id and x.incident_id is not null and x.status in ('sent', 'failed')
               order by x.created_at desc, x.id limit 500) d), '[]'::jsonb),
    'history', public.workspace_history(p_workspace_id)
  )
$fn$;

revoke all on function public.workspace_snapshot(text) from public, anon, authenticated;
grant execute on function public.workspace_snapshot(text) to service_role;

commit;
