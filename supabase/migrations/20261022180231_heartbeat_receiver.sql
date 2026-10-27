-- 019: the heartbeat receiver (stage 2.2 Part B, `docs/work/2.2-probes-real.md`).
--
-- A builder's job calls its ping URL; the Cloudflare Worker in `ingest/` hashes the token and
-- calls `record_heartbeat` as the `ingest` role, which may do nothing else. The Worker records
-- and never judges. The monitor's home probe reads what arrived, judges it on its timer wheel
-- and steps the monitor's row through the same reducer as every other outcome
-- (`probe/heartbeat.ts`, `probe/store.ts`), so a monitor's state is still moved from one place.
--
-- No row per ping (`AGENTS.md § 2.8`): `heartbeat_latest` keeps one row per heartbeat with the
-- newest good ping, `/start` and `/fail`, each with its time and its masked, capped payload (the
-- Worker masks with `src/checks/mask.ts` and caps at 1,024 bytes; the 4,096 here is the
-- database's own bound). A `/fail` and a good ping live in separate columns, so a good ping
-- after a `/fail` never overwrites it before the home has judged it. The home's cursor (what it
-- has judged, and the last scheduled run it accounted for) is in the same row, written only by
-- the probe; it records the past, never a deadline: the schedule stays in probe memory.
--
-- Times are whole milliseconds and strictly increase per heartbeat in commit order, whichever
-- kind arrives, so the home orders what it reads without ties, and a ping committed after the
-- home's read always sorts after what that read judged.
--
-- Uptime for a heartbeat is the share of its expected runs that arrived on time and passed: the
-- home counts each run once into its 5-minute windows (`checks`, `failures`), and the readers
-- below turn that share into the covered and down seconds the screens already read
-- (`docs/architecture.md § What the probes measured`).
--
-- `§ 1.4` as everywhere: RLS on with zero policies, nothing for PUBLIC, `anon` or
-- `authenticated`. The four new functions are `security definer` with an empty search path,
-- like Part A's (017), because their roles hold no table grants to invoke with.
--
-- Idempotent, and never edited after it is applied.

begin;

create table if not exists public.heartbeat_latest (
  monitor_id      text primary key,
  workspace_id    text not null,
  ping_at         timestamptz,
  ping_payload    jsonb,
  ping_note       text,
  start_at        timestamptz,
  start_payload   jsonb,
  start_note      text,
  fail_at         timestamptz,
  fail_payload    jsonb,
  fail_note       text,
  -- Good pings and `/fail`s recorded, ever. Beside `judged_finishes` it tells the home that a
  -- finish was overwritten before it judged it (no probe live, or a home changing).
  finishes        bigint not null default 0 check (finishes >= 0),
  -- The per-monitor bound, per kind: at most 10 recorded of each kind in a clock minute, so a
  -- burst of pings never crowds out the `/fail` or the recovery that follows it.
  rate_minute     timestamptz not null,
  rate_ping       integer not null default 0 check (rate_ping between 0 and 10),
  rate_start      integer not null default 0 check (rate_start between 0 and 10),
  rate_fail       integer not null default 0 check (rate_fail between 0 and 10),
  -- The home's cursor, written by `probe_commit_heartbeat` alone: the newest event judged, the
  -- finishes that covered, and the last scheduled run accounted for (a scheduled time).
  judged_at       timestamptz,
  judged_finishes bigint not null default 0,
  run_at          timestamptz,
  constraint heartbeat_latest_monitor_fkey foreign key (monitor_id, workspace_id)
    references public.monitors (id, workspace_id) on delete cascade,
  constraint heartbeat_latest_judged_finishes check (judged_finishes between 0 and finishes),
  constraint heartbeat_latest_kinds check (
    (ping_at is null or ping_payload is not null) and (start_at is null or start_payload is not null) and
    (fail_at is null or fail_payload is not null)),
  constraint heartbeat_latest_payloads check (
    (ping_payload is null or (jsonb_typeof(ping_payload) = 'object' and octet_length(ping_payload::text) <= 4096)) and
    (start_payload is null or (jsonb_typeof(start_payload) = 'object' and octet_length(start_payload::text) <= 4096)) and
    (fail_payload is null or (jsonb_typeof(fail_payload) = 'object' and octet_length(fail_payload::text) <= 4096))),
  constraint heartbeat_latest_notes check (
    (ping_note is null or ping_note in ('not_json', 'too_large', 'truncated')) and
    (start_note is null or start_note in ('not_json', 'too_large', 'truncated')) and
    (fail_note is null or fail_note in ('not_json', 'too_large', 'truncated')))
);

