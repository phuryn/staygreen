-- The plan a workspace's members last showed with a verified session, so a probe, which has no
-- session to ask Clerk with, can tell a Builder monitor from a Free one: only Builder monitors are
-- checked from Builder's third location (Frankfurt, `probe/schedule.ts`). The dashboard writes it
-- when Clerk's `has` disagrees with it (`src/lib/workspace.ts`). Nothing reads it for what a
-- member may do, which always comes from the session (`AGENTS.md § 1.1`).
alter table public.workspaces add column plan text not null default 'free' check (plan in ('free', 'builder'));

-- Which of these workspaces are on Builder: the probe's only read of a plan.
create or replace function public.probe_builder_workspaces(p_workspaces text[])
returns table (workspace_id text)
language sql stable security definer set search_path = '' as $fn$
  select w.id from public.workspaces w
  where w.plan = 'builder' and (p_workspaces is null or w.id = any(p_workspaces));
$fn$;

revoke all on function public.probe_builder_workspaces(text[]) from public, anon, authenticated, service_role;
grant execute on function public.probe_builder_workspaces(text[]) to probe;
