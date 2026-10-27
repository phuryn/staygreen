-- 028: additive transports and routing. The old claim API still serves only email/Telegram;
-- upgraded Workers use alert_claim_channels. Old dashboards/probes/senders continue to run.
begin;
alter table public.alert_channels drop constraint if exists alert_channels_kind_check;
alter table public.alert_channels add constraint alert_channels_kind_check check (kind in ('email','telegram','slack','discord','webhook'));
alter table public.alert_channels drop constraint if exists alert_channels_built;
alter table public.alert_channels add constraint alert_channels_built check
  (kind in ('email','telegram') or (sealed is not null and confirmed_at is not null and label is not null));
alter table public.alert_deliveries add column if not exists webhook_body text check (octet_length(webhook_body)<=16384);
alter table public.alert_deliveries add column if not exists webhook_started_at timestamptz;
alter table public.alert_deliveries add column if not exists webhook_attempts integer not null default 0 check(webhook_attempts between 0 and 6);

create table if not exists public.alert_routes (
  id text primary key default public.new_id('route'),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  app_id text not null,
  monitor_id text,
  severity text not null check (severity in ('all','incident','warning')),
  unique(id,workspace_id),
  foreign key(app_id,workspace_id) references public.apps(id,workspace_id) on delete cascade,
  foreign key(monitor_id,workspace_id) references public.monitors(id,workspace_id) on delete cascade
);
create unique index if not exists alert_routes_app on public.alert_routes(app_id,severity) where monitor_id is null;
create unique index if not exists alert_routes_monitor on public.alert_routes(monitor_id,severity) where monitor_id is not null;
create unique index if not exists monitors_alert_route_scope on public.monitors(id,app_id,workspace_id);
do $fn$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.alert_routes'::regclass and conname='alert_routes_monitor_app') then
    alter table public.alert_routes add constraint alert_routes_monitor_app
      foreign key(monitor_id,app_id,workspace_id) references public.monitors(id,app_id,workspace_id) on update cascade on delete cascade;
  end if;
end $fn$;
create table if not exists public.alert_route_channels (
  route_id text not null,
  workspace_id text not null,
  channel_id text not null,
  primary key(route_id,channel_id),
  foreign key(route_id,workspace_id) references public.alert_routes(id,workspace_id) on delete cascade,
  foreign key(channel_id,workspace_id) references public.alert_channels(id,workspace_id) on delete cascade
);
create table if not exists public.slack_installs (
  state_hash text primary key check(state_hash ~ '^[0-9a-f]{64}$'),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id text not null check(user_id ~ '^user_[A-Za-z0-9]{1,64}$'),
  created_at timestamptz not null default now()
);
alter table public.alert_routes enable row level security;
alter table public.alert_route_channels enable row level security;
alter table public.slack_installs enable row level security;
revoke all on public.alert_routes,public.alert_route_channels,public.slack_installs from public,anon,authenticated,probe,ingest,watchdog,alert_sender;
grant select,insert,update,delete on public.alert_routes,public.alert_route_channels,public.slack_installs to service_role;

-- Bound to the current verified member AND active workspace; deletion consumes once, before
-- OAuth exchange. Slack's callback is cross-site, so the random state replaces Origin here.
create or replace function public.consume_slack_install(p_hash text,p_workspace_id text,p_user_id text)
returns boolean language plpgsql security invoker set search_path='' as $fn$
begin
  delete from public.slack_installs where state_hash=p_hash and workspace_id=p_workspace_id and user_id=p_user_id
    and created_at>now()-interval '10 minutes';
  return found;
end;
$fn$;