create index if not exists heartbeat_latest_workspace_idx on public.heartbeat_latest (workspace_id);

alter table public.heartbeat_latest enable row level security;
revoke all on public.heartbeat_latest from public, anon, authenticated;
grant select, insert, update, delete on public.heartbeat_latest to service_role;

-- ── the ingest role ─────────────────────────────────────────────────────────
-- A group role like `probe` (013). Its login is created by hand per environment, with a
-- generated password and membership in `ingest` only (`docs/environments.md`, Heartbeat ingest).

do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'ingest') then
    create role ingest nologin;
  end if;
end
$do$;

-- May record one ping for the heartbeat whose token hashes to `p_token_hash`, and nothing else:
-- no read of any monitor, workspace or payload for the caller, and no write beyond that
-- heartbeat's newest ping of the kind given and its rate window. Answers 'recorded', 'limited'
-- (known, that kind over its rate: acknowledged and not recorded) or 'unknown' (no heartbeat has
-- that hash). The rate is per kind, so pings in a loop never stop a `/fail` being recorded. A
-- paused heartbeat still records: the probe fences pings from before a resume by the monitor's
-- version. Over the rate it only reads, so a job in a tight loop costs one indexed lookup per
-- call and writes nothing; the Worker refuses a forged token before it gets here.
create or replace function public.record_heartbeat(p_token_hash text, p_kind text, p_payload jsonb, p_note text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  v_id     text;
  v_ws     text;
  v_minute timestamptz := pg_catalog.date_trunc('minute', pg_catalog.now());
  v_rate_m timestamptz;
  v_rate_n integer;
  v_done   boolean;
begin
  if p_kind is null or p_kind not in ('ping', 'start', 'fail') then
    raise exception 'heartbeat_kind_invalid' using errcode = '22023';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' or pg_catalog.octet_length(p_payload::text) > 4096 then
    raise exception 'heartbeat_payload_invalid' using errcode = '22023';
  end if;
  if p_note is not null and p_note not in ('not_json', 'too_large', 'truncated') then
    raise exception 'heartbeat_note_invalid' using errcode = '22023';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return 'unknown';
  end if;

  select m.id, m.workspace_id into v_id, v_ws from public.monitors m where m.heartbeat_token_hash = p_token_hash;
  if not found then
    return 'unknown';
  end if;

  select h.rate_minute, case p_kind when 'ping' then h.rate_ping when 'start' then h.rate_start else h.rate_fail end
    into v_rate_m, v_rate_n from public.heartbeat_latest h where h.monitor_id = v_id;
  if found and v_rate_m = v_minute and v_rate_n >= 10 then
    return 'limited';
  end if;

  -- The time is taken once the row is locked, and is at least a millisecond after anything the
  -- row holds, so times increase in commit order across all three kinds.
  insert into public.heartbeat_latest as h (monitor_id, workspace_id, ping_at, ping_payload, ping_note,
                                            start_at, start_payload, start_note, fail_at, fail_payload, fail_note,
                                            finishes, rate_minute, rate_ping, rate_start, rate_fail)
  values (v_id, v_ws,
          case when p_kind = 'ping' then pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()) end,
          case when p_kind = 'ping' then p_payload end, case when p_kind = 'ping' then p_note end,
          case when p_kind = 'start' then pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()) end,
          case when p_kind = 'start' then p_payload end, case when p_kind = 'start' then p_note end,
          case when p_kind = 'fail' then pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()) end,
          case when p_kind = 'fail' then p_payload end, case when p_kind = 'fail' then p_note end,
          case when p_kind = 'start' then 0 else 1 end, v_minute,
          case when p_kind = 'ping' then 1 else 0 end, case when p_kind = 'start' then 1 else 0 end,
          case when p_kind = 'fail' then 1 else 0 end)
  on conflict (monitor_id) do update set
    ping_at = case when p_kind = 'ping' then greatest(pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()),
                                                                 greatest(h.ping_at, h.start_at, h.fail_at) + interval '1 millisecond')
                   else h.ping_at end,
    ping_payload = case when p_kind = 'ping' then p_payload else h.ping_payload end,
    ping_note = case when p_kind = 'ping' then p_note else h.ping_note end,
    start_at = case when p_kind = 'start' then greatest(pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()),
                                                                   greatest(h.ping_at, h.start_at, h.fail_at) + interval '1 millisecond')
                    else h.start_at end,
    start_payload = case when p_kind = 'start' then p_payload else h.start_payload end,
    start_note = case when p_kind = 'start' then p_note else h.start_note end,
    fail_at = case when p_kind = 'fail' then greatest(pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()),
                                                                 greatest(h.ping_at, h.start_at, h.fail_at) + interval '1 millisecond')
                   else h.fail_at end,
    fail_payload = case when p_kind = 'fail' then p_payload else h.fail_payload end,
    fail_note = case when p_kind = 'fail' then p_note else h.fail_note end,
    finishes = h.finishes + case when p_kind = 'start' then 0 else 1 end,
    rate_ping = case when h.rate_minute = v_minute then h.rate_ping else 0 end + case when p_kind = 'ping' then 1 else 0 end,
    rate_start = case when h.rate_minute = v_minute then h.rate_start else 0 end + case when p_kind = 'start' then 1 else 0 end,
    rate_fail = case when h.rate_minute = v_minute then h.rate_fail else 0 end + case when p_kind = 'fail' then 1 else 0 end,
    rate_minute = v_minute
  -- Exact under the race the read above can lose: two calls at the bound both pass it.
  where h.rate_minute <> v_minute or
        case p_kind when 'ping' then h.rate_ping when 'start' then h.rate_start else h.rate_fail end < 10
  returning true into v_done;

  return case when v_done then 'recorded' else 'limited' end;
