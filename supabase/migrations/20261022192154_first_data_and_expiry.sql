-- 020: an SSL monitor's certificate and its domain's registration, stored and shown
-- (`docs/product/spec.md § 3.2`, pulled forward from plan stage 3.1).
--
-- The certificate. The probe's SSL check already reads the expiry and issuer
-- (`src/checks/cert.ts`); the monitor's home now writes them onto its row in the same commit as
-- the outcome, and only when they changed, so a steady pass still writes nothing
-- (`probe/store.ts`). They are kept with the host they were read from (`cert_host`): an edit to
-- another host leaves them behind, and every reader shows them only while that host is still the
-- monitor's, so an edit needs no reset.
--
-- The domain. `domain_registrations` holds what a registry's RDAP service said about a
-- registrable domain, once a day per domain (not per monitor, not per workspace): the probe
-- fleet's leader looks up the domains of the hosts the SSL monitors name (`probe/domains.ts`).
-- It is a cache of public registry facts keyed by name, with no workspace, so a domain watched by
-- two workspaces is asked about once. It holds nothing about a person and no monitor id, and the
-- dashboard reads it only through `workspace_domains`, for its own SSL monitors' hosts. A row is
-- either a domain the registry answered for (`found`) or, keyed by the host itself, why no domain
-- was found: the TLD has no RDAP service (`no_rdap`), every name from the host up was refused
-- (`not_found`), or no definitive answer yet (`failed`). A failed attempt on a row that has an
-- answer keeps the answer and notes the error. A host's row is the longest of its names with a
-- `found` row, or else the longest with any (`domain_registration_for`), so `www.askone.org`
-- reads `askone.org`'s, even beside a failed walk of its own. A registry that answers 429 is
-- recorded nowhere: the leader backs off it (`src/checks/rdap.ts`).
--
-- The windows. A new monitor's first check is written to its open 5-minute window at once
-- (`probe/runtime.ts`), so a window still open at an edit can already hold the old version's
-- checks in the database, not only in a probe's memory. An edit of a checked monitor now drops its
-- open windows' rows, and what they added to the day (`forget_open_windows_on_edit`).
--
-- `§ 1.4` as everywhere: RLS on with zero policies, nothing for PUBLIC, `anon` or
-- `authenticated`. The probe reaches the new data only through its functions: the lock and commit
-- it already had (redefined here with the same signatures), and two new ones for the domains,
-- `security definer` with an empty search path and executable by `probe` alone.
--
-- Apply before the dashboard and the probes built with it: the dashboard selects the new columns
-- and calls `workspace_domains`. A probe built with this change writes a certificate only when
-- the lock returns its columns, so against an older database it writes none and fails nothing.
-- Probes built before it run unchanged: their lock reads `select *`, and their commits carry no
-- certificate.
--
-- Idempotent, and never edited after it is applied.

begin;

-- ── the certificate ─────────────────────────────────────────────────────────

alter table public.monitors
  add column if not exists cert_host       text,
  add column if not exists cert_expires_at timestamptz,
  add column if not exists cert_issuer     text;

alter table public.monitors drop constraint if exists monitors_cert;
alter table public.monitors add constraint monitors_cert check (
  (cert_host is null) = (cert_expires_at is null)
  and (cert_issuer is null or cert_host is not null)
  and (cert_issuer is null or length(cert_issuer) <= 200)
);

-- The domain writer asks whether any SSL monitor still names a host.
create index if not exists monitors_ssl_host_idx on public.monitors (target_host) where type = 'ssl';

-- 017's lock, also returning the row's host and the certificate stored for it, so the home can
-- tell whether a check read something new without another round trip. A return type can't be
-- widened by `create or replace`, so it is dropped and made again, and granted again below.
drop function if exists public.probe_lock_monitor(text);
create function public.probe_lock_monitor(p_id text)
returns table (id text, workspace_id text, name text, type text, target text, config jsonb, state text,
               paused boolean, version text, since double precision, probe_slow_streak integer,
               probe_pass_streak integer, probe_fail_streak integer, outcome_at double precision,
               probe_outcome_locations text[], target_host text, cert_host text,
               cert_expires_at double precision, cert_issuer text)
language sql volatile security definer set search_path = '' as $fn$
  select m.id, m.workspace_id, m.name, m.type, m.target, m.config, m.state,
         (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())),
         (extract(epoch from m.updated_at) * 1000000)::bigint::text,
         extract(epoch from m.state_since)::float8,
         m.probe_slow_streak, m.probe_pass_streak, m.probe_fail_streak,
         extract(epoch from m.probe_outcome_at)::float8, m.probe_outcome_locations,
         m.target_host, m.cert_host, extract(epoch from m.cert_expires_at)::float8, m.cert_issuer
  from public.monitors m where m.id = p_id and m.type in ('http', 'tcp', 'ssl', 'dns') for update;
$fn$;

