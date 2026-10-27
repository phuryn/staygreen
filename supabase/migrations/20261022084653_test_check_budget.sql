-- 011: the product's first per-actor budget, for testing a monitor before saving it.
--
-- A test makes the dashboard's server fetch a public address now and show what came back
-- (`docs/flows.md § Testing a monitor`), so without a ceiling it is a free proxy. Each member, and
-- each workspace, gets a number of tests per window (`src/lib/budgets.ts` holds the numbers,
-- `docs/architecture.md § Rate limits` says why). They are counted here, not in memory, because
-- the dashboard runs as serverless functions and an instance's memory counts only that instance.
--
-- One row per workspace, action and actor, rewritten in place: a fixed window that starts with
-- its first use, and a count inside it. A test writes nothing else (`AGENTS.md § 2.8`: no row per
-- check), and the table holds at most one row per member who has tested, plus one for the
-- workspace. The actor is the Clerk user id, as `incident_notes.author_user_id` holds it, or
-- 'workspace' for the shared count.
--
-- Idempotent, and never edited after it is applied.

create table if not exists public.budgets (
  workspace_id      text not null references public.workspaces (id) on delete cascade,
  action            text not null check (action in ('test_check')),
  actor             text not null check (actor = 'workspace' or actor ~ '^user_[A-Za-z0-9]{1,64}$'),
  window_started_at timestamptz not null,
  used              integer not null check (used >= 0),
  primary key (workspace_id, action, actor)
);

alter table public.budgets enable row level security;
revoke all on public.budgets from public, anon, authenticated;
grant select, insert, update, delete on public.budgets to service_role;

-- Spends one use of `p_action` for the member and for their workspace, or neither. Both counts
-- are judged with both rows locked, the workspace's first and then the member's (the lock order
-- of `docs/architecture.md`), so concurrent tests in one workspace spend one at a time and the
-- last allowed use has exactly one winner. A refusal spends nothing (a first use still leaves its
-- rows at zero) and says which count ran out and in how many seconds it starts again; when both
-- did, the later of the two.
--
-- The limits are the caller's (`AGENTS.md § 1.1`: a missing quota is an error, never an
-- entitlement): a null limit or window, or a window under a second, is refused.
create or replace function public.spend_budget(
  p_workspace_id          text,
  p_action                text,
  p_user_id               text,
  p_member_limit          integer,
  p_member_window_sec     integer,
  p_workspace_limit       integer,
  p_workspace_window_sec  integer
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_now      timestamptz := now();
  v_ws       public.budgets;
  v_mem      public.budgets;
  v_ws_end   timestamptz;
  v_mem_end  timestamptz;
  v_scope    text;
  v_until    timestamptz;
begin
  if p_member_limit is null or p_member_window_sec is null or p_workspace_limit is null or p_workspace_window_sec is null
     or p_member_window_sec < 1 or p_workspace_window_sec < 1 then
    raise exception 'limits_required' using errcode = '22004';
  end if;
  -- The table's check would admit 'workspace' as a member, which would count one row twice.
  if p_user_id is null or p_user_id !~ '^user_[A-Za-z0-9]{1,64}$' then
    raise exception 'invalid_actor' using errcode = '22023';
  end if;

  perform 1 from public.workspaces where id = p_workspace_id;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  -- A first use makes both rows; the checks on `action` and `actor` refuse anything else.
  insert into public.budgets (workspace_id, action, actor, window_started_at, used)
  values (p_workspace_id, p_action, 'workspace', v_now, 0),
         (p_workspace_id, p_action, p_user_id, v_now, 0)
  on conflict (workspace_id, action, actor) do nothing;

  select * into v_ws from public.budgets
   where workspace_id = p_workspace_id and action = p_action and actor = 'workspace'
     for update;
  select * into v_mem from public.budgets
   where workspace_id = p_workspace_id and action = p_action and actor = p_user_id
     for update;

  v_ws_end  := v_ws.window_started_at + make_interval(secs => p_workspace_window_sec);
  v_mem_end := v_mem.window_started_at + make_interval(secs => p_member_window_sec);

  -- A window whose end has passed counts nothing.
  if v_mem_end > v_now and v_mem.used >= p_member_limit then
    v_scope := 'member';
    v_until := v_mem_end;
  end if;
  if v_ws_end > v_now and v_ws.used >= p_workspace_limit and (v_until is null or v_ws_end > v_until) then
    v_scope := 'workspace';
    v_until := v_ws_end;
  end if;
  if v_scope is not null then
    return jsonb_build_object(
      'ok', false,
      'scope', v_scope,
      'retryAfterSec', greatest(1, ceil(extract(epoch from (v_until - v_now))))::integer
    );
  end if;

  update public.budgets
     set window_started_at = case when v_ws_end <= v_now then v_now else window_started_at end,
         used              = case when v_ws_end <= v_now then 1 else used + 1 end
   where workspace_id = p_workspace_id and action = p_action and actor = 'workspace';
  update public.budgets
     set window_started_at = case when v_mem_end <= v_now then v_now else window_started_at end,
         used              = case when v_mem_end <= v_now then 1 else used + 1 end
   where workspace_id = p_workspace_id and action = p_action and actor = p_user_id;

  return jsonb_build_object('ok', true);
end;
$fn$;

revoke all on function public.spend_budget(text, text, text, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.spend_budget(text, text, text, integer, integer, integer, integer) to service_role;
