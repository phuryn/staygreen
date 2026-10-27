-- 010: changing a monitor's address closes its open incident.
--
-- `update_monitor` (005) clears a monitor's state when its target changes. It left an open incident
-- open, so the monitor read as never checked while an incident about its old address stayed open:
-- nothing would close that incident on the spec's two passes, and the new address's first
-- confirmed failure was folded into it, old evidence and all. The function is replaced whole, with
-- the same parameters, so the deployed dashboard's call keeps working while this applies.
--
-- Idempotent, and never edited after it is applied.

create or replace function public.update_monitor(
  p_workspace_id             text,
  p_monitor_id               text,
  p_name                     text,
  p_target                   text,
  p_target_host              text,
  p_interval_sec             integer,
  p_config                   jsonb,
  p_secrets                  jsonb,
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
  v         public.monitors;
  v_old     public.monitors;
  v_count   integer;
  v_asserts integer;
  v_host    text;
begin
  if p_max_assertions is null or p_max_heartbeat_assertions is null
     or p_per_host is null or p_min_interval_sec is null then
    raise exception 'limits_required' using errcode = '22004';
  end if;

  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  select * into v_old from public.monitors
   where id = p_monitor_id and workspace_id = p_workspace_id
     for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  if v_old.auto then
    raise exception 'auto_monitor' using errcode = 'P0001';
  end if;
  if v_old.type not in ('http', 'ssl', 'dns', 'tcp', 'heartbeat') then
    raise exception 'type_not_available' using errcode = 'P0001';
  end if;

  v_host := public.monitor_target_host(v_old.type, p_target);
  if (v_host is null and v_old.type in ('http', 'ssl', 'tcp')) or p_target_host is distinct from v_host then
    raise exception 'host_mismatch' using errcode = 'P0001';
  end if;

  v_asserts := case when jsonb_typeof(p_config -> 'assertions') = 'array'
                    then jsonb_array_length(p_config -> 'assertions') else 0 end;
  if v_asserts > (case when v_old.type = 'heartbeat' then p_max_heartbeat_assertions else p_max_assertions end) then
    raise exception 'assertion_limit' using errcode = 'P0001';
  end if;

  if (v_old.type in ('http', 'tcp') and p_interval_sec < p_min_interval_sec)
     or (v_old.type = 'dns' and p_interval_sec < 600)
     or (v_old.type = 'ssl' and p_interval_sec <> 21600) then
    raise exception 'interval_not_allowed' using errcode = 'P0001';
  end if;

  if v_host is not null and v_old.type <> 'ssl' and v_host is distinct from v_old.target_host then
    select count(*) into v_count from public.monitors
     where workspace_id = p_workspace_id and target_host = v_host and type <> 'ssl' and id <> p_monitor_id;
    if v_count >= p_per_host then
      raise exception 'host_limit' using errcode = 'P0001';
    end if;
  end if;

  update public.monitors
     set name         = btrim(p_name),
         target       = p_target,
         target_host  = v_host,
         interval_sec = p_interval_sec,
         config       = coalesce(p_config, '{}'::jsonb),
         state        = case when p_target is distinct from v_old.target then null else state end,
         state_since  = case when p_target is distinct from v_old.target then null else state_since end,
         updated_at   = now()
   where id = p_monitor_id and workspace_id = p_workspace_id
  returning * into v;

  -- The old address's incident ends with it: it describes an address nobody checks any more, and
  -- the state cleared above says nothing is known about the new one. A confirmed failure of the
  -- new address opens its own incident, with its own evidence. Without this the probe would meet
  -- a monitor with no state and an incident open, and could neither close it on the spec's two
  -- passes nor give a new failure its own incident (`probe/store.ts`).
  if p_target is distinct from v_old.target then
    update public.incidents
       set resolved_at = greatest(now(), opened_at),
           timeline = timeline || jsonb_build_array(jsonb_build_object('t', now(), 'text', 'Address changed, incident closed'))
     where monitor_id = p_monitor_id and workspace_id = p_workspace_id and resolved_at is null;
  end if;

  if jsonb_typeof(p_secrets) = 'array' then
    delete from public.monitor_secrets where monitor_id = p_monitor_id and workspace_id = p_workspace_id;
    insert into public.monitor_secrets (monitor_id, workspace_id, name, sealed)
    select p_monitor_id, p_workspace_id, s ->> 'name', s ->> 'sealed'
      from jsonb_array_elements(p_secrets) as s;
  end if;

  if v_old.type = 'http' then
    if v_old.target_host is not null and v_old.target_host is distinct from v_host then
      delete from public.monitors m
       where m.workspace_id = p_workspace_id and m.type = 'ssl' and m.auto and m.target_host = v_old.target_host
         and not exists (select 1 from public.monitors h
                          where h.workspace_id = p_workspace_id and h.type = 'http' and h.target_host = v_old.target_host);
    end if;

    -- As `create_monitor` (004): an address with its own port serves its certificate there.
    if p_target ~* '^https://' and v_host is not null
       and v_host !~ '^[0-9.]+$' and position(':' in v_host) = 0
       and substring(p_target from '^https://([^/?#]*)') !~ ':[0-9]+$'
       and not exists (select 1 from public.monitors
                        where workspace_id = p_workspace_id and type = 'ssl' and target_host = v_host) then
      insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, auto)
      values (p_workspace_id, v_old.app_id, 'ssl', v_host, v_host, v_host, 21600, true);
    end if;
  end if;

  return v;
end;
$fn$;