-- 017's commit with one more effect, `cert`: an SSL monitor's certificate expiry and issuer, for
-- the host the row names (the version fence above means that is the host the check read). Five
-- effects at most now: two failures, a transition, an incident and a certificate. Every other
-- rule is 017's, unchanged.
--
-- This function is the one place that decides whether a certificate is stored: the probe sends
-- the expiry it read, whatever it is, and nothing here refuses the outcome over it. An expiry a
-- certificate can carry runs from 1950 (X.509's UTCTime) to the end of 9999 (GeneralizedTime;
-- RFC 5280 § 4.1.2.5 gives 9999-12-31 23:59:59 to a certificate with no expiry). Anything else,
-- an expiry that isn't a time, or a monitor that isn't SSL, stores no certificate and the outcome
-- commits; an issuer that isn't text is none, and a long one is cut to the column's 200.
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
  if m.type not in ('http', 'tcp', 'ssl', 'dns') or
     (m.paused_at is not null and (m.paused_until is null or m.paused_until > pg_catalog.now())) then
    raise exception 'probe_monitor_not_checkable' using errcode = '22023';
  end if;
  if (p_state is not null and p_state not in ('up', 'degraded', 'down')) or
     (p_state is null and m.state is not null) then
    raise exception 'probe_state_invalid' using errcode = '22023';
  end if;
  if p_effects is null or pg_catalog.jsonb_typeof(p_effects) <> 'array' or
     pg_catalog.jsonb_array_length(p_effects) > 5 then
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
      else raise exception 'probe_effect_invalid' using errcode = '22023';
    end case;
  end loop;
end;
$fn$;

-- ── the domain ──────────────────────────────────────────────────────────────

