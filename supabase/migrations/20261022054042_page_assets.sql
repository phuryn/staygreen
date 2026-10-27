-- 009: bounded raster assets owned by a status page. Keeping the bytes in the row makes
-- replacement and cascading deletion atomic: there is no bucket orphan or cleanup job.
create table if not exists public.page_assets (
  id text not null unique check (id ~ '^asset_[0-9a-f]{32}$'),
  workspace_id text not null,
  page_id text not null,
  kind text not null check (kind in ('logo', 'favicon')),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/vnd.microsoft.icon')),
  content bytea not null check (octet_length(content) between 1 and 524288),
  primary key (page_id, kind),
  check (mime <> 'image/vnd.microsoft.icon' or kind = 'favicon'),
  foreign key (page_id, workspace_id) references public.status_pages (id, workspace_id) on delete cascade
);
create index if not exists page_assets_workspace_idx on public.page_assets (workspace_id);
alter table public.page_assets enable row level security;
revoke all on public.page_assets from public, anon, authenticated;
grant select, insert, update, delete on public.page_assets to service_role;

-- Same allowlist and pause-expiry semantics as 002; only the two image paths are added.
-- No bytea column, filename, workspace id or asset listing reaches the snapshot.
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
      'logoUrl', (select '/page-assets/' || a.id from public.page_assets a where a.page_id = p.id and a.kind = 'logo'),
      'faviconUrl', (select '/page-assets/' || a.id from public.page_assets a where a.page_id = p.id and a.kind = 'favicon'),
      'accent', p.accent, 'theme', p.theme, 'poweredBy', p.powered_by, 'noindex', p.noindex,
      'historyDays', p.history_days
    ),
    'components', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', c.position, 'name', c.name, 'inApp', c.in_app,
               'states', (select coalesce(jsonb_agg(
                                   case when m.paused_at is not null and (m.paused_until is null or m.paused_until > now())
                                        then 'paused' else m.state end), '[]'::jsonb)
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
revoke all on function public.public_status_snapshot(text) from public, anon, authenticated;
grant execute on function public.public_status_snapshot(text) to service_role;
