-- 015: Toronto (`tor1`) replaces New York (`nyc3`) as a probe location, so Free checks from
-- Toronto and San Francisco, a continent apart, and Builder adds Frankfurt (owner, 2026-10-22;
-- `decisions.md`). The locations' names live in `src/lib/plans.ts`; three places in the schema
-- list their ids, and this replaces each.
--
-- What it changes in data: `nyc3` leaves each monitor's ordering marker (only the locations
-- already counted in the newest outcome's second, so the next outcome counts as new), and the
-- `probes` row of a New York probe goes (a live probe heartbeats its row back within a minute, and
-- the New York droplet is stopped before this is applied). `rollups_5m` keeps New York's windows
-- as history: its `location` has no list, and the daily bars sum every location.
--
-- Idempotent, and never edited after it is applied.

update public.monitors
   set probe_outcome_locations = array_remove(probe_outcome_locations, 'nyc3')
 where 'nyc3' = any(probe_outcome_locations);

delete from public.probes where location = 'nyc3';

alter table public.monitors drop constraint if exists monitors_probe_outcome_locations_check;
alter table public.monitors add constraint monitors_probe_outcome_locations_check
  check (cardinality(probe_outcome_locations) <= 3 and probe_outcome_locations <@ array['tor1', 'sfo3', 'fra1']::text[]);

alter table public.probes drop constraint if exists probes_location_check;
alter table public.probes add constraint probes_location_check check (location in ('tor1', 'sfo3', 'fra1'));

-- 014's reader, with the new list of locations whose newest window it returns.
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
    select m.id, greatest(300, m.interval_sec) as step
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
      'day', jsonb_build_object('covered', r.covered, 'down', least(r.covered, coalesce(o.seconds, 0))::integer),
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
  -- Per monitor, so the index reads its last day and nothing older.
  cross join lateral (
    select coalesce(least(count(distinct x.window_start) * m.step, 86400), 0)::integer as covered,
           percentile_disc(0.95) within group (order by x.p95_ms) as p95
      from public.rollups_5m x
     where x.monitor_id = m.id and x.window_start >= now() - interval '24 hours'
  ) r
$fn$;

revoke all on function public.workspace_history(text) from public, anon, authenticated;
grant execute on function public.workspace_history(text) to service_role;
