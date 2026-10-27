-- 003 · Phase 1: the per-host limit counts the host the database derives, and
-- no new function is executable by PUBLIC.
--
-- `create_monitor` used to count the `p_target_host` it was handed, so a call
-- that passed none, or another host, created a monitor past the per-host limit
-- (`AGENTS.md § 2.8`: "enforced in the database"). It now derives the host
-- from the target itself, by the same rules as `src/lib/monitor-input.ts`, and
-- refuses a call whose host disagrees: the two derivations drifting apart is a
-- bug, and it should fail loudly rather than count the wrong host.
--
-- Postgres's built-in default gives EXECUTE on every new function to PUBLIC.
-- 001 revoked it for schema `public` only, and a per-schema revoke cannot
-- remove a global default (`ALTER DEFAULT PRIVILEGES`, Notes), so the global
-- default is revoked here. `tests/integration/catalog.test.ts` proves both.
--
-- Idempotent, and never edited after it is applied.

-- The host a monitor's target names, as `monitor-input.ts` stores it:
--   http       the URL's hostname, lowercased, brackets and a trailing dot removed
--   ssl        the target itself
--   tcp        the target without its `:port`
--   dns        the record's owner (leading `_label.`s removed), when it is a plain name
--   heartbeat  none
-- Null for a target that doesn't have the shape its type writes.
create or replace function public.monitor_target_host(p_type text, p_target text)
returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_auth text;
  v_host text;
begin
  if p_type = 'http' then
    v_auth := substring(p_target from '^https?://([^/?#]*)');
    -- `monitor-input.ts` refuses credentials in the address, so a target with them is not ours.
    if v_auth is null or v_auth = '' or position('@' in v_auth) > 0 then
      return null;
    end if;
    v_host := case when v_auth like '[%' then substring(v_auth from '^\[([^\]]+)\]')
                   else regexp_replace(v_auth, ':[0-9]*$', '') end;
  elsif p_type = 'ssl' then
    v_host := p_target;
  elsif p_type = 'tcp' then
    if p_target !~ ':[0-9]{1,5}$' then
      return null;
    end if;
    v_host := regexp_replace(p_target, ':[0-9]{1,5}$', '');
  elsif p_type = 'dns' then
    v_host := regexp_replace(split_part(p_target, ' ', 2), '^(_[^.]*\.)+', '');
    if v_host !~ '^[a-z0-9.-]+$' then
      return null;
    end if;
  else
    return null;
  end if;

  v_host := lower(regexp_replace(v_host, '\.$', ''));
  return nullif(v_host, '');
end;
$fn$;

-- As 001's, with the host derived above: counted, stored and used for the
-- automatic SSL monitor. A caller's host that disagrees is refused.
create or replace function public.create_monitor(
  p_workspace_id             text,
  p_id                       text,
  p_app_id                   text,
  p_type                     text,
  p_name                     text,
  p_target                   text,
  p_target_host              text,
  p_interval_sec             integer,
  p_config                   jsonb,
  p_heartbeat_token_hash     text,
  p_secrets                  jsonb,
  p_max_monitors             integer,
  p_max_heartbeats           integer,
  p_max_assertions           integer,
  p_max_heartbeat_assertions integer,
  p_per_host                 integer,
  p_min_interval_sec         integer
)
returns public.monitors
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v          public.monitors;
  v_count    integer;
  v_asserts  integer;
  v_host     text;
begin
  if p_max_monitors is null or p_max_heartbeats is null or p_max_assertions is null
     or p_max_heartbeat_assertions is null or p_per_host is null or p_min_interval_sec is null then
    raise exception 'limits_required' using errcode = '22004';
  end if;

  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  -- Phase 1 builds these five. Stripe arrives with stage 3.3, MCP and Supabase
  -- after go live; until then the database refuses them as well as the screen.
  if p_type not in ('http', 'ssl', 'dns', 'tcp', 'heartbeat') then
    raise exception 'type_not_available' using errcode = 'P0001';
  end if;

  -- An http, ssl or tcp monitor always names a host; a dns one does when its owner is a plain name.
  v_host := public.monitor_target_host(p_type, p_target);
  if (v_host is null and p_type in ('http', 'ssl', 'tcp')) or p_target_host is distinct from v_host then
    raise exception 'host_mismatch' using errcode = 'P0001';
  end if;

  select count(*) into v_count from public.monitors where workspace_id = p_workspace_id and not auto;
  if v_count >= p_max_monitors then
    raise exception 'monitor_limit' using errcode = 'P0001';
  end if;

  if p_type = 'heartbeat' then
    select count(*) into v_count from public.monitors where workspace_id = p_workspace_id and type = 'heartbeat';
    if v_count >= p_max_heartbeats then
      raise exception 'heartbeat_limit' using errcode = 'P0001';
    end if;
  end if;

  v_asserts := case when jsonb_typeof(p_config -> 'assertions') = 'array'
                    then jsonb_array_length(p_config -> 'assertions') else 0 end;
  -- Parenthesised: PL/pgSQL reads an IF condition up to the first THEN, a CASE's included.
  if v_asserts > (case when p_type = 'heartbeat' then p_max_heartbeat_assertions else p_max_assertions end) then
    raise exception 'assertion_limit' using errcode = 'P0001';
  end if;

  if (p_type in ('http', 'tcp') and p_interval_sec < p_min_interval_sec)
     or (p_type = 'dns' and p_interval_sec < 600)
     or (p_type = 'ssl' and p_interval_sec <> 21600) then
    raise exception 'interval_not_allowed' using errcode = 'P0001';
  end if;

  if v_host is not null and p_type <> 'ssl' then
    select count(*) into v_count from public.monitors
     where workspace_id = p_workspace_id and target_host = v_host and type <> 'ssl';
    if v_count >= p_per_host then
      raise exception 'host_limit' using errcode = 'P0001';
    end if;
  end if;

  insert into public.monitors (id, workspace_id, app_id, type, name, target, target_host, interval_sec, config, heartbeat_token_hash)
  values (coalesce(p_id, public.new_id('mon')), p_workspace_id, p_app_id, p_type, btrim(p_name), p_target, v_host, p_interval_sec,
          coalesce(p_config, '{}'::jsonb), p_heartbeat_token_hash)
  returning * into v;

  if jsonb_typeof(p_secrets) = 'array' then
    insert into public.monitor_secrets (monitor_id, workspace_id, name, sealed)
    select v.id, p_workspace_id, s ->> 'name', s ->> 'sealed'
      from jsonb_array_elements(p_secrets) as s;
  end if;

  if p_type = 'http' and p_target ~* '^https://' and v_host is not null
     and v_host !~ '^[0-9.]+$' and position(':' in v_host) = 0
     and not exists (select 1 from public.monitors
                      where workspace_id = p_workspace_id and type = 'ssl' and target_host = v_host) then
    insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, auto)
    values (p_workspace_id, p_app_id, 'ssl', v_host, v_host, v_host, 21600, true);
  end if;

  return v;
end;
$fn$;

-- ── grants (`§ 1.4`) ─────────────────────────────────────────────────────────

revoke all on function public.monitor_target_host(text, text) from public, anon, authenticated;
revoke all on function public.create_monitor(text, text, text, text, text, text, text, integer, jsonb, text, jsonb, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;

grant execute on function public.monitor_target_host(text, text) to service_role;
grant execute on function public.create_monitor(text, text, text, text, text, text, text, integer, jsonb, text, jsonb, integer, integer, integer, integer, integer, integer)
  to service_role;

-- The global default, for every schema the migration role creates functions in.
alter default privileges revoke execute on functions from public;