end;
$fn$;

-- ── what the probes read and write for heartbeats ───────────────────────────
-- Read only: each heartbeat's configuration, pause and version, and the times of what arrived
-- and of what its home judged, for the homes' wheels. No token, sealed URL or payload. Times
-- are epoch milliseconds; the version's is floored, so a ping in the same millisecond as an
-- edit counts as before it.
create or replace function public.probe_load_heartbeats(p_workspaces text[])
returns table (id text, workspace_id text, config jsonb, version text, version_at bigint, paused boolean, state text,
               ping_at bigint, start_at bigint, fail_at bigint, finishes bigint, judged_at bigint,
               judged_finishes bigint, run_at bigint)
language sql stable security definer set search_path = '' as $fn$
  select m.id, m.workspace_id, m.config,
         (extract(epoch from m.updated_at) * 1000000)::bigint::text,
         pg_catalog.floor(extract(epoch from m.updated_at) * 1000)::bigint,
         (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())),
         m.state,
         (extract(epoch from h.ping_at) * 1000)::bigint, (extract(epoch from h.start_at) * 1000)::bigint,
         (extract(epoch from h.fail_at) * 1000)::bigint, coalesce(h.finishes, 0),
         (extract(epoch from h.judged_at) * 1000)::bigint, coalesce(h.judged_finishes, 0),
         (extract(epoch from h.run_at) * 1000)::bigint
  from public.monitors m left join public.heartbeat_latest h on h.monitor_id = m.id
  where m.type = 'heartbeat' and (p_workspaces is null or m.workspace_id = any(p_workspaces));
$fn$;

-- May lock one heartbeat monitor, changing no data, so TypeScript judges its next event against
-- the current row in the caller's transaction. Returns what arrived with its payloads, the
-- cursor, and the database's clock, which every heartbeat time is measured by.
create or replace function public.probe_lock_heartbeat(p_id text)
returns table (id text, workspace_id text, name text, config jsonb, state text, paused boolean, version text,
               version_at bigint, db_now bigint,
               ping_at bigint, ping_payload jsonb, ping_note text, start_at bigint, start_payload jsonb, start_note text,
               fail_at bigint, fail_payload jsonb, fail_note text, finishes bigint,
               judged_at bigint, judged_finishes bigint, run_at bigint)