-- Null or empty channel lists remove the rule and restore inheritance. The locked
-- workspace serializes edits. Composite FKs keep every selected channel in that workspace.
create or replace function public.set_alert_routing(p_workspace_id text,p_app_id text,p_monitor_id text,p_severity text,p_channels text[],p_alert_rules boolean)
returns void language plpgsql security invoker set search_path='' as $fn$
declare v_id text;
begin
  if p_alert_rules is null then raise exception 'limits_required' using errcode='22004'; end if;
  if p_severity is null or p_severity not in ('all','incident','warning') then raise exception 'route_invalid' using errcode='22023'; end if;
  if p_severity<>'all' and not p_alert_rules then raise exception 'alert_rules_required' using errcode='P0001'; end if;
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found then raise exception 'not_found' using errcode='PT404'; end if;
  perform 1 from public.apps where id=p_app_id and workspace_id=p_workspace_id;
  if not found then raise exception 'not_found' using errcode='PT404'; end if;
  if p_monitor_id is not null and not exists(select 1 from public.monitors where id=p_monitor_id and app_id=p_app_id and workspace_id=p_workspace_id)
    then raise exception 'not_found' using errcode='PT404'; end if;
  if cardinality(p_channels)>100 or exists(select 1 from unnest(p_channels) c where c is null or not exists(select 1 from public.alert_channels a where a.id=c and a.workspace_id=p_workspace_id))
    then raise exception 'not_found' using errcode='PT404'; end if;
  delete from public.alert_routes where workspace_id=p_workspace_id and app_id=p_app_id and monitor_id is not distinct from p_monitor_id and severity=p_severity;
  if p_channels is null or cardinality(p_channels)=0 then return; end if;
  insert into public.alert_routes(workspace_id,app_id,monitor_id,severity) values(p_workspace_id,p_app_id,p_monitor_id,p_severity) returning id into v_id;
  insert into public.alert_route_channels(route_id,workspace_id,channel_id) select v_id,p_workspace_id,c from (select distinct unnest(p_channels) c) x;
end;
$fn$;

-- Monitor severity > monitor all > app severity > app all > original app exclusions.
-- Recoveries use their opening incident's severity, so they return to the same audience.
-- Empty routes (including after their last channel is deleted) cannot override a fallback.
create or replace function public.alert_route_matches(p_channel_id text,p_incident_id text)
returns boolean language sql stable security invoker set search_path='' as $fn$
  select coalesce((select exists(select 1 from public.alert_route_channels rc where rc.route_id=r.id and rc.channel_id=c.id)
    from public.alert_routes r where r.workspace_id=c.workspace_id and r.app_id=m.app_id
      and exists(select 1 from public.alert_route_channels rc where rc.route_id=r.id)
      and (r.monitor_id=m.id or r.monitor_id is null)
      and r.severity in ('all',case when i.severity='down' then 'incident' else 'warning' end)
    order by (r.monitor_id is not null) desc,(r.severity<>'all') desc limit 1),
    not exists(select 1 from public.alert_exclusions x where x.channel_id=c.id and x.app_id=m.app_id))
  from public.alert_channels c join public.incidents i on i.workspace_id=c.workspace_id
    join public.monitors m on m.id=i.monitor_id
  where c.id=p_channel_id and i.id=p_incident_id;
$fn$;


create or replace function public.alert_pending_events(p_limit integer, p_event_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'kind', x.kind, 'workspaceId', x.workspace_id, 'clerkOrgId', x.clerk_org_id,
           'needsMembers', x.needs_members) order by x.created_at, x.id), '[]'::jsonb)
    from (
      select e.id, e.kind, e.workspace_id, w.clerk_org_id, e.created_at,
             exists (select 1
                       from public.alert_channels c
                      where c.audience = 'members'
                        and case when e.kind = 'test' then c.id = e.channel_id
                                 else c.workspace_id = e.workspace_id
                                      and public.alert_route_matches(c.id, e.incident_id) end) as needs_members
        from public.alert_events e
        join public.workspaces w on w.id = e.workspace_id
       where e.expanded_at is null
         and (p_event_id is null or e.id = p_event_id)
       order by e.created_at, e.id
       limit greatest(1, least(coalesce(p_limit, 50), 500))
    ) x
$fn$;

create or replace function public.alert_expand(p_event_id text, p_members text[])
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  e       public.alert_events;
  v_app   text;
  v_count integer := 0;
