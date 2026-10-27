-- 017: additive probe API. Keep every old grant until BOTH probes use this API (018).
-- The reducer remains probe/state.ts. These bounded functions run as their migration owner:
-- probe has no table privileges after 018, and RLS continues to have zero policies.
-- Explicit ACLs remove service_role's creator-default EXECUTE on these probe-only APIs.
begin;

-- May upsert only a live-set entry, so probes can register and refresh their presence.
create or replace function public.probe_heartbeat(p_id text, p_location text, p_builder_only boolean, p_url text)
returns void language sql security definer set search_path = '' as $fn$
  insert into public.probes (id, location, builder_only, url, last_seen)
  values (p_id, p_location, p_builder_only, p_url, pg_catalog.now())
  on conflict (id) do update set location = excluded.location,
    builder_only = excluded.builder_only, url = excluded.url, last_seen = pg_catalog.now();
$fn$;

-- May delete only a live-set entry, so a departing probe stops receiving work immediately.
create or replace function public.probe_leave(p_id text)
returns void language sql security definer set search_path = '' as $fn$
  delete from public.probes where id = p_id;
$fn$;

-- Read only: the two-minute live set is the existing rendezvous shard map.
create or replace function public.probe_live()
returns table (id text, location text, builder_only boolean, url text)
language sql stable security definer set search_path = '' as $fn$
  select p.id, p.location, p.builder_only, p.url from public.probes p
  where p.last_seen > pg_catalog.now() - interval '120 seconds' order by p.id;
$fn$;

-- Read only: check configuration and sealed headers for served workspaces. The optional
-- workspace filter is operational, not tenant authorization: all probes rotate over the fleet.
-- No heartbeat tokens, incident notes, workspace records or unsealed credentials are returned.
create or replace function public.probe_load_monitors(p_workspaces text[])
returns table (id text, workspace_id text, name text, type text, target text, interval_sec integer,
               config jsonb, version text, paused boolean, unchecked boolean, secrets jsonb)
language sql stable security definer set search_path = '' as $fn$
  select m.id, m.workspace_id, m.name, m.type, m.target, m.interval_sec, m.config,
         (extract(epoch from m.updated_at) * 1000000)::bigint::text,
         (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())),
         (m.probe_outcome_at is null),
         coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', s.name, 'sealed', s.sealed))
                   from public.monitor_secrets s where s.monitor_id = m.id), '[]'::jsonb)
  from public.monitors m where m.type in ('http', 'tcp', 'ssl', 'dns')
    and (p_workspaces is null or m.workspace_id = any(p_workspaces));
$fn$;

-- May lock one checked monitor, changing no data, so TypeScript steps the current row in the
-- caller's transaction. The lock lasts through probe_commit_monitor and COMMIT/ROLLBACK.
create or replace function public.probe_lock_monitor(p_id text)
returns table (id text, workspace_id text, name text, type text, target text, config jsonb, state text,
               paused boolean, version text, since double precision, probe_slow_streak integer,
               probe_pass_streak integer, probe_fail_streak integer, outcome_at double precision,
               probe_outcome_locations text[])
language sql volatile security definer set search_path = '' as $fn$
  select m.id, m.workspace_id, m.name, m.type, m.target, m.config, m.state,
         (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())),
         (extract(epoch from m.updated_at) * 1000000)::bigint::text,
         extract(epoch from m.state_since)::float8,
         m.probe_slow_streak, m.probe_pass_streak, m.probe_fail_streak,
         extract(epoch from m.probe_outcome_at)::float8, m.probe_outcome_locations
  from public.monitors m where m.id = p_id and m.type in ('http', 'tcp', 'ssl', 'dns') for update;
$fn$;

-- May write only this monitor's reducer state, transition, incident open/close, and failures
-- (pruned to 20). No configuration/version, secret, note, acknowledgement or unrelated row.
-- Trust the TypeScript reducer, but fence the version even for a caller skipping the lock API.
-- Pause is stored separately; null is legitimate before the first judged state (e.g. DNS's
-- first failure). Neither permits a probe to clear an established state or change a pause.
create or replace function public.probe_commit_monitor(
  p_id text, p_version text, p_at timestamptz, p_state text,
  p_slow integer, p_pass integer, p_fail integer, p_locations text[], p_effects jsonb
)
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  m public.monitors%rowtype;
  e jsonb;
