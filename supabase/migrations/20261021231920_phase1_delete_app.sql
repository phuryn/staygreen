-- 005 · Phase 1: deleting an app.
--
-- An app's monitors, status pages, incidents and notes go with it (every
-- foreign key cascades). One thing must not: the automatic SSL monitor is one
-- per host per workspace, so it belongs to whichever app's HTTPS monitor came
-- first. When another app still watches that host over HTTP, the SSL monitor
-- moves to that app instead of being deleted with this one, the same rule
-- `delete_monitor` keeps for a single monitor.
--
-- Idempotent, and never edited after it is applied.

create or replace function public.delete_app(p_workspace_id text, p_app_id text)
returns void
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
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
end;
$fn$;

-- ── grants (`§ 1.4`) ─────────────────────────────────────────────────────────

revoke all on function public.delete_app(text, text) from public, anon, authenticated;
grant execute on function public.delete_app(text, text) to service_role;
