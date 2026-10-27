-- 025: additive. Old probes keep calling the original eight-array flush function. New probes
-- use the wrapper below; the dashboard and the old live-set protocol are unchanged.
begin;

do $fn$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'watchdog') then
    create role watchdog nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $fn$;

-- Not a monitor check or a scheduling row. One receipt per probe, surviving probe_leave.
create table if not exists public.probe_flush_receipts (
  probe_id text primary key check (probe_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  flushed_at timestamptz not null
);
alter table public.probe_flush_receipts enable row level security;
revoke all on public.probe_flush_receipts from public, anon, authenticated, service_role, probe, ingest, watchdog;

create or replace function public.probe_flush_with_receipt(
  p_id text, p_monitors text[], p_locations text[], p_windows timestamptz[], p_checks integer[],
  p_failures integer[], p_p50 integer[], p_p95 integer[], p_max integer[]
)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  if not exists (select 1 from public.probes where id = p_id) then
    raise exception 'probe_not_registered' using errcode = '22023';
  end if;
  perform public.probe_flush_rollups(p_monitors, p_locations, p_windows, p_checks, p_failures, p_p50, p_p95, p_max);
  -- Empty windows count: an idle fleet must prove its flush path works without inventing checks.
  -- A rejected batch rolls this receipt back too. Heartbeats alone never refresh it.
  insert into public.probe_flush_receipts (probe_id, flushed_at) values (p_id, pg_catalog.clock_timestamp())
    on conflict (probe_id) do update set flushed_at = excluded.flushed_at;
end;
$fn$;

-- The expected inventory comes from the operator, never the live set: a missing/deleted row
-- and a probe that has never started must still be reported. The database's clock sets age.
create or replace function public.watchdog_flush_status(p_ids text[])
returns table (id text, flushed_at timestamptz, age_sec double precision)
language sql stable security definer set search_path = '' as $fn$
  select i.id, r.flushed_at, extract(epoch from (pg_catalog.now() - r.flushed_at))::float8
  from (select distinct pg_catalog.unnest(p_ids[1:100]) as id) i
  left join public.probe_flush_receipts r on r.probe_id = i.id order by i.id;
$fn$;

revoke all on function public.probe_flush_with_receipt(text,text[],text[],timestamptz[],integer[],integer[],integer[],integer[],integer[]),
  public.watchdog_flush_status(text[]) from public, anon, authenticated, service_role, probe, ingest, watchdog;
grant execute on function public.probe_flush_with_receipt(text,text[],text[],timestamptz[],integer[],integer[],integer[],integer[],integer[]) to probe;
grant usage on schema public to watchdog;
grant execute on function public.watchdog_flush_status(text[]) to watchdog;
commit;