language sql volatile security definer set search_path = '' as $fn$
  select m.id, m.workspace_id, m.name, m.config, m.state,
         (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())),
         (extract(epoch from m.updated_at) * 1000000)::bigint::text,
         pg_catalog.floor(extract(epoch from m.updated_at) * 1000)::bigint,
         pg_catalog.floor(extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint,
         (extract(epoch from h.ping_at) * 1000)::bigint, h.ping_payload, h.ping_note,
         (extract(epoch from h.start_at) * 1000)::bigint, h.start_payload, h.start_note,
         (extract(epoch from h.fail_at) * 1000)::bigint, h.fail_payload, h.fail_note,
         coalesce(h.finishes, 0),
         (extract(epoch from h.judged_at) * 1000)::bigint, coalesce(h.judged_finishes, 0),
         (extract(epoch from h.run_at) * 1000)::bigint
  from public.monitors m left join public.heartbeat_latest h on h.monitor_id = m.id
  where m.id = p_id and m.type = 'heartbeat'
  for update of m;
$fn$;

-- May write only this heartbeat's cursor, its state, one transition, its incident's open or
-- close, and one failure (pruned to 20). Trusts the reducer's verdict, but refuses what a probe
-- could never legitimately ask for: a monitor that is missing, not a heartbeat, paused or of
-- another version; a state other than up or down, or clearing one; a cursor another home has
-- moved since this one read it; an event older than the cursor or newer than the database's
-- clock; a run cursor that moves back, is cleared, or sits past the judged time by more than a
-- run may report early (30 seconds, `EARLY_MS` in `src/lib/cron.ts`); more finishes judged than
-- arrived. An outage gets its own incident: one still open from something else is closed first,
-- as 017's commit does. No configuration, version, ping, payload, note or acknowledgement is
-- written.
create or replace function public.probe_commit_heartbeat(
  p_id text, p_version text, p_from timestamptz, p_at timestamptz, p_judged_at timestamptz,
  p_judged_finishes bigint, p_run_at timestamptz, p_state text, p_effects jsonb
)
returns void language plpgsql security definer set search_path = '' as $fn$
declare
  m public.monitors%rowtype;
  h public.heartbeat_latest%rowtype;
  e jsonb;
begin
  select * into m from public.monitors where id = p_id for update;
  if not found then raise exception 'probe_monitor_missing' using errcode = '22023'; end if;
  if p_version is distinct from (extract(epoch from m.updated_at) * 1000000)::bigint::text then
    raise exception 'probe_monitor_moved' using errcode = '22023';
  end if;
  if m.type <> 'heartbeat' or
     (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())) then
    raise exception 'probe_monitor_not_checkable' using errcode = '22023';
  end if;
  if (p_state is not null and p_state not in ('up', 'down')) or (p_state is null and m.state is not null) then
    raise exception 'probe_state_invalid' using errcode = '22023';
  end if;
  if p_effects is null or pg_catalog.jsonb_typeof(p_effects) <> 'array' or
     pg_catalog.jsonb_array_length(p_effects) > 3 then
    raise exception 'probe_effects_invalid' using errcode = '22023';
  end if;

  select * into h from public.heartbeat_latest where monitor_id = p_id for update;
  if not found then raise exception 'probe_heartbeat_missing' using errcode = '22023'; end if;
  if h.judged_at is distinct from p_from then
    raise exception 'probe_heartbeat_moved' using errcode = '22023';
  end if;
  -- The database's clock, not the transaction's start: a ping committed after this transaction
  -- began but before its read is a legitimate event to judge.
  if p_at is null or p_judged_at is null or p_at > p_judged_at or p_judged_at > pg_catalog.clock_timestamp() or
     (p_from is not null and p_at <= p_from) or (p_run_at is not null and p_run_at > p_judged_at + interval '30 seconds') or
     (h.run_at is not null and (p_run_at is null or p_run_at < h.run_at)) then
    raise exception 'probe_heartbeat_order_invalid' using errcode = '22023';
  end if;
  if p_judged_finishes is null or p_judged_finishes < h.judged_finishes or p_judged_finishes > h.finishes then
    raise exception 'probe_heartbeat_finishes_invalid' using errcode = '22023';
  end if;

  update public.heartbeat_latest set judged_at = p_judged_at, judged_finishes = p_judged_finishes, run_at = p_run_at
  where monitor_id = p_id;

  if p_state is distinct from m.state then
    update public.monitors set state = p_state, state_since = p_at where id = p_id;
  end if;

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
              't', p_at, 'text', 'A good ping arrived, incident closed'))
          where monitor_id = p_id and resolved_at is null;
        end if;
      when 'open_incident' then
        if p_state is distinct from 'down' then
          raise exception 'probe_incident_invalid' using errcode = '22023';
        end if;
        -- As 017's commit (review 35): the reducer opens an incident only when the locked row
        -- wasn't down, so one still open here describes something else (a seeded or hand-made
        -- one). It is closed, and this outage gets its own row, which uptime and the incident
        -- screen read. Opening time is capped at the database clock.
        update public.incidents set resolved_at = greatest(least(p_at, pg_catalog.clock_timestamp()), opened_at),
          timeline = timeline || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            't', pg_catalog.clock_timestamp(), 'text', 'A new outage opened its own incident, this one closed'))
        where monitor_id = p_id and resolved_at is null;
        insert into public.incidents (workspace_id, monitor_id, title, severity, opened_at, evidence, timeline)
        values (m.workspace_id, p_id, pg_catalog.left(m.name || ' is down', 200), 'down',
                least(p_at, pg_catalog.clock_timestamp()), e->'evidence', e->'timeline');
      when 'record_failure' then
        insert into public.check_failures (monitor_id, location, at, kind, message, status, ms, snippet, detail)
        values (p_id, e->>'location', p_at, e->>'failureKind', e->>'message',
                null, (e->>'ms')::integer, e->>'snippet', nullif(e->'detail', 'null'::jsonb));
        delete from public.check_failures where monitor_id = p_id and id not in
          (select id from public.check_failures where monitor_id = p_id order by at desc, id desc limit 20);
      else raise exception 'probe_effect_invalid' using errcode = '22023';
    end case;
  end loop;
