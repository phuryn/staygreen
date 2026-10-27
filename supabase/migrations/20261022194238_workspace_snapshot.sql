-- 022: the dashboard's snapshot in one round trip (stage s29, `docs/product/decisions.md`,
-- 2026-10-22, "Moving around the dashboard").
--
-- Every dashboard page renders from `loadSnapshot` (`src/lib/workspace.ts`), which read the
-- workspace as eleven table selects and one call to `workspace_history`, twelve requests at
-- once. Measured from the development machine against the development project, twelve at once
-- took about three times one request, and that was most of a navigation's server time. This
-- function returns the same rows in one call: each list as a JSON array in the order the page
-- read it, with an id after each order so ties come back the same way every time, plus
-- `workspace_history`'s own result under `history`.
--
-- What it returns is what the selects returned, column for column, and nothing more:
-- - `monitors` names its display columns; the heartbeat token's hash and sealed copy and the
--   probes' own columns stay in the row, as they did;
-- - `monitor_secrets` is the header names only, never a sealed value;
-- - `page_assets` and `app_logos` are ids, never image bytes;
-- - `heartbeat_latest` is the times and the good ping's payload, which the snapshot judges the
--   assertions with; the other payloads are the monitor page's (`heartbeatLatestOf`).
--
-- `§ 1.4` as everywhere: security invoker with an empty search path, nothing for PUBLIC, `anon`
-- or `authenticated`, executed by the server's key alone. It reads only the workspace it is
-- given; the server passes the member's own (`requireMember`), as it did to each select.
--
-- Needs 019 (`heartbeat_latest`, and the `workspace_history` 019 replaces) and 020 (the monitors'
-- certificate columns and `workspace_domains`). Idempotent, and never
-- edited after it is applied.

begin;

create or replace function public.workspace_snapshot(p_workspace_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
set jit = off
as $fn$
  select jsonb_build_object(
    'apps', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.created_at, a.id)
        from public.apps a where a.workspace_id = p_workspace_id), '[]'::jsonb),
    'monitors', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'workspace_id', m.workspace_id, 'app_id', m.app_id, 'type', m.type,
               'name', m.name, 'target', m.target, 'target_host', m.target_host,
               'interval_sec', m.interval_sec, 'config', m.config, 'auto', m.auto,
               'state', m.state, 'state_since', m.state_since, 'paused_at', m.paused_at,
               'paused_until', m.paused_until, 'pause_reason', m.pause_reason,
               'created_at', m.created_at, 'updated_at', m.updated_at,
               'cert_host', m.cert_host, 'cert_expires_at', m.cert_expires_at, 'cert_issuer', m.cert_issuer)
             order by m.created_at, m.id)
        from public.monitors m where m.workspace_id = p_workspace_id), '[]'::jsonb),
    'monitor_secrets', coalesce((
      select jsonb_agg(jsonb_build_object('monitor_id', s.monitor_id, 'name', s.name) order by s.name, s.monitor_id)
        from public.monitor_secrets s where s.workspace_id = p_workspace_id), '[]'::jsonb),
    'incidents', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.opened_at desc, i.id)
        from public.incidents i where i.workspace_id = p_workspace_id), '[]'::jsonb),
    'incident_notes', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at, n.id)
        from public.incident_notes n where n.workspace_id = p_workspace_id), '[]'::jsonb),
    'status_pages', coalesce((
      select jsonb_agg(to_jsonb(p) order by p.created_at, p.id)
        from public.status_pages p where p.workspace_id = p_workspace_id), '[]'::jsonb),
    'page_components', coalesce((
      select jsonb_agg(to_jsonb(c) order by c.position, c.id)
        from public.page_components c where c.workspace_id = p_workspace_id), '[]'::jsonb),
    'component_monitors', coalesce((
      select jsonb_agg(jsonb_build_object('component_id', b.component_id, 'monitor_id', b.monitor_id) order by b.component_id, b.monitor_id)
        from public.component_monitors b where b.workspace_id = p_workspace_id), '[]'::jsonb),
    'page_assets', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'page_id', x.page_id, 'kind', x.kind) order by x.id)
        from public.page_assets x where x.workspace_id = p_workspace_id), '[]'::jsonb),
    'app_logos', coalesce((
      select jsonb_agg(jsonb_build_object('id', l.id, 'app_id', l.app_id) order by l.id)
        from public.app_logos l where l.workspace_id = p_workspace_id), '[]'::jsonb),
    'heartbeat_latest', coalesce((
      select jsonb_agg(jsonb_build_object('monitor_id', h.monitor_id, 'ping_at', h.ping_at, 'ping_payload', h.ping_payload,
                                          'start_at', h.start_at, 'fail_at', h.fail_at, 'judged_at', h.judged_at,
                                          'run_at', h.run_at) order by h.monitor_id)
        from public.heartbeat_latest h where h.workspace_id = p_workspace_id), '[]'::jsonb),
    'domains', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.host)
        from public.workspace_domains(p_workspace_id) d), '[]'::jsonb),
    'history', public.workspace_history(p_workspace_id)
  )
$fn$;

revoke all on function public.workspace_snapshot(text) from public, anon, authenticated;
grant execute on function public.workspace_snapshot(text) to service_role;

commit;
