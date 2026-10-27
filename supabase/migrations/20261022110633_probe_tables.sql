-- 013: the tables the probe writes besides `monitors` and `incidents`, and the `probe` role.
-- Until now they were the spike's own (`probe/schema.sql`, a local Postgres only). They move here
-- so the probes can check the development project's monitors (owner, 2026-10-22), the first part
-- of plan stage 2.2.
--
-- `§ 1.4` as everywhere: RLS on with zero policies, nothing for PUBLIC, `anon` or
-- `authenticated`. `probe` is a group role with only the grants `probe/store.ts` uses. It cannot
-- log in: each probe logs in as its own role, a member of `probe` with BYPASSRLS, created per
-- environment outside migrations because it carries a password (`docs/environments.md`,
-- Probes). Least-privilege write functions in place of table grants stay with stage 2.2.
--
-- Idempotent, and never edited after it is applied.

create table if not exists public.probes (
  id           text primary key check (id ~ '^[a-z0-9-]{1,40}$'),
  location     text not null check (location in ('nyc3', 'sfo3', 'fra1')),
  builder_only boolean not null default false,
  url          text not null check (url ~ '^https?://'),
  last_seen    timestamptz not null default now()
);

-- One row per monitor, location and 5-minute window. A probe writes each of its windows once,
-- when it closes; a second write (a restart that flushes what it had) merges into the first.
create table if not exists public.rollups_5m (
  monitor_id   text not null references public.monitors (id) on delete cascade,
  location     text not null,
  window_start timestamptz not null,
  checks       integer not null check (checks > 0),
  failures     integer not null check (failures between 0 and checks),
  p50_ms       integer,
  p95_ms       integer,
  max_ms       integer,
  primary key (monitor_id, location, window_start)
);

create table if not exists public.transitions (
  id         bigint generated always as identity primary key,
  monitor_id text not null references public.monitors (id) on delete cascade,
  from_state text check (from_state in ('up', 'degraded', 'down')),
  to_state   text not null check (to_state in ('up', 'degraded', 'down')),
  at         timestamptz not null
);
create index if not exists transitions_monitor_idx on public.transitions (monitor_id, at desc);

-- The last 20 failed checks per monitor (`AGENTS.md`), each snippet masked and at most 300 bytes.
create table if not exists public.check_failures (
  id         bigint generated always as identity primary key,
  monitor_id text not null references public.monitors (id) on delete cascade,
  location   text not null,
  at         timestamptz not null,
  kind       text not null,
  message    text not null check (char_length(message) <= 500),
  status     integer,
  ms         integer not null,
  snippet    text check (snippet is null or octet_length(snippet) <= 300),
  detail     jsonb
);
create index if not exists check_failures_monitor_idx on public.check_failures (monitor_id, at desc, id desc);

alter table public.probes         enable row level security;
alter table public.rollups_5m     enable row level security;
alter table public.transitions    enable row level security;
alter table public.check_failures enable row level security;

revoke all on public.probes, public.rollups_5m, public.transitions, public.check_failures from public, anon, authenticated;
revoke all on sequence public.transitions_id_seq, public.check_failures_id_seq from public, anon, authenticated;
grant select, insert, update, delete on public.probes, public.rollups_5m, public.transitions, public.check_failures to service_role;

-- ── the probe ────────────────────────────────────────────────────────────────

do $do$
begin
  if not exists (select 1 from pg_roles where rolname = 'probe') then
    create role probe nologin;
  end if;
end
$do$;

grant usage on schema public to probe;
grant select, insert, update, delete on public.probes to probe;
grant select, update on public.monitors to probe;
grant select on public.monitor_secrets to probe;
grant select, insert, update on public.rollups_5m to probe;
grant insert on public.transitions to probe;
grant select, insert, update on public.incidents to probe;
grant select, insert, delete on public.check_failures to probe;
-- An incident's id is `public.new_id('inc')` by default, evaluated as the inserting role.
grant execute on function public.new_id(text) to probe;