end;
$fn$;

revoke all on function public.record_heartbeat(text, text, jsonb, text),
  public.probe_load_heartbeats(text[]), public.probe_lock_heartbeat(text),
  public.probe_commit_heartbeat(text, text, timestamptz, timestamptz, timestamptz, bigint, timestamptz, text, jsonb)
  from public, anon, authenticated, service_role;
grant usage on schema public to ingest;
grant execute on function public.record_heartbeat(text, text, jsonb, text) to ingest;
grant execute on function public.probe_load_heartbeats(text[]), public.probe_lock_heartbeat(text),
  public.probe_commit_heartbeat(text, text, timestamptz, timestamptz, timestamptz, bigint, timestamptz, text, jsonb)
  to probe;

-- ── uptime for a heartbeat ──────────────────────────────────────────────────
-- 014's `monitor_days` and 015's `workspace_history`, with one change each: for a heartbeat, a
-- day's covered seconds come from its runs (each standing for its interval, at least 5 minutes,
-- as a window does for a check), and its down seconds are the failed runs' share of them,
-- rounded up, so its uptime is the share of runs that arrived on time and passed and never
-- reads as 100 with a failure in it. Every other type reads as before.

create or replace function public.monitor_days(p_monitor_ids text[], p_days integer)
returns table (monitor_id text, day date, covered integer, down integer, up double precision)
language sql
stable
security invoker
set search_path = ''
set jit = off
as $fn$
  with b as (
    select (now() at time zone 'UTC')::date as today,
           (now() at time zone 'UTC')::date - p_days + 1 as first_day,
           extract(epoch from now() - (now() at time zone 'UTC')::date::timestamp at time zone 'UTC') as today_elapsed
  ),
  -- Each confirmed outage in range, split at UTC midnights.
  o as (
    select i.monitor_id, s.day::date as day,
           sum(extract(epoch from least(coalesce(i.resolved_at, now()), (s.day + interval '1 day') at time zone 'UTC')
                                - greatest(i.opened_at, s.day at time zone 'UTC'))) as seconds
      from public.incidents i
      cross join b
      cross join lateral generate_series(greatest((i.opened_at at time zone 'UTC')::date, b.first_day)::timestamp,
                                         (coalesce(i.resolved_at, now()) at time zone 'UTC')::date::timestamp,
                                         interval '1 day') as s (day)
     where i.monitor_id = any (p_monitor_ids)
       and i.severity = 'down'
       and coalesce(i.resolved_at, now()) > b.first_day::timestamp at time zone 'UTC'
     group by i.monitor_id, s.day
  ),
  c as (
    select r.monitor_id, r.day, m.type = 'heartbeat' as runs, r.checks, r.failures,
           least((case when m.type = 'heartbeat' then r.checks else r.windows end)::bigint * greatest(300, m.interval_sec),
                 case when r.day < b.today then 86400 else b.today_elapsed end)::integer as covered,
           coalesce(o.seconds, 0) as outage
      from public.rollups_1d r
      join public.monitors m on m.id = r.monitor_id
      cross join b
      left join o on o.monitor_id = r.monitor_id and o.day = r.day
     where r.monitor_id = any (p_monitor_ids)
       and r.day >= b.first_day
       and (case when m.type = 'heartbeat' then r.checks else r.windows end) > 0
  )
  -- Truncated, never rounded: a second of outage must not read as 100%.
  select c.monitor_id, c.day, c.covered, d.down,
         trunc(100 * (c.covered - d.down) / c.covered::numeric, 3)::double precision
    from c
    cross join lateral (select least(c.covered, case when c.runs then ceil(c.covered::numeric * c.failures / c.checks)
                                                     else c.outage end)::integer as down) d
   where c.covered > 0
