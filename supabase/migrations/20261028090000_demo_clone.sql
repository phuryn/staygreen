-- Demo publication and an atomic copy through the existing quota functions.
begin;

alter table public.status_pages add column if not exists demo boolean not null default false;
alter table public.status_pages drop constraint if exists status_pages_demo_public;
alter table public.status_pages add constraint status_pages_demo_public check (not (demo and members_only));

-- The clone action spends its own budget (5 per member, 20 per workspace a minute); the
-- action list is a check constraint, so a new action that isn't on it refuses every clone (review demo1).
alter table public.budgets drop constraint if exists budgets_action_check;
alter table public.budgets add constraint budgets_action_check check(action in ('test_check','alert_test','alert_confirm','domain_check','demo_clone'));

-- The only source read used by preview and copy. CASE keeps excluded monitors' target/config
-- out of the read. Secret presence uses only the FK, never a sealed column. Heartbeat's
-- separate sealed column needs no read: its type is excluded, and the table constraints
-- allow that column only on heartbeats. No whole monitor row is selected or serialized.
create or replace function public.demo_clone_source(p_slug text) returns jsonb
language sql stable security invoker set search_path = '' as $fn$
  select jsonb_build_object(
    'app', jsonb_build_object('id', a.id, 'name', a.name, 'url', a.url, 'accent', a.accent),
    'page', jsonb_build_object('id', p.id, 'name', p.name, 'logoText', p.logo_text,
      'homepage', p.homepage, 'accent', p.accent, 'theme', p.theme, 'historyDays', p.history_days),
    'components', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'inApp', c.in_app,
      'monitorIds', coalesce((select jsonb_agg(cm.monitor_id order by cm.monitor_id)
        from public.component_monitors cm where cm.component_id = c.id), '[]'::jsonb)) order by c.position)
      from public.page_components c where c.page_id = p.id), '[]'::jsonb),
    'monitors', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'type', m.type, 'name', m.name)
      || case when m.type in ('http','ssl','dns','tcp') then
        case when not exists(select 1 from public.monitor_secrets s where s.monitor_id = m.id) then
          jsonb_build_object('copyable', true, 'target', m.target, 'targetHost', m.target_host,
            'config', m.config)
        else jsonb_build_object('copyable', false) end
      else jsonb_build_object('copyable', false) end order by shown.position, m.id)
      from (select cm.monitor_id, min(c.position) as position from public.page_components c
        join public.component_monitors cm on cm.component_id = c.id where c.page_id = p.id
        group by cm.monitor_id) shown join public.monitors m on m.id = shown.monitor_id
      where m.workspace_id = p.workspace_id), '[]'::jsonb)
  ) from public.status_pages p join public.apps a on a.id = p.app_id and a.workspace_id = p.workspace_id
  where p.slug = p_slug and p.demo and not p.members_only and not p.edge_withdrawn;
$fn$;

create or replace function public.clone_demo_page(
  p_workspace_id text, p_source_slug text, p_slug text, p_max_apps integer, p_max_pages integer,
  p_max_monitors integer, p_max_assertions integer, p_per_host integer, p_http_interval_sec integer,
  p_white_label boolean
) returns jsonb language plpgsql security invoker set search_path = '' as $fn$
declare
  source jsonb; app public.apps; page public.status_pages; existing text;
  m jsonb; component jsonb; bindings jsonb; components jsonb := '[]'::jsonb;
  mapped jsonb := '{}'::jsonb; skipped jsonb := '[]'::jsonb; copied jsonb := '[]'::jsonb;
  new_monitor text; reason text;
