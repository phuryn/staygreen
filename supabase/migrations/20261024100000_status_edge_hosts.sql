-- Configurable claim targets. Apply before the app starts supplying p_cname_target.
-- No rows or the production column default change; old three-argument callers still work.
begin;
alter table public.page_domains drop constraint if exists page_domains_cname_target_check;
alter table public.page_domains add constraint page_domains_cname_target_check check (
  char_length(cname_target) <= 253 and
  cname_target ~ '^[a-f0-9]{32}\.([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
);
drop function if exists public.reserve_page_domain(text,text,text);
create or replace function public.reserve_page_domain(p_workspace_id text,p_page_id text,p_host text,p_cname_target text default null)
returns public.page_domains language plpgsql security invoker set search_path='' as $fn$
declare v public.page_domains;
begin
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not exists(select 1 from public.status_pages where id=p_page_id and workspace_id=p_workspace_id and not members_only) then
    raise exception 'not_found' using errcode='PT404'; end if;
  delete from public.page_domains where verified_at is null and created_at <= now()-interval '7 days';
  select * into v from public.page_domains where page_id=p_page_id;
  if v.host=p_host then return v; end if;
  if (select count(*) from public.page_domains where workspace_id=p_workspace_id and verified_at is null and page_id<>p_page_id)>=3 then
    raise exception 'pending_domain_limit' using errcode='P0001'; end if;
  -- Never reset an existing verified domain implicitly; remove it explicitly first.
  if v.host is not null then raise exception 'domain_exists' using errcode='P0001'; end if;
  -- Old callers retain 029's production default during the deployment window.
  -- Existing claims returned above never acquire a new target when configuration changes.
  if p_cname_target is null then
    insert into public.page_domains(host,workspace_id,page_id) values(p_host,p_workspace_id,p_page_id) returning * into v;
  else
    insert into public.page_domains(host,workspace_id,page_id,cname_target)
      values(p_host,p_workspace_id,p_page_id,p_cname_target) returning * into v;
  end if;
  return v;
end $fn$;

revoke all on function public.reserve_page_domain(text,text,text,text) from public,anon,authenticated,probe,ingest,watchdog,alert_sender,edge;
grant execute on function public.reserve_page_domain(text,text,text,text) to service_role;
commit;
