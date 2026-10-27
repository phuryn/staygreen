-- 014: what the probes measured, read back by the dashboard and the status pages (plan stage
-- 2.2: "the dashboard's uptime bars, response times and 'Not checked yet' turn real").
--
-- The probes write one `rollups_5m` row per monitor, location and closed 5-minute window (013).
-- Ninety days of those is 90 × 288 windows per location per monitor, too many to aggregate on
-- every dashboard visit, so this adds the daily tier `spec.md § 2` names: `rollups_1d`, one row
-- per monitor and UTC day, kept current by a trigger on `rollups_5m` rather than by a scheduled
-- job, so it is never behind and needs no job to exist. The hourly tier waits for its first
-- reader (the agents' `get_response_times`, stage 3.4); the last 24 hours are read from the
-- 5-minute rows themselves, which `AGENTS.md § 2.8` keeps for 48.
--
-- Uptime means what the dashboard already meant by it (`src/lib/derive.ts` until now): the share
-- of the time that no confirmed outage, a `down` incident, took. What is new is the denominator:
-- only the time the probes' windows cover, so a day with no window is no data, never 100%, and a
-- pause or a probe outage counts neither way. A failed check is not downtime by itself: a
-- failure no second location confirmed is one location's noise (`probe/state.ts`), and every
-- confirmed one is checked twice, so counting checks would weigh an outage double.
--
-- `§ 1.4` as everywhere: RLS on with zero policies, nothing for PUBLIC, `anon` or
-- `authenticated`, every function `security invoker` with an empty `search_path`. A probe
-- writes `rollups_5m` as its own login role and the trigger runs as that role, so `probe` gets
-- what the trigger writes on `rollups_1d`, and nothing else.
--
-- Idempotent, and never edited after it is applied.

create table if not exists public.rollups_1d (
  monitor_id text not null references public.monitors (id) on delete cascade,
  day        date not null,
  -- Distinct 5-minute windows any location reported that day: how much of it was watched.
  -- No upper bound on purpose: a check the trigger's race can exceed (below) would fail the
  -- probe's whole flush.
  windows    integer not null default 0 check (windows >= 0),
  checks     integer not null default 0 check (checks >= 0),
  failures   integer not null default 0 check (failures between 0 and checks),
  primary key (monitor_id, day)
);

alter table public.rollups_1d enable row level security;
revoke all on public.rollups_1d from public, anon, authenticated;
grant select, insert, update, delete on public.rollups_1d to service_role;
grant select, insert, update on public.rollups_1d to probe;

-- The last 24 hours of one monitor, at every location, without reading its older windows (the
-- primary key puts the location before the window), and with the p95 in the index, so the
-- 24-hour numbers never visit the table: a monitor's windows are written beside every other
-- monitor's, one page apart.
create index if not exists rollups_5m_monitor_window_idx on public.rollups_5m (monitor_id, window_start desc) include (p95_ms);

-- A monitor's down time, read per monitor rather than per workspace.
create index if not exists incidents_monitor_idx on public.incidents (monitor_id, opened_at desc);

-- ── keeping the days ─────────────────────────────────────────────────────────
-- Statement-level, so one flush (one statement per probe: `probe/store.ts`) is one upsert per
-- monitor and day, however many windows it carries.

create or replace function public.rollups_1d_add()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  insert into public.rollups_1d as d (monitor_id, day, windows, checks, failures)
  select w.monitor_id, (w.window_start at time zone 'UTC')::date,
         -- A window is new to its day when every row it has arrived in this statement. Two
         -- locations flushing the same window in the same instant can each count it; coverage
         -- is capped at the day's elapsed length (`monitor_days`), so the most that costs is
         -- one window of over-coverage on a day the probes didn't watch whole.
         count(*) filter (where w.n = (select count(*) from public.rollups_5m r
                                        where r.monitor_id = w.monitor_id and r.window_start = w.window_start)),
         sum(w.checks), sum(w.failures)
    from (select a.monitor_id, a.window_start, count(*) as n, sum(a.checks) as checks, sum(a.failures) as failures
            from added a
           group by a.monitor_id, a.window_start) w
   group by 1, 2
  on conflict (monitor_id, day) do update
     set windows  = d.windows + excluded.windows,
         checks   = d.checks + excluded.checks,
         failures = d.failures + excluded.failures;
  return null;
end;
$fn$;

-- A window written twice (a probe restarting flushes what it had) merges into the first row;
-- only what the merge added reaches the day.
create or replace function public.rollups_1d_merge()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  insert into public.rollups_1d as d (monitor_id, day, windows, checks, failures)
  select n.monitor_id, (n.window_start at time zone 'UTC')::date, 0,
         greatest(0, sum(n.checks - o.checks)), greatest(0, sum(n.failures - o.failures))
    from merged n
    join replaced o on o.monitor_id = n.monitor_id and o.location = n.location and o.window_start = n.window_start
   where n.checks <> o.checks or n.failures <> o.failures
   group by 1, 2
  on conflict (monitor_id, day) do update
     set checks   = d.checks + excluded.checks,
         failures = least(d.failures + excluded.failures, d.checks + excluded.checks);
  return null;
end;
$fn$;

create or replace trigger rollups_5m_add_to_day
after insert on public.rollups_5m
referencing new table as added
for each statement execute function public.rollups_1d_add();

create or replace trigger rollups_5m_merge_into_day
after update on public.rollups_5m
referencing old table as replaced new table as merged
for each statement execute function public.rollups_1d_merge();

-- What the probes wrote before this migration. The triggers exist first, so a window flushed
-- while this runs is counted by them and by this recount of every 5-minute row taken after;
-- `greatest` keeps the larger of the two counts, so neither order counts it twice, and a second
-- run changes nothing while the 5-minute rows are all still there (nothing purges them yet).
insert into public.rollups_1d as d (monitor_id, day, windows, checks, failures)
select r.monitor_id, (r.window_start at time zone 'UTC')::date, count(distinct r.window_start), sum(r.checks), sum(r.failures)
  from public.rollups_5m r
 group by 1, 2
on conflict (monitor_id, day) do update
   set windows  = greatest(d.windows, excluded.windows),
       checks   = greatest(d.checks, excluded.checks),
       failures = greatest(d.failures, excluded.failures);

-- ── reading the days ─────────────────────────────────────────────────────────
-- Each monitor's UTC days with a window in the last `p_days`: how long the probes watched it
-- (`covered`, seconds), how much of that a confirmed outage took (`down`), and the uptime that
-- makes (`up`, a percentage). A window stands for the check interval it belongs to, at least its
-- own 5 minutes, so a DNS monitor checked every 10 minutes (a window in every other slot) still
-- covers its whole day; a day never covers more than it has elapsed. The callers scope the ids:
-- `workspace_history` to one workspace, `public_status_snapshot` to one page's components.
--
-- The three readers here turn JIT off: their plans are small index reads, but a parameter's
-- generic estimate can pass `jit_above_cost`, and compiling then took a second for a query that
-- runs in under a tenth of one (measured on Postgres 17 with 1,100 monitors' rows).

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
    select r.monitor_id, r.day,
           least(r.windows::bigint * greatest(300, m.interval_sec),
                 case when r.day < b.today then 86400 else b.today_elapsed end)::integer as covered,
           coalesce(o.seconds, 0) as outage
      from public.rollups_1d r
      join public.monitors m on m.id = r.monitor_id
      cross join b
      left join o on o.monitor_id = r.monitor_id and o.day = r.day
     where r.monitor_id = any (p_monitor_ids)
       and r.day >= b.first_day
       and r.windows > 0
  )
  -- Truncated, never rounded: a second of outage must not read as 100%.
  select c.monitor_id, c.day, c.covered, d.down,
         trunc(100 * (c.covered - d.down) / c.covered::numeric, 3)::double precision
    from c
    cross join lateral (select least(c.covered, c.outage)::integer as down) d
   where c.covered > 0
$fn$;

-- ── the dashboard ────────────────────────────────────────────────────────────
-- Every monitor of one workspace in one call per page (`loadSnapshot`, `src/lib/workspace.ts`):
-- `days`, `[age, uptime]` for each of the last 90 UTC days that has a window, age 0 being
-- `today`; `month`, the last 30 days' coverage and outage time; `day`, the same
-- for the last 24 hours, from the 5-minute rows, with their `p95`; and `latest`, each location's
-- newest window. The p95 is the 95th percentile of the windows' own p95s, which leans slow: an
-- exact one would need every check. The locations are the three the `probes` table allows (013).

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
          from (values ('nyc3'), ('sfo3'), ('fra1')) as loc (id)
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

-- One monitor's own page (`/app/monitors/[id]`): its last 24 hours of windows with every location
-- merged into one point per window, the way the probe merges a window written twice
-- (`probe/store.ts`), and its last failed checks and state changes. Null for a monitor the
-- workspace doesn't own. A failure's `detail` stays in the row.

create or replace function public.monitor_history(p_workspace_id text, p_monitor_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
set jit = off
as $fn$
  select jsonb_build_object(
    'points', coalesce((
      select jsonb_agg(jsonb_build_object('t', w.window_start, 'checks', w.checks, 'failures', w.failures, 'p50', w.p50, 'p95', w.p95)
                       order by w.window_start)
        from (select r.window_start, sum(r.checks) as checks, sum(r.failures) as failures,
                     round(sum(r.p50_ms::numeric * (r.checks - r.failures)) filter (where r.p50_ms is not null)
                           / nullif(sum(r.checks - r.failures) filter (where r.p50_ms is not null), 0))::integer as p50,
                     max(r.p95_ms) as p95
                from public.rollups_5m r
               where r.monitor_id = m.id and r.window_start >= now() - interval '24 hours'
               group by r.window_start) w
    ), '[]'::jsonb),
    'failures', coalesce((
      select jsonb_agg(jsonb_build_object('at', f.at, 'loc', f.location, 'kind', f.kind, 'message', f.message,
                                          'status', f.status, 'ms', f.ms, 'snippet', f.snippet)
                       order by f.at desc, f.id desc)
        from (select * from public.check_failures cf where cf.monitor_id = m.id order by cf.at desc, cf.id desc limit 20) f
    ), '[]'::jsonb),
    'transitions', coalesce((
      select jsonb_agg(jsonb_build_object('at', t.at, 'from', t.from_state, 'to', t.to_state) order by t.at desc, t.id desc)
        from (select * from public.transitions tr where tr.monitor_id = m.id order by tr.at desc, tr.id desc limit 20) t
    ), '[]'::jsonb)
  )
  from public.monitors m
  where m.id = p_monitor_id and m.workspace_id = p_workspace_id
$fn$;

-- ── the status page ──────────────────────────────────────────────────────────
-- Same allowlist, pause-expiry and published-only rules as 009; each component adds its days,
-- `{ d, up }` for each UTC day in the page's history (at most the 90 the bars draw) with a window
-- from any of its monitors, a day being as good as its worst monitor that day. No monitor id or
-- count reaches the page. A component's uptime counts every confirmed outage of its monitors,
-- published or not, as its state already does: a page shows a component's state either way, and
-- only an incident's listing and its words wait for the builder to publish.

create or replace function public.public_status_snapshot(p_slug text)
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
  where p.slug = p_slug
$fn$;

-- ── grants (`§ 1.4`) ─────────────────────────────────────────────────────────

revoke all on function public.rollups_1d_add() from public, anon, authenticated;
revoke all on function public.rollups_1d_merge() from public, anon, authenticated;
revoke all on function public.monitor_days(text[], integer) from public, anon, authenticated;
revoke all on function public.workspace_history(text) from public, anon, authenticated;
revoke all on function public.monitor_history(text, text) from public, anon, authenticated;
revoke all on function public.public_status_snapshot(text) from public, anon, authenticated;
grant execute on function public.rollups_1d_add() to service_role;
grant execute on function public.rollups_1d_merge() to service_role;
grant execute on function public.monitor_days(text[], integer) to service_role;
grant execute on function public.workspace_history(text) to service_role;
grant execute on function public.monitor_history(text, text) to service_role;
grant execute on function public.public_status_snapshot(text) to service_role;