begin
  if p_max_apps is null or p_max_pages is null or p_max_monitors is null or p_max_assertions is null
    or p_per_host is null or p_http_interval_sec is null or p_white_label is null then
    raise exception 'limits_required' using errcode = '22004';
  end if;
  perform 1 from public.workspaces where id = p_workspace_id for update;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  -- Hold visibility while copying assets in later statements. A private transition or demo
  -- withdrawal must wait until this transaction ends; otherwise a new private image could be
  -- read after the public metadata snapshot. Concurrent clones can share this lock.
  perform 1 from public.status_pages where slug = p_source_slug and demo and not members_only
    and not edge_withdrawn for share;
  if not found then raise exception 'not_found' using errcode = 'PT404'; end if;
  source := public.demo_clone_source(p_source_slug);
  if source is null then raise exception 'not_found' using errcode = 'PT404'; end if;
  -- Check the unique name before the quota function so a retry links to its copy even on Free.
  select id into existing from public.apps where workspace_id = p_workspace_id
    and lower(name) = lower(source->'app'->>'name');
  if found then return jsonb_build_object('duplicateAppId', existing); end if;

  select * into app from public.create_app(p_workspace_id, source->'app'->>'name', source->'app'->>'url', p_max_apps);
  update public.apps set accent = source->'app'->>'accent' where id = app.id;
  insert into public.app_logos(id,workspace_id,app_id,mime,content,favicon_mime,favicon_content)
    select 'asset_' || replace(gen_random_uuid()::text,'-',''), p_workspace_id, app.id,
      mime,content,favicon_mime,favicon_content from public.app_logos where app_id = source->'app'->>'id';

  for m in select value from jsonb_array_elements(source->'monitors') loop
    reason := null; new_monitor := null;
    if not (m->>'copyable')::boolean then reason := 'needs_key';
    else
      -- create_monitor may already have supplied this host's free SSL check with an HTTP
      -- copy. Reuse only one owned by this new app; an existing app's check is never changed.
      if m->>'type' = 'ssl' then
        select id into new_monitor from public.monitors where workspace_id = p_workspace_id
          and app_id = app.id and type = 'ssl' and auto and target_host = m->>'targetHost';
        if found then update public.monitors set name = m->>'name', config = m->'config' where id = new_monitor; end if;
      end if;
      if new_monitor is null then
        begin
          select id into new_monitor from public.create_monitor(
            p_workspace_id => p_workspace_id, p_id => public.new_id('mon'), p_app_id => app.id,
            p_type => m->>'type', p_name => m->>'name', p_target => m->>'target', p_target_host => m->>'targetHost',
            p_interval_sec => case m->>'type' when 'ssl' then 21600 when 'dns' then 600 else p_http_interval_sec end,
            p_config => m->'config', p_heartbeat_token_hash => null, p_secrets => '[]'::jsonb,
            p_max_monitors => p_max_monitors, p_max_heartbeats => 0, p_max_assertions => p_max_assertions,
            p_max_heartbeat_assertions => 0, p_per_host => p_per_host, p_min_interval_sec => p_http_interval_sec);
        exception when sqlstate 'P0001' then
          get stacked diagnostics reason = message_text;
          if reason not in ('monitor_limit','host_limit','assertion_limit') then raise; end if;
        end;
      end if;
    end if;
    if reason is not null then
      skipped := skipped || jsonb_build_array(jsonb_build_object('name', m->>'name', 'reason', reason));
    else
      mapped := mapped || jsonb_build_object(m->>'id', new_monitor);
      copied := copied || jsonb_build_array(m->>'name');
    end if;
  end loop;

  select * into page from public.create_status_page(p_workspace_id,app.id,p_slug,
    source->'page'->>'name',source->'page'->>'logoText',source->'page'->>'homepage',p_max_pages);
  -- This new page has never committed publicly, so no edge withdrawal is needed. A clone
  -- starts private on every plan; the existing editor lets Free publish an existing private page.
  update public.status_pages set members_only = true where id = page.id;
  for component in select value from jsonb_array_elements(source->'components') loop
    select coalesce(jsonb_agg(mapped->>id), '[]'::jsonb) into bindings
      from jsonb_array_elements_text(component->'monitorIds') id where mapped ? id;
    if jsonb_array_length(bindings) > 0 then
      components := components || jsonb_build_array(jsonb_build_object('name',component->>'name',
        'inApp',component->'inApp','monitorIds',bindings));
    end if;
  end loop;
  perform public.save_status_page(p_workspace_id,page.id,p_slug,source->'page'->>'name',source->'page'->>'logoText',
    source->'page'->>'homepage',source->'page'->>'accent',source->'page'->>'theme',not p_white_label,false,
    (source->'page'->>'historyDays')::integer,components,p_white_label,false);
  insert into public.page_assets(id,workspace_id,page_id,kind,mime,content)
    select 'asset_' || replace(gen_random_uuid()::text,'-',''),p_workspace_id,page.id,kind,mime,content
      from public.page_assets where page_id = source->'page'->>'id';
  return jsonb_build_object('appId',app.id,'pageId',page.id,'copied',copied,'skipped',skipped);