begin
  select * into m from public.monitors where id = p_id for update;
  if not found then raise exception 'probe_monitor_missing' using errcode = '22023'; end if;
  if p_version is distinct from (extract(epoch from m.updated_at) * 1000000)::bigint::text then
    raise exception 'probe_monitor_moved' using errcode = '22023';
  end if;
  if m.type not in ('http', 'tcp', 'ssl', 'dns') or
     (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())) then
    raise exception 'probe_monitor_not_checkable' using errcode = '22023';
  end if;
  if (p_state is not null and p_state not in ('up', 'degraded', 'down')) or
     (p_state is null and m.state is not null) then
    raise exception 'probe_state_invalid' using errcode = '22023';
  end if;
  if p_effects is null or pg_catalog.jsonb_typeof(p_effects) <> 'array' or
     pg_catalog.jsonb_array_length(p_effects) > 4 then
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
        -- The reducer opens an incident only when the locked row wasn't down, so an incident
        -- still open here describes something else: a seeded or hand-made one, never this
        -- outage. It is closed, as an address edit closes one (migration 010), and this outage
        -- gets its own row with its own severity, evidence and timeline, which uptime and the
        -- incident screen read (reviews 34 and 35: refusing rolled every confirmed failure back;
        -- keeping folded the outage into the old row). Opening time is capped at the database
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
      else raise exception 'probe_effect_invalid' using errcode = '22023';
    end case;
  end loop;
end;
$fn$;

-- May merge one batch of closed windows into rollups_5m; 014's statement triggers maintain
-- rollups_1d as the same owner. No temporary relation supplied by an untrusted caller is read.
-- A monitor deleted during a window has nothing to attach it to, so exclude just that case.
create or replace function public.probe_flush_rollups(
  p_monitors text[], p_locations text[], p_windows timestamptz[], p_checks integer[],
  p_failures integer[], p_p50 integer[], p_p95 integer[], p_max integer[]
)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  if p_monitors is null or p_locations is null or p_windows is null or p_checks is null or
     p_failures is null or p_p50 is null or p_p95 is null or p_max is null or
     pg_catalog.cardinality(p_monitors) <> pg_catalog.cardinality(p_locations) or
     pg_catalog.cardinality(p_monitors) <> pg_catalog.cardinality(p_windows) or
     pg_catalog.cardinality(p_monitors) <> pg_catalog.cardinality(p_checks) or
     pg_catalog.cardinality(p_monitors) <> pg_catalog.cardinality(p_failures) or
     pg_catalog.cardinality(p_monitors) <> pg_catalog.cardinality(p_p50) or
     pg_catalog.cardinality(p_monitors) <> pg_catalog.cardinality(p_p95) or
     pg_catalog.cardinality(p_monitors) <> pg_catalog.cardinality(p_max) then
    raise exception 'probe_rollup_arrays_invalid' using errcode = '22023';
  end if;
  insert into public.rollups_5m as r (monitor_id, location, window_start, checks, failures, p50_ms, p95_ms, max_ms)
  select i.* from rows from (pg_catalog.unnest(p_monitors), pg_catalog.unnest(p_locations),
    pg_catalog.unnest(p_windows), pg_catalog.unnest(p_checks), pg_catalog.unnest(p_failures),
    pg_catalog.unnest(p_p50), pg_catalog.unnest(p_p95), pg_catalog.unnest(p_max))
    as i(monitor_id, location, window_start, checks, failures, p50_ms, p95_ms, max_ms)
  where exists (select 1 from public.monitors m where m.id = i.monitor_id)
  on conflict (monitor_id, location, window_start) do update set
    checks = r.checks + excluded.checks,
    failures = r.failures + excluded.failures,
    p50_ms = case when r.p50_ms is null then excluded.p50_ms when excluded.p50_ms is null then r.p50_ms
             else pg_catalog.round((r.p50_ms::numeric * (r.checks - r.failures) + excluded.p50_ms::numeric * (excluded.checks - excluded.failures))
                    / ((r.checks - r.failures) + (excluded.checks - excluded.failures)))::int end,
    p95_ms = greatest(r.p95_ms, excluded.p95_ms), max_ms = greatest(r.max_ms, excluded.max_ms);
end;
$fn$;

revoke all on function public.probe_heartbeat(text, text, boolean, text), public.probe_leave(text),
  public.probe_live(), public.probe_load_monitors(text[]), public.probe_lock_monitor(text),
  public.probe_commit_monitor(text, text, timestamptz, text, integer, integer, integer, text[], jsonb),
  public.probe_flush_rollups(text[], text[], timestamptz[], integer[], integer[], integer[], integer[], integer[])
  from public, anon, authenticated, service_role;
grant usage on schema public to probe;
grant execute on function public.probe_heartbeat(text, text, boolean, text), public.probe_leave(text),
  public.probe_live(), public.probe_load_monitors(text[]), public.probe_lock_monitor(text),
  public.probe_commit_monitor(text, text, timestamptz, text, integer, integer, integer, text[], jsonb),
  public.probe_flush_rollups(text[], text[], timestamptz[], integer[], integer[], integer[], integer[], integer[])
  to probe;
commit;