create table if not exists public.domain_registrations (
  -- Lowercase ASCII (an internationalized name in its `xn--` form), two labels or more.
  name         text primary key
                 check (length(name) <= 253 and name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'),
  status       text not null check (status in ('found', 'no_rdap', 'not_found', 'failed')),
  -- The registry's expiration event, when it publishes one.
  expires_at   timestamptz,
  registrar    text check (registrar is null or length(registrar) <= 200),
  -- Why the newest attempt failed; null when it was answered.
  error        text check (error is null or length(error) <= 200),
  -- When a registry last answered definitively, and when the leader last asked.
  checked_at   timestamptz,
  attempted_at timestamptz not null,
  constraint domain_registrations_facts check (status = 'found' or (expires_at is null and registrar is null)),
  constraint domain_registrations_answered check ((status = 'failed') = (checked_at is null)),
  constraint domain_registrations_failed check (status <> 'failed' or error is not null)
);

alter table public.domain_registrations enable row level security;
revoke all on public.domain_registrations from public, anon, authenticated;
grant select, insert, update, delete on public.domain_registrations to service_role;

-- Each host's row: the longest of its names (the host, then each parent of two labels or more)
-- that has a registry's domain answer (`found`), or else the longest that has any row, or none. A
-- found domain always wins: a row the host holds of its own (a walk that failed, or a pass that
-- overlapped another at a leader handover) never hides an expiry already read for the domain
-- above it, so no screen says the registry wasn't read when it was. Read only; the two callers
-- below decide which hosts.
create or replace function public.domain_registration_for(p_hosts text[])
returns table (host text, name text, status text, expires_at timestamptz, registrar text, error text,
               checked_at timestamptz, attempted_at timestamptz)
language sql stable security invoker set search_path = '' as $fn$
  select distinct on (h.host) h.host, d.name, d.status, d.expires_at, d.registrar, d.error, d.checked_at, d.attempted_at
    from (select distinct pg_catalog.lower(x) as host from pg_catalog.unnest(p_hosts) as x where x is not null) h
    cross join lateral pg_catalog.generate_series(1, pg_catalog.cardinality(pg_catalog.string_to_array(h.host, '.')) - 1) as i
    join public.domain_registrations d
      on d.name = pg_catalog.array_to_string((pg_catalog.string_to_array(h.host, '.'))[i:], '.')
   order by h.host, (d.status = 'found') desc, i
$fn$;

-- The dashboard's read (`loadSnapshot`): the rows for the hosts this workspace's SSL monitors
-- name, and nothing about any other host.
create or replace function public.workspace_domains(p_workspace_id text)
returns table (host text, name text, status text, expires_at timestamptz, registrar text, error text,
               checked_at timestamptz, attempted_at timestamptz)
language sql stable security invoker set search_path = '' as $fn$
  select * from public.domain_registration_for(array(
    select m.target_host from public.monitors m
     where m.workspace_id = p_workspace_id and m.type = 'ssl' and m.target_host is not null))
$fn$;

-- Read only: each host's row, for the leader to work out which domains are due. Registry facts
-- only: no workspace, monitor or person. Bounded, so one call can't ask about everything.
create or replace function public.probe_load_domains(p_hosts text[])
returns table (host text, name text, status text, error text, attempted_at double precision)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if p_hosts is null or pg_catalog.cardinality(p_hosts) > 100000 then
    raise exception 'probe_domain_hosts_invalid' using errcode = '22023';
  end if;
  return query
    select r.host, r.name, r.status, r.error, extract(epoch from r.attempted_at)::float8
      from public.domain_registration_for(p_hosts) r;
end;
$fn$;

-- May write what a registry said about one name and nothing else, and only for a host an SSL
-- monitor still names: false, writing nothing, once none does (a monitor deleted during the
-- lookup). The name is the host or one of its parents. `found` replaces the row's facts and drops
-- a row the host itself held from an earlier failure to find its domain, which would otherwise
-- shadow the domain's; `no_rdap` and `not_found` replace them with nothing; `failed` keeps
-- whatever answer the row had and notes the error. The times are the database's.
create or replace function public.probe_record_domain(
  p_host text, p_name text, p_status text, p_expires_at timestamptz, p_registrar text, p_error text
)
returns boolean language plpgsql security definer set search_path = '' as $fn$
begin
  if p_host is null or p_name is null or
     (p_host <> p_name and pg_catalog.right(p_host, pg_catalog.length(p_name) + 1) <> '.' || p_name) then
    raise exception 'probe_domain_name_invalid' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('found', 'no_rdap', 'not_found', 'failed') or
     (p_status <> 'found' and (p_expires_at is not null or p_registrar is not null)) or
     (p_status = 'failed') <> (p_error is not null) or
     pg_catalog.length(coalesce(p_registrar, '')) > 200 or pg_catalog.length(coalesce(p_error, '')) > 200 or
     (p_expires_at is not null and (p_expires_at < timestamptz '1985-01-01 00:00:00+00' or
                                    p_expires_at > pg_catalog.now() + interval '200 years')) then
    raise exception 'probe_domain_fact_invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from public.monitors m where m.type = 'ssl' and m.target_host = p_host) then
    return false;
  end if;

  if p_status = 'failed' then
    insert into public.domain_registrations as d (name, status, error, attempted_at)
    values (p_name, 'failed', p_error, pg_catalog.now())
    on conflict (name) do update set error = excluded.error, attempted_at = excluded.attempted_at;
    return true;
  end if;

  insert into public.domain_registrations as d (name, status, expires_at, registrar, error, checked_at, attempted_at)
  values (p_name, p_status, p_expires_at, p_registrar, null, pg_catalog.now(), pg_catalog.now())
  on conflict (name) do update set status = excluded.status, expires_at = excluded.expires_at,
    registrar = excluded.registrar, error = null, checked_at = excluded.checked_at, attempted_at = excluded.attempted_at;
  if p_status = 'found' and p_host <> p_name then
    delete from public.domain_registrations where name = p_host and status <> 'found';
  end if;
  return true;
end;
$fn$;

-- ── a new version's windows start over ──────────────────────────────────────

-- An edit, a pause or a resume makes a new version of a checked monitor (012). The 5-minute
-- windows still open then hold the old version's checks: the old address's, or ones judged by the
-- old settings, which the new version's first numbers would otherwise be merged into and shown as
-- its own. Those rows go, and the day's tier (014) loses what they had added to it, so a window
-- holds one version's checks; the probes drop what they hold for the same windows when they read
-- the new version (`probe/runtime.ts`). A window that closed before the edit stays: it is the old
-- version's whole. Heartbeats aren't here: their windows count runs, which an edit doesn't undo.
create or replace function public.forget_open_windows_on_edit()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  with gone as (
    delete from public.rollups_5m r
     where r.monitor_id = new.id and r.window_start > pg_catalog.now() - interval '5 minutes'
    returning r.window_start, r.checks, r.failures
  ), days as (
    select (g.window_start at time zone 'UTC')::date as day, count(distinct g.window_start) as windows,
           sum(g.checks) as checks, sum(g.failures) as failures
      from gone g group by 1
  )
  update public.rollups_1d d
     set windows = greatest(0, d.windows - days.windows),
         checks = greatest(0, d.checks - days.checks),
         -- Never more failures than checks (014's check), whatever the day's race left in it:
         -- an edit must not fail on the day's arithmetic.
         failures = least(greatest(0, d.failures - days.failures), greatest(0, d.checks - days.checks))
    from days
   where d.monitor_id = new.id and d.day = days.day;
  return null;
end;
$fn$;

create or replace trigger monitors_forget_open_windows
after update of updated_at on public.monitors
for each row when (new.type in ('http', 'tcp', 'ssl', 'dns') and old.updated_at is distinct from new.updated_at)
execute function public.forget_open_windows_on_edit();

-- ── grants (`§ 1.4`) ─────────────────────────────────────────────────────────

revoke all on function public.forget_open_windows_on_edit() from public, anon, authenticated;
grant execute on function public.forget_open_windows_on_edit() to service_role;

revoke all on function public.domain_registration_for(text[]), public.workspace_domains(text)
  from public, anon, authenticated;
grant execute on function public.domain_registration_for(text[]), public.workspace_domains(text) to service_role;

revoke all on function public.probe_lock_monitor(text),
  public.probe_commit_monitor(text, text, timestamptz, text, integer, integer, integer, text[], jsonb),
  public.probe_load_domains(text[]),
  public.probe_record_domain(text, text, text, timestamptz, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.probe_lock_monitor(text),
  public.probe_commit_monitor(text, text, timestamptz, text, integer, integer, integer, text[], jsonb),
  public.probe_load_domains(text[]),
  public.probe_record_domain(text, text, text, timestamptz, text, text)
  to probe;

commit;
