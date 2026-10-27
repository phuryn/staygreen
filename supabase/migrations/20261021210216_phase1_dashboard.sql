-- 001 · Phase 1: the dashboard and status pages on real data, no check engine.
--
-- Workspaces, apps, monitors and their sealed secrets, incidents and their
-- notes, status pages and their components (`docs/product/plan.md`, stages 1.3
-- to 1.5).
--
-- `AGENTS.md § 1.1`: everything hangs off a workspace, and `workspaces` is the
-- only table that holds a Clerk id. Every child carries its `workspace_id`, and
-- a composite foreign key ties it to its parent's, so a row can never point at
-- another workspace's row (a component bound to a stranger's monitor is a
-- foreign-key violation, not a bug to catch in a route).
-- `§ 1.4`: RLS on with zero policies on every table, grants revoked from
-- everyone but `service_role`; the tenant isolation is `src/lib/authz.ts`.
-- `§ 2.8`: plan limits are checked inside the function that creates the row,
-- with the workspace row locked, and a missing limit is refused, never read
-- as "no limit".
--
-- Idempotent, and never edited after it is applied.

-- ── ids ──────────────────────────────────────────────────────────────────────
-- Unguessable (`§ 1.1`): 96 random bits from two v4 UUIDs (their first twelve
-- hex digits are all random), behind a readable prefix.

create or replace function public.new_id(p_prefix text)
returns text
language sql
volatile
security invoker
set search_path = ''
as $fn$
  select p_prefix || '_'
    || substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12)
    || substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12)
$fn$;

-- ── workspaces ───────────────────────────────────────────────────────────────
-- One per Clerk organization (`§ 2.3`). No name: names are read from Clerk at
-- render time (`§ 1.5`).

create table if not exists public.workspaces (
  id           text primary key default public.new_id('ws'),
  clerk_org_id text not null unique check (clerk_org_id ~ '^org_[A-Za-z0-9]+$'),
  created_at   timestamptz not null default now()
);

-- ── apps ─────────────────────────────────────────────────────────────────────
-- A named group of monitors (askone, quizroom), with an optional status page.

create table if not exists public.apps (
  id           text primary key default public.new_id('app'),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 60),
  url          text check (url is null or (url ~ '^https?://' and char_length(url) <= 2048)),
  created_at   timestamptz not null default now(),
  unique (id, workspace_id)
);

create unique index if not exists apps_workspace_name_key on public.apps (workspace_id, lower(name));

-- ── monitors ─────────────────────────────────────────────────────────────────
-- `state` is null until the first check (`§ 2.8`: "Not checked yet"); Phase 1
-- has no engine, so it stays null. `config` holds the type's own settings
-- (method, expected status, assertions, schedule …), validated in
-- `src/lib/monitor-input.ts`. Secret header values never live here: they are
-- sealed into `monitor_secrets`. A heartbeat's URL token is stored as its
-- sha-256.

