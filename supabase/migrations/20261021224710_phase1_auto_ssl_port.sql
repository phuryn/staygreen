-- 004 · Phase 1: no automatic SSL monitor for an HTTPS address with its own port.
--
-- `create_monitor` gave `https://api.example.com:8443/` an automatic SSL monitor
-- on api.example.com, which checks port 443: a certificate the monitor's own
-- address never serves, and an alert for a port nobody uses. Otherwise as 003.
--
-- Idempotent, and never edited after it is applied.

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

  -- An address with its own port serves its certificate there, not on 443, where
  -- the SSL monitor looks; `URL` drops a written `:443`, so any port left is another.
  if p_type = 'http' and p_target ~* '^https://' and v_host is not null
     and v_host !~ '^[0-9.]+$' and position(':' in v_host) = 0
     and substring(p_target from '^https://([^/?#]*)') !~ ':[0-9]+$'
     and not exists (select 1 from public.monitors
                      where workspace_id = p_workspace_id and type = 'ssl' and target_host = v_host) then
    insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, auto)
    values (p_workspace_id, p_app_id, 'ssl', v_host, v_host, v_host, 21600, true);
  end if;

  return v;
end;
$fn$;

-- ── grants (`§ 1.4`) ─────────────────────────────────────────────────────────

revoke all on function public.create_monitor(text, text, text, text, text, text, text, integer, jsonb, text, jsonb, integer, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.create_monitor(text, text, text, text, text, text, text, integer, jsonb, text, jsonb, integer, integer, integer, integer, integer, integer)
  to service_role;
