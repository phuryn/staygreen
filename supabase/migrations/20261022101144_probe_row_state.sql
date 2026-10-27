-- 012: the checked monitor's state machine lives in its row, not in its home.
-- Additive: the existing dashboard calls and return types continue to work. Stop old probe
-- processes before running the new ones: old binaries do not maintain these counters.
-- No existing state or incident changes. A degraded row stays degraded until a fast pass;
-- a down row starts with zero recovery passes. Re-applying never resets live counters.

alter table public.monitors
  add column if not exists probe_slow_streak integer not null default 0 check (probe_slow_streak between 0 and 3),
  add column if not exists probe_pass_streak integer not null default 0 check (probe_pass_streak between 0 and 1),
  add column if not exists probe_fail_streak integer not null default 0 check (probe_fail_streak between 0 and 1),
  add column if not exists probe_outcome_at timestamptz,
  add column if not exists probe_outcome_locations text[] not null default '{}'
    check (cardinality(probe_outcome_locations) <= 3 and probe_outcome_locations <@ array['nyc3', 'sfo3', 'fra1']::text[]);

-- One database rule for every version writer: update_monitor, pause_monitor, resume_monitor,
-- and any later edit that changes updated_at. Probe writes omit updated_at, so they neither
-- reset counters nor change the version a peer must confirm. Automatic pause expiry needs no
-- second reset: the pause already reset counting and fenced all pre-pause checks.
create or replace function public.reset_probe_state_on_edit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  -- now() can be equal (or older) across writes in overlapping transactions. Each edit still
  -- needs a distinct version, including pause/resume inside one transaction.
  new.updated_at := greatest(new.updated_at, old.updated_at + interval '1 microsecond');
  new.probe_slow_streak := 0;
  new.probe_pass_streak := 0;
  new.probe_fail_streak := 0;
  new.probe_outcome_at := null;
  new.probe_outcome_locations := '{}';
  return new;
end;
$fn$;

create or replace trigger monitors_reset_probe_state
before update of updated_at on public.monitors
for each row execute function public.reset_probe_state_on_edit();

revoke all on function public.reset_probe_state_on_edit() from public, anon, authenticated;
grant execute on function public.reset_probe_state_on_edit() to service_role;