end $fn$;

-- New entry point leaves the deployed save signature intact. NULL means no authority to
-- change the demo flag; it preserves the stored value, whatever an unentitled client sends.
create or replace function public.save_demo_page(
  p_workspace_id text,p_page_id text,p_slug text,p_name text,p_logo_text text,p_homepage text,
  p_accent text,p_theme text,p_powered_by boolean,p_noindex boolean,p_history_days integer,
  p_components jsonb,p_white_label boolean,p_private_pages boolean,p_members_only boolean,
  p_withdrawal_version integer default null,p_demo boolean default null
) returns public.status_pages language plpgsql security invoker set search_path = '' as $fn$
begin
  perform 1 from public.status_pages where id=p_page_id and workspace_id=p_workspace_id for update;
  if not found then raise exception 'not_found' using errcode='PT404'; end if;
  -- Disable before a private transition; enable after a public transition, so the constraint
  -- holds at every statement, including when a single save changes both switches.
  if p_demo is false then update public.status_pages set demo=false where id=p_page_id; end if;
  perform public.save_status_page_access(p_workspace_id,p_page_id,p_slug,p_name,p_logo_text,p_homepage,
    p_accent,p_theme,p_powered_by,p_noindex,p_history_days,p_components,p_white_label,p_private_pages,
    p_members_only,p_withdrawal_version);
  if p_demo is true then update public.status_pages set demo=true where id=p_page_id; end if;
  return (select p from public.status_pages p where p.id=p_page_id);
end $fn$;

revoke all on function public.demo_clone_source(text) from public,anon,authenticated;
revoke all on function public.clone_demo_page(text,text,text,integer,integer,integer,integer,integer,integer,boolean) from public,anon,authenticated;
revoke all on function public.save_demo_page(text,text,text,text,text,text,text,text,boolean,boolean,integer,jsonb,boolean,boolean,boolean,integer,boolean) from public,anon,authenticated;
grant execute on function public.demo_clone_source(text) to service_role;
grant execute on function public.clone_demo_page(text,text,text,integer,integer,integer,integer,integer,integer,boolean) to service_role;
grant execute on function public.save_demo_page(text,text,text,text,text,text,text,text,boolean,boolean,integer,jsonb,boolean,boolean,boolean,integer,boolean) to service_role;

create or replace function public.status_page_snapshot(p_slug text, p_workspace_id text)
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
      'historyDays', p.history_days, 'demo', p.demo
    ),
    'components', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', c.position, 'name', c.name, 'inApp', c.in_app,
               'states', (select coalesce(jsonb_agg(
                                   case when m.paused_at is not null and (m.paused_until is null or m.paused_until > now())
                                        then 'paused' else m.state end), '[]'::jsonb)
                            from public.component_monitors cm
                            join public.monitors m on m.id = cm.monitor_id
                           where cm.component_id = c.id),
               'daily', (select coalesce(jsonb_agg(jsonb_build_object('d', x.day, 'up', x.up) order by x.day), '[]'::jsonb)
                           from (select md.day, min(md.up) as up
                                   from public.monitor_days(array(select cm.monitor_id from public.component_monitors cm where cm.component_id = c.id),
                                                            least(p.history_days, 90)) md
                                  group by md.day) x)
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
  where p.slug = p_slug and ((not p.members_only and not p.edge_withdrawn) or p.workspace_id = p_workspace_id)
$fn$;


commit;
