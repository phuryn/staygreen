-- 002 · Phase 1: acknowledging an incident, and pausing a monitor.
--
-- Both write with the database's clock and in one statement, so an
-- acknowledgement can't lose a timeline entry another writer appended at the
-- same moment (the engine, from Phase 2), and a pause window always satisfies
-- `monitors_pause_window`. A pause with an end resumes by itself: every reader
-- treats a window that has passed as no pause (`AGENTS.md § 2.8`), and the
-- public snapshot is replaced here to do the same.
--
-- Idempotent, and never edited after it is applied.

-- Acknowledge an incident once; a second acknowledgement changes nothing.
create or replace function public.ack_incident(p_workspace_id text, p_incident_id text, p_via text)
returns public.incidents
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v public.incidents;
begin
  update public.incidents
     set acked_at = now(),
         timeline = timeline || jsonb_build_array(jsonb_build_object('t', now(), 'text', 'Acknowledged from ' || coalesce(p_via, 'the dashboard')))
   where id = p_incident_id and workspace_id = p_workspace_id and acked_at is null
  returning * into v;
  if found then
    return v;
  end if;

  select * into v from public.incidents where id = p_incident_id and workspace_id = p_workspace_id;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  return v;
end;
$fn$;

-- Pause a monitor for a number of minutes, or until it is resumed (null).
-- At most 30 days: a longer pause is a monitor that should be deleted. The
-- agent's 24-hour cap (`AGENTS.md § 2.6`) is the agent tool's, in Phase 3.
create or replace function public.pause_monitor(p_workspace_id text, p_monitor_id text, p_minutes integer, p_reason text)
returns public.monitors
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v public.monitors;
begin
  if p_minutes is not null and (p_minutes < 1 or p_minutes > 43200) then
    raise exception 'pause_window_invalid' using errcode = 'P0001';
  end if;

  update public.monitors
     set paused_at = now(),
         paused_until = case when p_minutes is null then null else now() + make_interval(mins => p_minutes) end,
         pause_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         updated_at = now()
   where id = p_monitor_id and workspace_id = p_workspace_id
  returning * into v;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  return v;
end;
$fn$;

create or replace function public.resume_monitor(p_workspace_id text, p_monitor_id text)
returns public.monitors
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v public.monitors;
begin
  update public.monitors
     set paused_at = null, paused_until = null, pause_reason = null, updated_at = now()
   where id = p_monitor_id and workspace_id = p_workspace_id
  returning * into v;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  return v;
end;
$fn$;

-- The public snapshot of 001, with one change: a pause whose end has passed is
-- no pause. The return type is unchanged, so `create or replace` is enough.
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

-- ── grants (`AGENTS.md § 1.4`), for the functions above ─────────────────────

revoke all on function public.ack_incident(text, text, text)             from public, anon, authenticated;
revoke all on function public.pause_monitor(text, text, integer, text)   from public, anon, authenticated;
revoke all on function public.resume_monitor(text, text)                 from public, anon, authenticated;
revoke all on function public.public_status_snapshot(text)               from public, anon, authenticated;

grant execute on function public.ack_incident(text, text, text)           to service_role;
grant execute on function public.pause_monitor(text, text, integer, text) to service_role;
grant execute on function public.resume_monitor(text, text)               to service_role;
grant execute on function public.public_status_snapshot(text)             to service_role;
