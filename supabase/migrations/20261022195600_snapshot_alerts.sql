-- 024: the dashboard's snapshot (022) with where alerts go and what was sent (023), in the same
-- one round trip (the integration of stages s29 and 2.3).
--
-- 023 added the alert tables after 022 had made the snapshot one call, so the Alerts screen and
-- an incident's "Alerts sent" read them here, with the columns the stage's selects named and no
-- others:
-- - `alert_channels`: id, kind, audience, address, label and when it was confirmed; never the
--   confirmation's hash or a Telegram chat id;
-- - `alert_deliveries`: the settled receipts (sent or failed) of incidents' alerts, newest first,
--   at most 500; never a member's address.
-- Everything else is 022's, unchanged.
--
-- `§ 1.4` as everywhere: security invoker with an empty search path, nothing for PUBLIC, `anon`
-- or `authenticated`, executed by the server's key alone. Needs 022 and 023. Idempotent, and
-- never edited after it is applied.

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
    'alert_channels', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'audience', c.audience, 'address', c.address,
                                          'label', c.label, 'confirmed_at', c.confirmed_at) order by c.created_at, c.id)
        from public.alert_channels c where c.workspace_id = p_workspace_id), '[]'::jsonb),
    'alert_deliveries', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'event', d.event, 'incident_id', d.incident_id, 'channel_id', d.channel_id,
                                          'status', d.status, 'created_at', d.created_at, 'sent_at', d.sent_at)
                       order by d.created_at desc, d.id)
        from (select * from public.alert_deliveries x
               where x.workspace_id = p_workspace_id and x.incident_id is not null and x.status in ('sent', 'failed')
               order by x.created_at desc, x.id limit 500) d), '[]'::jsonb),
    'history', public.workspace_history(p_workspace_id)
  )
$fn$;

revoke all on function public.workspace_snapshot(text) from public, anon, authenticated;
grant execute on function public.workspace_snapshot(text) to service_role;

commit;
