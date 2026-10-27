-- 007 · Phase 1: no automatic SSL monitor outlives the last HTTP monitor on its host.
--
-- Two ways one could be left behind, both found writing the lock order down
-- (`docs/architecture.md § Data and invariants`):
--
-- 1. `delete_app` (005) deletes the app's HTTP monitors by cascade, but the
--    host's automatic SSL monitor can belong to another app: the one whose
--    HTTPS monitor came first and has since moved to another host. Nothing
--    removed that one when this app's monitors were the last on the host.
-- 2. `delete_monitor` (001) took no workspace lock. Two deletes of a host's
--    last two HTTP monitors, or a delete beside `update_monitor` moving the
--    other one away, each saw the other still there, and both kept the SSL
--    monitor.
--
-- Both now lock the workspace row first, as `create_monitor` and
-- `update_monitor` do, so a workspace's per-host decisions run one at a time,
-- and the lock order stays top-down: the workspace, then the app or monitor.
-- `delete_app` then removes every automatic SSL monitor left with no HTTP
-- monitor on its host. Any such monitor already stored goes now.
--
-- Idempotent, and never edited after it is applied.

delete from public.monitors m
 where m.type = 'ssl' and m.auto
   and not exists (select 1 from public.monitors h
                    where h.workspace_id = m.workspace_id and h.type = 'http' and h.target_host = m.target_host);

-- Delete a monitor, and the host's automatic SSL monitor with its last HTTP one.
create or replace function public.delete_monitor(p_workspace_id text, p_monitor_id text)
returns void
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_type text;
  v_host text;
begin
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  delete from public.monitors
   where id = p_monitor_id and workspace_id = p_workspace_id
  returning type, target_host into v_type, v_host;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  if v_type = 'http' and v_host is not null then
    delete from public.monitors m
     where m.workspace_id = p_workspace_id and m.type = 'ssl' and m.auto and m.target_host = v_host
       and not exists (select 1 from public.monitors h
                        where h.workspace_id = p_workspace_id and h.type = 'http' and h.target_host = v_host);
  end if;
end;
$fn$;

-- Delete an app with everything under it. An automatic SSL monitor it owns moves
-- to another app still watching the host over HTTP; one it leaves with no HTTP
-- monitor on its host goes, whichever app owns it.
create or replace function public.delete_app(p_workspace_id text, p_app_id text)
returns void
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  perform 1 from public.apps where id = p_app_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  update public.monitors m
     set app_id = (select h.app_id from public.monitors h
                    where h.workspace_id = p_workspace_id and h.type = 'http'
                      and h.target_host = m.target_host and h.app_id <> p_app_id
                    order by h.created_at limit 1),
         updated_at = now()
   where m.workspace_id = p_workspace_id and m.app_id = p_app_id and m.type = 'ssl' and m.auto
     and exists (select 1 from public.monitors h
                  where h.workspace_id = p_workspace_id and h.type = 'http'
                    and h.target_host = m.target_host and h.app_id <> p_app_id);

  delete from public.apps where id = p_app_id and workspace_id = p_workspace_id;

  delete from public.monitors m
   where m.workspace_id = p_workspace_id and m.type = 'ssl' and m.auto
     and not exists (select 1 from public.monitors h
                      where h.workspace_id = p_workspace_id and h.type = 'http' and h.target_host = m.target_host);
end;
$fn$;

-- ── grants (`§ 1.4`) ─────────────────────────────────────────────────────────

revoke all on function public.delete_monitor(text, text) from public, anon, authenticated;
grant execute on function public.delete_monitor(text, text) to service_role;
revoke all on function public.delete_app(text, text) from public, anon, authenticated;
grant execute on function public.delete_app(text, text) to service_role;
