-- 016: Free has one app, and an app has a logo.
--
-- An app was a direct insert, counted against nothing (`addApp`). Free now includes one app and
-- Builder ten (`spec.md § 1`, `decisions.md` 2026-10-22), so creating one moves into a function
-- that counts the workspace's apps with the workspace row locked, as `create_monitor` and
-- `create_status_page` count theirs (`AGENTS.md § 2.8`). The limit arrives from the caller's plan
-- as `p_max_apps`, and a missing one is refused, never read as "no limit" (`AGENTS.md § 1.1`). A
-- workspace already past it keeps every app it has; it can't add another. Nothing here deletes.
--
-- The cost `AGENTS.md § 1.1` names: a limit of N is a counted check, not an index, so a direct
-- insert into `apps` is no longer refused by anything; every app the dashboard makes goes through
-- `create_app` (`docs/architecture.md § Data and invariants`).
--
-- An app's logo is stored as a status page's images are (009): the bytes in the row, a PNG or
-- WebP of the pixels only, at most one per app, deleted with it. The server checks and strips
-- what it stores (`storablePageAsset`, `src/lib/page-assets.ts`); the table holds the type and
-- the size a second time, for a write that skips the action.
--
-- Idempotent, and never edited after it is applied.

create table if not exists public.app_logos (
  id           text not null unique check (id ~ '^asset_[0-9a-f]{32}$'),
  workspace_id text not null,
  app_id       text not null primary key,
  mime         text not null check (mime in ('image/png', 'image/webp')),
  content      bytea not null check (octet_length(content) between 1 and 524288),
  created_at   timestamptz not null default now(),
  foreign key (app_id, workspace_id) references public.apps (id, workspace_id) on delete cascade
);

create index if not exists app_logos_workspace_idx on public.app_logos (workspace_id);

alter table public.app_logos enable row level security;
revoke all on public.app_logos from public, anon, authenticated;
grant select, insert, update, delete on public.app_logos to service_role;

-- Create an app, counted against the plan with the workspace locked. The name's uniqueness stays
-- the index's (`apps_workspace_name_key`), and its shape and the address's the table's checks.
create or replace function public.create_app(
  p_workspace_id text,
  p_name         text,
  p_url          text,
  p_max_apps     integer
)
returns public.apps
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v       public.apps;
  v_count integer;
begin
  if p_max_apps is null then
    raise exception 'limits_required' using errcode = '22004';
  end if;

  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  -- A workspace past the limit, from before it existed or from a lapsed Builder plan, keeps its
  -- apps: the count only refuses the next one.
  select count(*) into v_count from public.apps where workspace_id = p_workspace_id;
  if v_count >= p_max_apps then
    raise exception 'app_limit' using errcode = 'P0001';
  end if;

  insert into public.apps (workspace_id, name, url)
  values (p_workspace_id, btrim(p_name), nullif(btrim(coalesce(p_url, '')), ''))
  returning * into v;

  return v;
end;
$fn$;

-- ── grants (`§ 1.4`) ─────────────────────────────────────────────────────────

revoke all on function public.create_app(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.create_app(text, text, text, integer) to service_role;