begin
  select * into e from public.alert_events where id = p_event_id for update;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  if e.expanded_at is not null then
    return jsonb_build_object('status', 'done');
  end if;
  if e.kind = 'resolved' and exists (select 1 from public.alert_events o
                                      where o.incident_id = e.incident_id and o.kind = 'opened' and o.expanded_at is null) then
    return jsonb_build_object('status', 'wait');
  end if;

  if e.kind = 'test' then
    if p_members is null and exists (select 1 from public.alert_channels c where c.id = e.channel_id and c.audience = 'members') then
      return jsonb_build_object('status', 'members_required');
    end if;
    -- A test of the members' channel goes to the member who asked, and only while they are one.
    insert into public.alert_deliveries (workspace_id, event_id, event, channel_id, recipient)
    select e.workspace_id, e.id, 'test', c.id, case when c.audience = 'members' then e.requested_by else 'channel' end
      from public.alert_channels c
     where c.id = e.channel_id and c.confirmed_at is not null and c.unsubscribed_at is null
       and (c.audience is distinct from 'members' or e.requested_by = any (p_members))
    on conflict do nothing;
    get diagnostics v_count = row_count;
  else
    select m.app_id into v_app from public.incidents i join public.monitors m on m.id = i.monitor_id where i.id = e.incident_id;
    if p_members is null and exists (select 1 from public.alert_channels c
                                      where c.workspace_id = e.workspace_id and c.audience = 'members'
                                        and public.alert_route_matches(c.id, e.incident_id)) then
      return jsonb_build_object('status', 'members_required');
    end if;

    insert into public.alert_deliveries (workspace_id, event_id, event, incident_id, channel_id, recipient)
    select e.workspace_id, e.id, e.kind, e.incident_id, t.channel_id, t.recipient
      from (
        select c.id as channel_id, r.recipient
          from public.alert_channels c
          cross join lateral (
            select u as recipient from unnest(coalesce(p_members, '{}'::text[])) as u where c.audience = 'members'
            union all
            select 'channel' where c.audience is distinct from 'members'
          ) r
         where c.workspace_id = e.workspace_id and c.kind in ('email', 'telegram', 'slack', 'discord', 'webhook')
           and c.confirmed_at is not null and c.unsubscribed_at is null
           and public.alert_route_matches(c.id, e.incident_id)
           and not exists (select 1 from public.alert_suppressions s where s.channel_id = c.id and s.recipient = r.recipient)
      ) t
     where e.kind = 'opened'
        or exists (select 1 from public.alert_deliveries o
                    where o.incident_id = e.incident_id and o.event = 'opened' and o.channel_id = t.channel_id
                      and o.recipient = t.recipient and o.status in ('pending', 'sending', 'sent'))
    on conflict do nothing;
    get diagnostics v_count = row_count;
  end if;

  update public.alert_events set expanded_at = now() where id = e.id;
  return jsonb_build_object('status', 'expanded', 'deliveries', v_count);
end;
$fn$;