create table if not exists public.monitors (
  id                   text primary key default public.new_id('mon'),
  workspace_id         text not null references public.workspaces (id) on delete cascade,
  app_id               text not null,
  type                 text not null check (type in ('http', 'ssl', 'dns', 'tcp', 'heartbeat', 'stripe', 'mcp', 'supabase')),
  name                 text not null check (char_length(btrim(name)) between 1 and 80),
  target               text not null check (char_length(target) between 1 and 2048),
  target_host          text check (target_host is null or target_host ~ '^[a-z0-9.:-]{1,253}$'),
  interval_sec         integer not null check (interval_sec between 60 and 86400),
  config               jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  auto                 boolean not null default false,
  state                text check (state in ('up', 'degraded', 'down')),
  state_since          timestamptz,
  paused_at            timestamptz,
  paused_until         timestamptz,
  pause_reason         text check (pause_reason is null or char_length(pause_reason) <= 200),
  heartbeat_token_hash text unique check (heartbeat_token_hash is null or heartbeat_token_hash ~ '^[0-9a-f]{64}$'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (app_id, workspace_id) references public.apps (id, workspace_id) on delete cascade,
  constraint monitors_heartbeat_token check ((type = 'heartbeat') = (heartbeat_token_hash is not null)),
  constraint monitors_auto_is_ssl check (not auto or type = 'ssl'),
  constraint monitors_state_since check ((state is null) = (state_since is null)),
  constraint monitors_pause_window check (paused_until is null or (paused_at is not null and paused_until > paused_at))
);

create index if not exists monitors_workspace_idx on public.monitors (workspace_id, created_at);
create index if not exists monitors_app_idx on public.monitors (app_id);
create index if not exists monitors_host_idx on public.monitors (workspace_id, target_host) where target_host is not null;
-- One automatic SSL monitor per host per workspace (`spec.md § 3.2`).
create unique index if not exists monitors_one_auto_ssl_per_host
  on public.monitors (workspace_id, target_host) where type = 'ssl' and auto;

-- Sealed with AES-256-GCM by `src/lib/credentials.ts`, the row's identity as
-- additional data. Never returned to a screen; deleted with the monitor.
create table if not exists public.monitor_secrets (
  monitor_id   text not null,
  workspace_id text not null,
  name         text not null check (name ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,64}$'),
  sealed       text not null check (sealed ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' and char_length(sealed) <= 8192),
  created_at   timestamptz not null default now(),
  primary key (monitor_id, name),
  foreign key (monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete cascade
);

-- ── incidents and notes ──────────────────────────────────────────────────────
-- At most one open incident per monitor is an index (`§ 2.8`). Phase 1 inserts
-- them only from the development seed; Phase 2's engine opens and closes them.

create table if not exists public.incidents (
  id           text primary key default public.new_id('inc'),
  workspace_id text not null,
  monitor_id   text not null,
  title        text not null check (char_length(btrim(title)) between 1 and 200),
  severity     text not null check (severity in ('down', 'degraded')),
  opened_at    timestamptz not null default now(),
  resolved_at  timestamptz,
  acked_at     timestamptz,
  evidence     jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  timeline     jsonb not null default '[]'::jsonb check (jsonb_typeof(timeline) = 'array'),
  unique (id, workspace_id),
  foreign key (monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete cascade,
  constraint incidents_resolved_after_open check (resolved_at is null or resolved_at >= opened_at)
);

create unique index if not exists incidents_one_open_per_monitor on public.incidents (monitor_id) where resolved_at is null;
create index if not exists incidents_workspace_idx on public.incidents (workspace_id, opened_at desc);

-- A note is a draft until published, and a draft never reaches a public
-- surface (`§ 2.8`). The author is a Clerk user id, or the client name of an
-- agent or the seed; the person's name is read from Clerk at render time.
create table if not exists public.incident_notes (
  id             text primary key default public.new_id('note'),
  workspace_id   text not null,
  incident_id    text not null,
  state          text not null check (state in ('investigating', 'identified', 'monitoring', 'resolved')),
  body           text not null check (char_length(btrim(body)) between 1 and 5000),
  status         text not null default 'draft' check (status in ('draft', 'published')),
  author_user_id text check (author_user_id is null or author_user_id ~ '^user_[A-Za-z0-9]+$'),
  author_client  text check (author_client is null or char_length(author_client) between 1 and 60),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  published_at   timestamptz,
  foreign key (incident_id, workspace_id) references public.incidents (id, workspace_id) on delete cascade,
  constraint incident_notes_published_at check ((status = 'published') = (published_at is not null)),
  constraint incident_notes_author check (author_user_id is not null or author_client is not null)
);

create index if not exists incident_notes_incident_idx on public.incident_notes (incident_id, created_at);

-- ── status pages ─────────────────────────────────────────────────────────────
-- One per app at most. Slugs are unique across every workspace (`§ 2.8`),
-- because each becomes `<slug>.staygreen.page`; the reserved ones are names
-- Staygreen's own hosts use. The accent default is the brand's cobalt, the one
-- colour literal outside `design/tokens.css`, because it is data a builder
-- overwrites, not a style.

create table if not exists public.status_pages (
  id           text primary key default public.new_id('page'),
  workspace_id text not null,
  app_id       text not null unique,
  slug         text not null unique check (
                 slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'
                 and slug not in ('www', 'api', 'app', 'admin', 'domains', 'edge', 'in', 'mail', 'mcp', 'status', 'staygreen', 'help', 'docs')
               ),
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  logo_text    text not null default '' check (char_length(logo_text) <= 40),
  homepage     text check (homepage is null or (homepage ~ '^https?://' and char_length(homepage) <= 2048)),
  accent       text not null default '#1F2DE6' check (accent ~ '^#[0-9A-Fa-f]{6}$'),
  theme        text not null default 'visitor' check (theme in ('light', 'dark', 'visitor')),
  powered_by   boolean not null default true,
  noindex      boolean not null default false,
  history_days integer not null default 90 check (history_days in (30, 90)),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (app_id, workspace_id) references public.apps (id, workspace_id) on delete cascade
);

create index if not exists status_pages_workspace_idx on public.status_pages (workspace_id);

create table if not exists public.page_components (
  id           text primary key default public.new_id('cmp'),
  workspace_id text not null,
  page_id      text not null,
  name         text not null check (char_length(btrim(name)) between 1 and 80),
  position     integer not null check (position between 0 and 49),
  in_app       boolean not null default false,
  unique (id, workspace_id),
  unique (page_id, position),
  foreign key (page_id, workspace_id) references public.status_pages (id, workspace_id) on delete cascade
);

-- A monitor bound to no component is private: it never reaches a public
-- surface (`spec.md § 6`).
create table if not exists public.component_monitors (
  component_id text not null,
  monitor_id   text not null,
  workspace_id text not null,
  primary key (component_id, monitor_id),
  foreign key (component_id, workspace_id) references public.page_components (id, workspace_id) on delete cascade,
  foreign key (monitor_id, workspace_id) references public.monitors (id, workspace_id) on delete cascade
);

create index if not exists component_monitors_monitor_idx on public.component_monitors (monitor_id);

-- ── RLS: on, with zero policies, everywhere (`§ 1.4`) ────────────────────────

alter table public.workspaces         enable row level security;
alter table public.apps               enable row level security;
alter table public.monitors           enable row level security;
alter table public.monitor_secrets    enable row level security;
alter table public.incidents          enable row level security;
alter table public.incident_notes     enable row level security;
alter table public.status_pages       enable row level security;
alter table public.page_components    enable row level security;
alter table public.component_monitors enable row level security;

-- ── functions ────────────────────────────────────────────────────────────────
-- Every one `security invoker` with an empty search path. Errors are raised
-- with a machine message that `src/lib/db-errors.ts` turns into words; a row
-- that is missing or belongs to another workspace is the same `PT404`
-- (`§ 1.1`: not-found and not-owned are one answer).

-- The workspace for an organization, created on its first member visit.
create or replace function public.ensure_workspace(p_clerk_org_id text)
returns public.workspaces
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v public.workspaces;
begin
  if p_clerk_org_id is null then
    raise exception 'organization_required' using errcode = '22004';
  end if;
  select * into v from public.workspaces where clerk_org_id = p_clerk_org_id;
  if found then
    return v;
  end if;
  insert into public.workspaces (clerk_org_id) values (p_clerk_org_id)
    on conflict (clerk_org_id) do nothing;
  select * into v from public.workspaces where clerk_org_id = p_clerk_org_id;
  return v;
end;
$fn$;

-- Create a monitor. The limits come from the caller's plan (`src/lib/plans.ts`
-- through the session); the counting happens here, with the workspace locked,
-- so two creates at once cannot both pass it. An HTTPS monitor on a named host
-- also gets the host's automatic SSL monitor, once per host, which counts
-- against neither the monitor nor the per-host limit.
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

  if p_target_host is not null and p_type <> 'ssl' then
    select count(*) into v_count from public.monitors
     where workspace_id = p_workspace_id and target_host = p_target_host and type <> 'ssl';
    if v_count >= p_per_host then
      raise exception 'host_limit' using errcode = 'P0001';
    end if;
  end if;

  insert into public.monitors (id, workspace_id, app_id, type, name, target, target_host, interval_sec, config, heartbeat_token_hash)
  values (coalesce(p_id, public.new_id('mon')), p_workspace_id, p_app_id, p_type, btrim(p_name), p_target, p_target_host, p_interval_sec,
          coalesce(p_config, '{}'::jsonb), p_heartbeat_token_hash)
  returning * into v;

  if jsonb_typeof(p_secrets) = 'array' then
    insert into public.monitor_secrets (monitor_id, workspace_id, name, sealed)
    select v.id, p_workspace_id, s ->> 'name', s ->> 'sealed'
      from jsonb_array_elements(p_secrets) as s;
  end if;

  if p_type = 'http' and p_target ~* '^https://' and p_target_host is not null
     and p_target_host !~ '^[0-9.]+$' and position(':' in p_target_host) = 0
     and not exists (select 1 from public.monitors
                      where workspace_id = p_workspace_id and type = 'ssl' and target_host = p_target_host) then
    insert into public.monitors (workspace_id, app_id, type, name, target, target_host, interval_sec, auto)
    values (p_workspace_id, p_app_id, 'ssl', p_target_host, p_target_host, p_target_host, 21600, true);
  end if;

  return v;
end;
$fn$;

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

-- Create a status page, counted against the plan with the workspace locked.
create or replace function public.create_status_page(
  p_workspace_id text,
  p_app_id       text,
  p_slug         text,
  p_name         text,
  p_logo_text    text,
  p_homepage     text,
  p_max_pages    integer
)
returns public.status_pages
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v       public.status_pages;
  v_count integer;
begin
  if p_max_pages is null then
    raise exception 'limits_required' using errcode = '22004';
  end if;

  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  select count(*) into v_count from public.status_pages where workspace_id = p_workspace_id;
  if v_count >= p_max_pages then
    raise exception 'page_limit' using errcode = 'P0001';
  end if;

  insert into public.status_pages (workspace_id, app_id, slug, name, logo_text, homepage)
  values (p_workspace_id, p_app_id, p_slug, btrim(p_name), coalesce(p_logo_text, ''), p_homepage)
  returning * into v;

  return v;
end;
$fn$;

-- Save a status page and its components in one transaction. The components are
-- replaced wholesale (`[{name, inApp, monitorIds}]`, in order). The two Builder
-- switches are refused without the feature that unlocks them; the features come
-- from the session, and a missing one is refused rather than read as false.
create or replace function public.save_status_page(
  p_workspace_id  text,
  p_page_id       text,
  p_slug          text,
  p_name          text,
  p_logo_text     text,
  p_homepage      text,
  p_accent        text,
  p_theme         text,
  p_powered_by    boolean,
  p_noindex       boolean,
  p_history_days  integer,
  p_components    jsonb,
  p_white_label   boolean,
  p_private_pages boolean
)
returns public.status_pages
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v           public.status_pages;
  v_component jsonb;
  v_position  integer := 0;
  v_cmp_id    text;
begin
  if p_white_label is null or p_private_pages is null then
    raise exception 'limits_required' using errcode = '22004';
  end if;
  if not p_powered_by and not p_white_label then
    raise exception 'white_label_required' using errcode = 'P0001';
  end if;
  if p_noindex and not p_private_pages then
    raise exception 'private_pages_required' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_components) is distinct from 'array' or jsonb_array_length(p_components) > 50 then
    raise exception 'components_invalid' using errcode = 'P0001';
  end if;

  update public.status_pages
     set slug = p_slug, name = btrim(p_name), logo_text = coalesce(p_logo_text, ''), homepage = p_homepage,
         accent = p_accent, theme = p_theme, powered_by = p_powered_by, noindex = p_noindex,
         history_days = p_history_days, updated_at = now()
   where id = p_page_id and workspace_id = p_workspace_id
  returning * into v;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  delete from public.page_components where page_id = p_page_id;

  for v_component in select * from jsonb_array_elements(p_components) loop
    insert into public.page_components (workspace_id, page_id, name, position, in_app)
    values (p_workspace_id, p_page_id, btrim(v_component ->> 'name'), v_position,
            coalesce((v_component ->> 'inApp')::boolean, false))
    returning id into v_cmp_id;

    if jsonb_typeof(v_component -> 'monitorIds') = 'array' then
      -- The composite foreign key refuses a monitor of another workspace.
      insert into public.component_monitors (component_id, monitor_id, workspace_id)
      select distinct v_cmp_id, m, p_workspace_id
        from jsonb_array_elements_text(v_component -> 'monitorIds') as m;
    end if;

    v_position := v_position + 1;
  end loop;

  return v;
end;
$fn$;

-- Write a note: a new draft, an edit, or a publish. A published note stays
-- published, and changing one is itself a publish, so a caller allowed only to
-- draft (`incidents:draft`, an agent in Phase 3) can never alter public text.
create or replace function public.save_incident_note(
  p_workspace_id   text,
  p_incident_id    text,
  p_note_id        text,
  p_state          text,
  p_body           text,
  p_publish        boolean,
  p_author_user_id text,
  p_author_client  text
)
returns public.incident_notes
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v public.incident_notes;
begin
  if p_publish is null then
    raise exception 'publish_required' using errcode = '22004';
  end if;

  perform 1 from public.incidents where id = p_incident_id and workspace_id = p_workspace_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;

  if p_note_id is null then
    insert into public.incident_notes (workspace_id, incident_id, state, body, status, author_user_id, author_client, published_at)
    values (p_workspace_id, p_incident_id, p_state, btrim(p_body),
            case when p_publish then 'published' else 'draft' end,
            p_author_user_id, p_author_client,
            case when p_publish then now() end)
    returning * into v;
  else
    select * into v from public.incident_notes
     where id = p_note_id and incident_id = p_incident_id and workspace_id = p_workspace_id
       for update;
    if not found then
      raise exception 'not_found' using errcode = 'PT404';
    end if;
    if v.status = 'published' and not p_publish then
      raise exception 'note_published' using errcode = 'P0001';
    end if;

    update public.incident_notes
       set state = p_state, body = btrim(p_body), updated_at = now(),
           status = case when p_publish then 'published' else status end,
           published_at = case when p_publish then coalesce(published_at, now()) else published_at end
     where id = p_note_id
    returning * into v;
  end if;

  if p_publish then
    update public.incidents
       set timeline = timeline || jsonb_build_array(jsonb_build_object('t', now(), 'text', 'Update published: ' || p_state))
     where id = p_incident_id;
  end if;

  return v;
end;
$fn$;

-- ── the public surfaces ──────────────────────────────────────────────────────
-- What a status page shows, built from an allowlist: names, states and
-- published notes. No monitor id, name, target or config, and nothing from a
-- monitor bound to no component of the page. `src/lib/public-page.ts` maps it
-- to the DTO the page renders and the status edge (stage 3.2) will reuse.

create or replace function public.public_status_snapshot(p_slug text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select jsonb_build_object(
    'page', jsonb_build_object(
      'slug', p.slug, 'name', p.name, 'logoText', p.logo_text, 'homepage', p.homepage,
      'accent', p.accent, 'theme', p.theme, 'poweredBy', p.powered_by, 'noindex', p.noindex,
      'historyDays', p.history_days
    ),
    'components', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', c.position, 'name', c.name, 'inApp', c.in_app,
               'states', (select coalesce(jsonb_agg(case when m.paused_at is not null then 'paused' else m.state end), '[]'::jsonb)
                            from public.component_monitors cm
                            join public.monitors m on m.id = cm.monitor_id
                           where cm.component_id = c.id)
             ) order by c.position)
        from public.page_components c
       where c.page_id = p.id
         and exists (select 1 from public.component_monitors cm where cm.component_id = c.id)
    ), '[]'::jsonb),
    'incidents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'title', i.title, 'severity', i.severity,
               'openedAt', i.opened_at, 'resolvedAt', i.resolved_at,
               'components', (select jsonb_agg(c.position order by c.position)
                                from public.page_components c
                                join public.component_monitors cm on cm.component_id = c.id
                               where c.page_id = p.id and cm.monitor_id = i.monitor_id),
               'notes', (select jsonb_agg(jsonb_build_object('id', n.id, 'state', n.state, 'body', n.body, 'at', n.published_at)
                                          order by n.published_at desc)
                           from public.incident_notes n
                          where n.incident_id = i.id and n.status = 'published')
             ) order by i.opened_at desc)
        from public.incidents i
       where i.workspace_id = p.workspace_id
         and coalesce(i.resolved_at, now()) >= now() - make_interval(days => p.history_days)
         and exists (select 1 from public.incident_notes n where n.incident_id = i.id and n.status = 'published')
         and exists (select 1
                       from public.component_monitors cm
                       join public.page_components c on c.id = cm.component_id
                      where c.page_id = p.id and cm.monitor_id = i.monitor_id)
    ), '[]'::jsonb)
  )
  from public.status_pages p
  where p.slug = p_slug
$fn$;

-- One incident's public page: the same allowlist, and only for an incident a
-- status page shows (a published note, and a monitor bound to a component).
create or replace function public.public_incident(p_incident_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select public.public_status_snapshot(p.slug) || jsonb_build_object('incidentId', i.id)
    from public.incidents i
    join public.component_monitors cm on cm.monitor_id = i.monitor_id
    join public.page_components c on c.id = cm.component_id
    join public.status_pages p on p.id = c.page_id
   where i.id = p_incident_id
     and exists (select 1 from public.incident_notes n where n.incident_id = i.id and n.status = 'published')
   order by p.created_at
   limit 1
$fn$;

-- ── grants (`§ 1.4`) ─────────────────────────────────────────────────────────
-- Nothing for PUBLIC, `anon` or `authenticated`, on what exists now and on
-- what the migration role creates later. `service_role` (the secret key) is
-- the only client. `tests/integration/catalog.test.ts` enumerates the schema
-- and proves it.

revoke all on all tables    in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select, insert, update, delete on all tables in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public revoke all on tables    from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