$fn$;

create or replace function public.workspace_history(p_workspace_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
set jit = off
as $fn$
  with today as (
    select (now() at time zone 'UTC')::date as d
  ),
  mon as materialized (
    select m.id, greatest(300, m.interval_sec) as step, m.type = 'heartbeat' as runs
      from public.monitors m
     where m.workspace_id = p_workspace_id
  ),
  days as materialized (
    select * from public.monitor_days((select coalesce(array_agg(mon.id), '{}') from mon), 90)
  ),
  daily as (
    select x.monitor_id,
           jsonb_agg(jsonb_build_array(t.d - x.day, x.up) order by x.day) as days,
           sum(x.covered) filter (where x.day > t.d - 30) as month_covered,
           sum(x.down) filter (where x.day > t.d - 30) as month_down
      from days x
      cross join today t
     group by x.monitor_id
  ),
  outages as (
    select i.monitor_id,
           sum(extract(epoch from coalesce(i.resolved_at, now()) - greatest(i.opened_at, now() - interval '24 hours'))) as seconds
      from public.incidents i
     where i.monitor_id in (select mon.id from mon)
       and i.severity = 'down'
       and coalesce(i.resolved_at, now()) > now() - interval '24 hours'
     group by i.monitor_id
  )
  select jsonb_build_object(
    'today', (select t.d from today t),
    'monitors', coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'days', coalesce(d.days, '[]'::jsonb),
      'month', jsonb_build_object('covered', coalesce(d.month_covered, 0), 'down', coalesce(d.month_down, 0)),
      'day', jsonb_build_object('covered', r.covered,
                                'down', case when m.runs then r.run_down
                                             else least(r.covered, coalesce(o.seconds, 0))::integer end),
      'p95', r.p95,
      'latest', coalesce((
        select jsonb_agg(jsonb_build_object('loc', l.location, 'end', l.window_start + interval '5 minutes',
                                            'checks', l.checks, 'failures', l.failures, 'p50', l.p50_ms)
                         order by l.window_start desc, l.location)
          from (values ('tor1'), ('sfo3'), ('fra1')) as loc (id)
          cross join lateral (
            select x.location, x.window_start, x.checks, x.failures, x.p50_ms
              from public.rollups_5m x
             where x.monitor_id = m.id and x.location = loc.id
             order by x.window_start desc
             limit 1
          ) l
      ), '[]'::jsonb)
    ) order by m.id), '[]'::jsonb)
  )
  from mon m
  left join daily d on d.monitor_id = m.id
  left join outages o on o.monitor_id = m.id
  -- Per monitor, so the index reads its last day and nothing older. A heartbeat's 24 hours are
  -- its runs, as its days are.
  cross join lateral (
    select w.covered, w.p95,
           case when w.checks > 0 then least(w.covered, ceil(w.covered::numeric * w.failures / w.checks))::integer else 0 end as run_down
      from (
        select coalesce(least((case when m.runs then coalesce(sum(x.checks), 0) else count(distinct x.window_start) end) * m.step, 86400), 0)::integer as covered,
               coalesce(sum(x.checks), 0) as checks, coalesce(sum(x.failures), 0) as failures,
               percentile_disc(0.95) within group (order by x.p95_ms) as p95
          from public.rollups_5m x
         where x.monitor_id = m.id and x.window_start >= now() - interval '24 hours'
      ) w
  ) r
$fn$;

revoke all on function public.monitor_days(text[], integer) from public, anon, authenticated;
revoke all on function public.workspace_history(text) from public, anon, authenticated;
grant execute on function public.monitor_days(text[], integer) to service_role;
grant execute on function public.workspace_history(text) to service_role;

commit;