create or replace function public.alert_claim(p_claim text, p_limit integer, p_lease_sec integer, p_event_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_out jsonb;
begin
  if p_claim is null or char_length(p_claim) not between 8 and 64 or p_lease_sec is null or p_lease_sec < 30 then
    raise exception 'claim_invalid' using errcode = '22023';
  end if;

  with picked as (
    select d.id, d.status as was
      from public.alert_deliveries d
     where (d.channel_id is null or exists (select 1 from public.alert_channels c where c.id=d.channel_id and c.kind in ('email','telegram')))
       and (p_event_id is null or d.event_id = p_event_id)
       and ((d.status = 'pending' and d.next_at <= now())
            or (d.status = 'sending' and d.claimed_at < now() - make_interval(secs => p_lease_sec)))
       and (d.event <> 'resolved' or not exists (
             select 1 from public.alert_deliveries o
              where o.incident_id = d.incident_id and o.event = 'opened' and o.channel_id is not distinct from d.channel_id
                and o.recipient = d.recipient and o.status in ('pending', 'sending')))
     order by d.created_at, d.id
     limit greatest(1, least(coalesce(p_limit, 10), 100))
       for update of d skip locked
  ),
  claimed as (
    update public.alert_deliveries d
       set status = 'sending', claim = p_claim, claimed_at = clock_timestamp(), attempts = least(d.attempts + 1, 100)
      from picked p
     where d.id = p.id
    returning d.*, p.was
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'event', d.event, 'eventId', d.event_id, 'attempts', d.attempts, 'inDoubt', d.was = 'sending',
           'recipient', d.recipient, 'workspaceId', d.workspace_id, 'clerkOrgId', w.clerk_org_id,
           'createdAt', d.created_at,
           'channel', case when c.id is null then null
                           else jsonb_build_object('id', c.id, 'kind', c.kind, 'audience', c.audience, 'address', c.address,
                                                   'chatId', c.chat_id::text) end,
           'why', case when c.id is null then 'channel_removed'
                       when c.unsubscribed_at is not null
                         or exists (select 1 from public.alert_suppressions s where s.channel_id = c.id and s.recipient = d.recipient) then 'unsubscribed'
                       when c.confirmed_at is null then 'unconfirmed'
                       when d.event <> 'test'
                         and not public.alert_route_matches(c.id, d.incident_id) then 'excluded'
                  end,
           'stateAfter', e.state_after,
           'incident', case when i.id is null then null else jsonb_build_object(
             'id', i.id, 'title', i.title, 'severity', i.severity, 'openedAt', i.opened_at, 'resolvedAt', i.resolved_at,
             'evidence', i.evidence) end,
           'monitor', case when m.id is null then null else jsonb_build_object('id', m.id, 'name', m.name, 'type', m.type) end,
           'app', case when a.id is null then null else jsonb_build_object('id', a.id, 'name', a.name) end,
           'pageSlug', (select p.slug from public.status_pages p where p.app_id = a.id)
         ) order by d.created_at, d.id), '[]'::jsonb)
    into v_out
    from claimed d
    join public.workspaces w on w.id = d.workspace_id
    join public.alert_events e on e.id = d.event_id
    left join public.alert_channels c on c.id = d.channel_id
    left join public.incidents i on i.id = d.incident_id
    left join public.monitors m on m.id = i.monitor_id
    left join public.apps a on a.id = m.app_id;

  return v_out;
end;
$fn$;

create or replace function public.alert_claim_channels(p_claim text, p_limit integer, p_lease_sec integer, p_event_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_out jsonb;
begin
  if p_claim is null or char_length(p_claim) not between 8 and 64 or p_lease_sec is null or p_lease_sec < 30 then
    raise exception 'claim_invalid' using errcode = '22023';
  end if;

  with picked as (
    select d.id, d.status as was
      from public.alert_deliveries d
     where (p_event_id is null or d.event_id = p_event_id)
       and ((d.status = 'pending' and d.next_at <= now())
            or (d.status = 'sending' and d.claimed_at < now() - make_interval(secs => p_lease_sec)))
       and (d.event <> 'resolved' or not exists (
             select 1 from public.alert_deliveries o
              where o.incident_id = d.incident_id and o.event = 'opened' and o.channel_id is not distinct from d.channel_id
                and o.recipient = d.recipient and o.status in ('pending', 'sending')))
     order by d.created_at, d.id
     limit greatest(1, least(coalesce(p_limit, 10), 100))
       for update of d skip locked
  ),
  claimed as (
    update public.alert_deliveries d
       set status = 'sending', claim = p_claim, claimed_at = clock_timestamp(), attempts = least(d.attempts + 1, 100)
      from picked p
     where d.id = p.id
    returning d.*, p.was
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'event', d.event, 'eventId', d.event_id, 'attempts', d.attempts, 'inDoubt', d.was = 'sending',
           'recipient', d.recipient, 'workspaceId', d.workspace_id, 'clerkOrgId', w.clerk_org_id,
           'createdAt', d.created_at, 'webhookStartedAt', d.webhook_started_at, 'webhookBody', d.webhook_body, 'webhookAttempts', d.webhook_attempts,
           'parentProviderId', (select o.provider_id from public.alert_deliveries o where o.incident_id=d.incident_id and o.channel_id=d.channel_id and o.event='opened' and o.status='sent' limit 1),
           'channel', case when c.id is null then null
                           else jsonb_build_object('id', c.id, 'kind', c.kind, 'audience', c.audience, 'address', c.address,
                                                   'chatId', c.chat_id::text, 'sealed', c.sealed) end,
           'why', case when c.id is null then 'channel_removed'
                       when c.unsubscribed_at is not null
                         or exists (select 1 from public.alert_suppressions s where s.channel_id = c.id and s.recipient = d.recipient) then 'unsubscribed'
                       when c.confirmed_at is null then 'unconfirmed'
                       when d.event <> 'test'
                         and not public.alert_route_matches(c.id, d.incident_id) then 'excluded'
                  end,
           'stateAfter', e.state_after,
           'incident', case when i.id is null then null else jsonb_build_object(
             'id', i.id, 'title', i.title, 'severity', i.severity, 'openedAt', i.opened_at, 'resolvedAt', i.resolved_at,
             'evidence', i.evidence) end,
           'monitor', case when m.id is null then null else jsonb_build_object('id', m.id, 'name', m.name, 'type', m.type) end,
           'app', case when a.id is null then null else jsonb_build_object('id', a.id, 'name', a.name) end,
           'pageSlug', (select p.slug from public.status_pages p where p.app_id = a.id)
         ) order by d.created_at, d.id), '[]'::jsonb)
    into v_out
    from claimed d
    join public.workspaces w on w.id = d.workspace_id
    join public.alert_events e on e.id = d.event_id
    left join public.alert_channels c on c.id = d.channel_id
    left join public.incidents i on i.id = d.incident_id
    left join public.monitors m on m.id = i.monitor_id
    left join public.apps a on a.id = m.app_id;

  return v_out;
end;
$fn$;

create or replace function public.alert_prepare_webhook(p_id text, p_claim text, p_body text)
returns jsonb language plpgsql security invoker set search_path = '' as $fn$
declare d public.alert_deliveries;
begin
  if p_body is null or octet_length(p_body) > 16384 then raise exception 'payload_invalid' using errcode='22023'; end if;
  update public.alert_deliveries set webhook_body=coalesce(webhook_body,p_body), webhook_started_at=coalesce(webhook_started_at,clock_timestamp()), webhook_attempts=webhook_attempts+1
    where id=p_id and claim=p_claim and status='sending' and webhook_attempts<6 and exists(select 1 from public.alert_channels c where c.id=channel_id and c.kind='webhook')
    returning * into d;
  if not found then return null; end if;
  return jsonb_build_object('body',d.webhook_body,'startedAt',d.webhook_started_at,'attempts',d.webhook_attempts);
end;
$fn$;

create or replace function alert_sender.alert_claim_channels(p_claim text,p_limit integer,p_lease_sec integer,p_event_id text)
returns jsonb language sql security definer set search_path = '' as $fn$
  select public.alert_claim_channels(p_claim,p_limit,p_lease_sec,p_event_id);
$fn$;
alter function alert_sender.alert_claim_channels(text,integer,integer,text) owner to postgres;
create or replace function alert_sender.alert_prepare_webhook(p_id text,p_claim text,p_body text)
returns jsonb language sql security definer set search_path = '' as $fn$
  select public.alert_prepare_webhook(p_id,p_claim,p_body);
$fn$;
alter function alert_sender.alert_prepare_webhook(text,text,text) owner to postgres;
revoke all on function alert_sender.alert_claim_channels(text,integer,integer,text), alert_sender.alert_prepare_webhook(text,text,text)
  from public,anon,authenticated,service_role,probe,ingest,watchdog,alert_sender;
grant execute on function alert_sender.alert_claim_channels(text,integer,integer,text), alert_sender.alert_prepare_webhook(text,text,text) to alert_sender;

revoke all on function public.alert_route_matches(text,text),public.set_alert_routing(text,text,text,text,text[],boolean),
  public.alert_claim_channels(text,integer,integer,text),public.alert_prepare_webhook(text,text,text),public.consume_slack_install(text,text,text)
  from public,anon,authenticated,probe,ingest,watchdog,alert_sender;
grant execute on function public.alert_route_matches(text,text),public.set_alert_routing(text,text,text,text,text[],boolean),
  public.alert_claim_channels(text,integer,integer,text),public.alert_prepare_webhook(text,text,text),public.consume_slack_install(text,text,text) to service_role;
commit;
