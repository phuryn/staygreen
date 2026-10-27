-- 023: alerts by email and Telegram, and the channel model Slack plugs into (stage 2.3,
-- `docs/emails.md`, `docs/telegram.md`).
--
-- What sends a message: an incident opening and its recovery. The probes' functions and roles
-- are untouched. A trigger on `incidents`, in the transaction that writes the row, adds the
-- event to an outbox (`alert_events`), so an incident never exists without its pending alert
-- and a rolled-back one never sends. The sender (`src/lib/alerts/sender.ts`, run each minute by
-- a Netlify scheduled function in production and by `npm run alerts:send` in development) turns
-- each event into one receipt per channel and recipient (`alert_deliveries`) before anything is
-- sent, claims receipts one sender at a time, and marks each with what Postmark answered. The
-- receipt is the unit of "exactly once": unique per event, channel and recipient, claimed under
-- a lease, and reconciled against Postmark before a claim that may have reached it is retried.
--
-- Who gets email: a workspace's members, through the one `members` channel each workspace has
-- (made with the workspace; their addresses are read from Clerk at send time and never stored
-- here), and on Builder (`notify_teammates`) addresses that aren't a member's, each its own
-- channel, which receives nothing until its owner confirms. A Telegram chat is a channel bound
-- by a one-time code: the builder opens the bot's deep link and presses Start, and the bot's
-- update (`src/lib/alerts/telegram.ts`) binds the chat that sent it. Slack is a kind the model
-- names, refused by a check until it is built.
--
-- `§ 1.4` as everywhere: RLS on with zero policies, nothing for PUBLIC, `anon` or
-- `authenticated`, every function `security invoker` with an empty search path and executable
-- by `service_role` alone. No new role and no new login: the sender runs with the server's own
-- key (`docs/architecture.md § Alerts`).
--
-- Idempotent, and never edited after it is applied.

begin;

-- ── channels ─────────────────────────────────────────────────────────────────

create table if not exists public.alert_channels (
  id              text primary key default public.new_id('chan'),
  workspace_id    text not null references public.workspaces (id) on delete cascade,
  kind            text not null check (kind in ('email', 'slack', 'telegram')),
  -- Email only: `members` reaches the workspace's members, `address` one stored address.
  audience        text check (audience in ('members', 'address')),
  address         text check (address is null or (char_length(address) between 3 and 254
                                and address = lower(address) and address ~ '^[^[:space:]@<>",]+@[^[:space:]@<>",]+\.[^[:space:]@<>",]+$')),
  -- What the screen calls a chat or a Slack channel: a Telegram chat's title, or its user's
  -- name or @username, as Telegram gave it when the chat was bound.
  label           text check (label is null or char_length(label) between 1 and 120),
  -- Telegram: the bound chat's id. Not a secret (only the bot's token can write to it), so it is
  -- stored as it is and `/stop` can find the chat's channels.
  chat_id         bigint,
  -- Slack, once built: its incoming-webhook URL, which is a credential, sealed by
  -- `src/lib/credentials.ts`. Unused until then.
  sealed          text check (sealed is null or (sealed ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' and char_length(sealed) <= 8192)),
  -- An address's confirmation, or a Telegram link's one-time code: the SHA-256 of the token its
  -- link carries, and when the link was made.
  confirm_hash    text unique check (confirm_hash is null or confirm_hash ~ '^[0-9a-f]{64}$'),
  confirm_sent_at timestamptz,
  confirmed_at    timestamptz,
  unsubscribed_at timestamptz,
  created_by      text check (created_by is null or created_by ~ '^user_[A-Za-z0-9]{1,64}$'),
  created_at      timestamptz not null default now(),
  unique (id, workspace_id),
  constraint alert_channels_email check ((kind = 'email') = (audience is not null)),
  constraint alert_channels_address check ((audience is not distinct from 'address') = (address is not null)),
  -- The members' channel is confirmed by sign-in, which proves each member's address, and a
  -- member unsubscribes alone (`alert_suppressions`), never the whole channel.
  constraint alert_channels_members check (audience is distinct from 'members' or (confirmed_at is not null and unsubscribed_at is null)),
  constraint alert_channels_confirm check (confirm_hash is null or (confirmed_at is null and confirm_sent_at is not null)),
  -- A Telegram channel is confirmed exactly when a chat is bound to it.
  constraint alert_channels_telegram check ((kind = 'telegram' and confirmed_at is not null) = (chat_id is not null)),
  -- Slack has its slot and nothing else: its credential doesn't exist yet, so no row may claim to
  -- be one until the stage that builds it replaces this check.
  constraint alert_channels_built check (kind in ('email', 'telegram'))
);

create unique index if not exists alert_channels_one_members on public.alert_channels (workspace_id) where audience = 'members';
create unique index if not exists alert_channels_address_key on public.alert_channels (workspace_id, address) where address is not null;
create unique index if not exists alert_channels_chat_key on public.alert_channels (workspace_id, chat_id) where chat_id is not null;
create index if not exists alert_channels_chat on public.alert_channels (chat_id) where chat_id is not null;

-- A channel alerts every app of its workspace, new ones included, except those listed here.
create table if not exists public.alert_exclusions (
  channel_id   text not null,
  app_id       text not null,
  workspace_id text not null,
  primary key (channel_id, app_id),
  foreign key (channel_id, workspace_id) references public.alert_channels (id, workspace_id) on delete cascade,
  foreign key (app_id, workspace_id) references public.apps (id, workspace_id) on delete cascade
);

-- A member who unsubscribed from the members' channel, by Clerk user id: no address is stored.
create table if not exists public.alert_suppressions (
  channel_id   text not null,
  workspace_id text not null,
  recipient    text not null check (recipient ~ '^user_[A-Za-z0-9]{1,64}$'),
  created_at   timestamptz not null default now(),
  primary key (channel_id, recipient),
  foreign key (channel_id, workspace_id) references public.alert_channels (id, workspace_id) on delete cascade
);

-- ── the outbox ───────────────────────────────────────────────────────────────

create table if not exists public.alert_events (
  id           text primary key default public.new_id('aev'),
  workspace_id text not null references public.workspaces (id) on delete cascade,
  kind         text not null check (kind in ('opened', 'resolved', 'test')),
  incident_id  text,
  -- A test: the channel tested and the member who asked.
  channel_id   text,
  requested_by text check (requested_by is null or requested_by ~ '^user_[A-Za-z0-9]{1,64}$'),
  -- A recovery: the state the monitor recovered to.
  state_after  text check (state_after is null or state_after in ('up', 'degraded')),
  created_at   timestamptz not null default clock_timestamp(),
  expanded_at  timestamptz,
  unique (id, workspace_id),
  foreign key (incident_id, workspace_id) references public.incidents (id, workspace_id) on delete cascade,
  foreign key (channel_id, workspace_id) references public.alert_channels (id, workspace_id) on delete cascade,
  constraint alert_events_shape check (
    (kind = 'test' and incident_id is null and channel_id is not null and requested_by is not null)
    or (kind <> 'test' and incident_id is not null and channel_id is null and requested_by is null)),
  constraint alert_events_state check ((kind = 'resolved') = (state_after is not null))
);

create unique index if not exists alert_events_once on public.alert_events (incident_id, kind) where incident_id is not null;
create index if not exists alert_events_unexpanded on public.alert_events (created_at) where expanded_at is null;

-- One receipt per event, channel and recipient, written before anything is sent. `recipient` is
-- a member's Clerk user id on the members' channel, and `channel` on a channel with one
-- recipient. `sending` is a claim: whoever holds it may send, and one older than the sender's
-- lease may already have reached Postmark, so it is reconciled before it is sent again.
create table if not exists public.alert_deliveries (
  id           text primary key default public.new_id('dlv'),
  workspace_id text not null,
  event_id     text not null,
  event        text not null check (event in ('opened', 'resolved', 'test')),
  incident_id  text,
  -- Null once its channel is removed: the receipt stays in the log, and nothing more is sent.
  channel_id   text,
  recipient    text not null check (recipient = 'channel' or recipient ~ '^user_[A-Za-z0-9]{1,64}$'),
  status       text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempts     integer not null default 0 check (attempts between 0 and 100),
  next_at      timestamptz not null default now(),
  claim        text check (claim is null or char_length(claim) between 8 and 64),
  claimed_at   timestamptz,
  provider_id  text check (provider_id is null or char_length(provider_id) between 1 and 100),
  -- Our words for what happened, never a provider's response body.
  detail       text check (detail is null or char_length(detail) <= 200),
  -- Sent to the development address in `EMAIL_REDIRECT_TO` instead of its recipient.
  redirected   boolean not null default false,
  created_at   timestamptz not null default clock_timestamp(),
  sent_at      timestamptz,
  constraint alert_deliveries_once unique (event_id, channel_id, recipient),
  foreign key (event_id, workspace_id) references public.alert_events (id, workspace_id) on delete cascade,
  foreign key (channel_id, workspace_id) references public.alert_channels (id, workspace_id) on delete set null (channel_id),
  constraint alert_deliveries_claim check ((status = 'sending') = (claim is not null and claimed_at is not null)),
  constraint alert_deliveries_sent check ((status = 'sent') = (sent_at is not null and provider_id is not null))
);

create index if not exists alert_deliveries_due on public.alert_deliveries (next_at) where status = 'pending';
create index if not exists alert_deliveries_claimed on public.alert_deliveries (claimed_at) where status = 'sending';
create index if not exists alert_deliveries_workspace on public.alert_deliveries (workspace_id, created_at desc);
create index if not exists alert_deliveries_opened on public.alert_deliveries (incident_id, channel_id, recipient) where event = 'opened';

alter table public.alert_channels     enable row level security;
alter table public.alert_exclusions   enable row level security;
alter table public.alert_suppressions enable row level security;
alter table public.alert_events       enable row level security;
alter table public.alert_deliveries   enable row level security;

revoke all on public.alert_channels, public.alert_exclusions, public.alert_suppressions, public.alert_events, public.alert_deliveries
  from public, anon, authenticated;
grant select, insert, update, delete on public.alert_channels, public.alert_exclusions, public.alert_suppressions,
  public.alert_events, public.alert_deliveries to service_role;

-- Two budgets join the test's (011): a test alert, and a confirmation email.
alter table public.budgets drop constraint if exists budgets_action_check;
alter table public.budgets add constraint budgets_action_check check (action in ('test_check', 'alert_test', 'alert_confirm'));

-- ── every workspace has its members' channel ─────────────────────────────────

create or replace function public.alert_members_channel()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  insert into public.alert_channels (workspace_id, kind, audience, confirmed_at)
  values (new.id, 'email', 'members', now())
  on conflict do nothing;
  return null;
end;
$fn$;

create or replace trigger workspaces_alert_members_channel
after insert on public.workspaces
for each row execute function public.alert_members_channel();

insert into public.alert_channels (workspace_id, kind, audience, confirmed_at)
select w.id, 'email', 'members', now() from public.workspaces w
on conflict do nothing;

-- ── the trigger that fills the outbox ────────────────────────────────────────
-- An incident inserted open is an `opened` event. One closing is a `resolved` event only when
-- its monitor recovered, which the row's state says at this point: every writer that closes an
-- incident sets the monitor's state first in the same transaction (017 and 019 on a recovery,
-- 010 on an address change). So a probe closing a stale incident to open a new outage's own
-- (state `down`), and an address change (state cleared), send no recovery; and an incident that
-- was never alerted (open before this migration, or inserted already closed) gets none either.
-- It runs as whoever wrote the incident: the owner of the probes' definer functions, or the
-- server's `service_role`.

create or replace function public.alert_events_from_incident()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_state text;
begin
  if tg_op = 'INSERT' then
    if new.resolved_at is null then
      insert into public.alert_events (workspace_id, kind, incident_id)
      values (new.workspace_id, 'opened', new.id)
      on conflict do nothing;
    end if;
  elsif old.resolved_at is null and new.resolved_at is not null then
    select m.state into v_state from public.monitors m where m.id = new.monitor_id;
    if (v_state = 'up' or (v_state = 'degraded' and new.severity = 'down'))
       and exists (select 1 from public.alert_events e where e.incident_id = new.id and e.kind = 'opened') then
      insert into public.alert_events (workspace_id, kind, incident_id, state_after)
      values (new.workspace_id, 'resolved', new.id, v_state)
      on conflict do nothing;
    end if;
  end if;
  return null;
end;
$fn$;

create or replace trigger incidents_alert_events
after insert or update of resolved_at on public.incidents
for each row execute function public.alert_events_from_incident();

-- ── what the sender calls ────────────────────────────────────────────────────

-- Read only: events not yet turned into receipts, oldest first (or the one `p_event_id` names),
-- with whether one reaches the members' channel, so the sender reads the workspace's members
-- from Clerk only then.
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
                                      and not exists (select 1
                                                        from public.incidents i
                                                        join public.monitors m on m.id = i.monitor_id
                                                        join public.alert_exclusions x on x.app_id = m.app_id and x.channel_id = c.id
                                                       where i.id = e.incident_id) end) as needs_members
        from public.alert_events e
        join public.workspaces w on w.id = e.workspace_id
       where e.expanded_at is null
         and (p_event_id is null or e.id = p_event_id)
       order by e.created_at, e.id
       limit greatest(1, least(coalesce(p_limit, 50), 500))
    ) x
$fn$;

-- Turns one event into its receipts, once. `p_members` is the Clerk user ids of the workspace's
-- members who may read its monitors, as the sender read them just now; null when the sender
-- didn't read them, which is refused for an event that reaches the members' channel.
-- A recovery waits for its opening to be expanded, and goes only to the channels and members its
-- opening went to (or is still going to): a channel added since gets no lone "recovered". A
-- channel is reached only while confirmed and subscribed, for an app it doesn't exclude; a member
-- who unsubscribed gets no receipt.
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
                                        and not exists (select 1 from public.alert_exclusions x where x.channel_id = c.id and x.app_id = v_app)) then
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
         where c.workspace_id = e.workspace_id and c.kind in ('email', 'telegram')
           and c.confirmed_at is not null and c.unsubscribed_at is null
           and not exists (select 1 from public.alert_exclusions x where x.channel_id = c.id and x.app_id = v_app)
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

-- Claims up to `p_limit` receipts for the sender naming itself `p_claim`, under a lease of
-- `p_lease_sec`: those due, and those whose claim is older than the lease (`inDoubt`: a sender
-- may have reached Postmark before it stopped). Rows another transaction holds are skipped, so
-- two senders never claim one receipt. A recovery is claimed only once its opening's receipt for
-- the same channel and recipient is settled, so it never arrives first. `p_event_id` narrows the
-- claim to one event (a test sent from the dashboard). Returns each claimed receipt with what its
-- message needs, and whether it may still be sent (`sendable`, or `why` not).
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
           'createdAt', d.created_at,
           'channel', case when c.id is null then null
                           else jsonb_build_object('id', c.id, 'kind', c.kind, 'audience', c.audience, 'address', c.address,
                                                   'chatId', c.chat_id::text) end,
           'why', case when c.id is null then 'channel_removed'
                       when c.unsubscribed_at is not null
                         or exists (select 1 from public.alert_suppressions s where s.channel_id = c.id and s.recipient = d.recipient) then 'unsubscribed'
                       when c.confirmed_at is null then 'unconfirmed'
                       when d.event <> 'test'
                         and exists (select 1 from public.alert_exclusions x where x.channel_id = c.id and x.app_id = m.app_id) then 'excluded'
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

-- Settles a claimed receipt, only while `p_claim` still holds it: `sent` with Postmark's message
-- id, `failed` or `skipped` with our words, or `pending` again after `p_retry_sec`. Answers
-- whether it was settled; false means another sender took the claim over, and the receipt is
-- left to it.
create or replace function public.alert_mark(
  p_id text, p_claim text, p_status text, p_provider_id text, p_detail text, p_retry_sec integer, p_redirected boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  if p_status is null or p_status not in ('sent', 'failed', 'skipped', 'pending') then
    raise exception 'status_invalid' using errcode = '22023';
  end if;
  if p_status = 'sent' and (p_provider_id is null or p_provider_id = '') then
    raise exception 'provider_id_required' using errcode = '22023';
  end if;
  update public.alert_deliveries
     set status      = p_status,
         claim       = null,
         claimed_at  = null,
         provider_id = case when p_status = 'sent' then p_provider_id else provider_id end,
         sent_at     = case when p_status = 'sent' then clock_timestamp() end,
         detail      = case when p_status = 'sent' then null else pg_catalog.left(p_detail, 200) end,
         next_at     = case when p_status = 'pending' then now() + make_interval(secs => greatest(0, coalesce(p_retry_sec, 0))) else next_at end,
         redirected  = coalesce(p_redirected, redirected)
   where id = p_id and claim = p_claim and status = 'sending';
  return found;
end;
$fn$;

-- ── confirmation and unsubscribe ─────────────────────────────────────────────

-- An address that isn't a member's, on Builder (`notify_teammates`, passed from the session and
-- refused when missing). It starts unconfirmed, with the hash of the token its email carries.
create or replace function public.create_alert_address(
  p_workspace_id text, p_address text, p_confirm_hash text, p_created_by text, p_notify_teammates boolean
)
returns public.alert_channels
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v public.alert_channels;
begin
  if p_notify_teammates is null then
    raise exception 'limits_required' using errcode = '22004';
  end if;
  if not p_notify_teammates then
    raise exception 'teammates_required' using errcode = 'P0001';
  end if;
  perform 1 from public.workspaces where id = p_workspace_id;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  insert into public.alert_channels (workspace_id, kind, audience, address, confirm_hash, confirm_sent_at, created_by)
  values (p_workspace_id, 'email', 'address', lower(btrim(p_address)), p_confirm_hash, now(), p_created_by)
  returning * into v;
  return v;
end;
$fn$;

-- The confirmation link's answer: once, within `p_max_age_sec` of the email that carried it.
create or replace function public.confirm_alert_address(p_confirm_hash text, p_max_age_sec integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v public.alert_channels;
begin
  if p_max_age_sec is null or p_max_age_sec < 60 then
    raise exception 'limits_required' using errcode = '22004';
  end if;
  select * into v from public.alert_channels where confirm_hash = p_confirm_hash for update;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  if v.confirm_sent_at < now() - make_interval(secs => p_max_age_sec) then
    return jsonb_build_object('status', 'expired');
  end if;
  update public.alert_channels set confirmed_at = now(), confirm_hash = null where id = v.id;
  return jsonb_build_object('status', 'confirmed', 'channelId', v.id);
end;
$fn$;

-- The unsubscribe link names one receipt; this stops what that receipt reached: a member, from
-- the members' channel, or a stored address altogether. The link's signature is checked before
-- this is called (`src/lib/alerts/links.ts`).
create or replace function public.alert_unsubscribe(p_delivery_id text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  d public.alert_deliveries;
  c public.alert_channels;
begin
  select * into d from public.alert_deliveries where id = p_delivery_id;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  select * into c from public.alert_channels where id = d.channel_id for update;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  if c.audience = 'members' then
    insert into public.alert_suppressions (channel_id, workspace_id, recipient)
    values (c.id, c.workspace_id, d.recipient)
    on conflict do nothing;
    return jsonb_build_object('status', case when found then 'unsubscribed' else 'already' end, 'audience', 'members');
  end if;
  if c.unsubscribed_at is not null then
    return jsonb_build_object('status', 'already', 'audience', c.audience);
  end if;
  update public.alert_channels set unsubscribed_at = now() where id = c.id;
  return jsonb_build_object('status', 'unsubscribed', 'audience', c.audience);
end;
$fn$;

-- ── Telegram ─────────────────────────────────────────────────────────────────

-- A Telegram link for the member `p_created_by`: a channel waiting for a chat, holding the
-- SHA-256 of the one-time code its deep link carries. A member has one link waiting per
-- workspace: making another replaces it.
create or replace function public.create_telegram_link(p_workspace_id text, p_code_hash text, p_created_by text)
returns text
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_id text;
begin
  perform 1 from public.workspaces where id = p_workspace_id;
  if not found then
    raise exception 'not_found' using errcode = 'PT404';
  end if;
  delete from public.alert_channels
   where workspace_id = p_workspace_id and kind = 'telegram' and chat_id is null and created_by = p_created_by;
  insert into public.alert_channels (workspace_id, kind, confirm_hash, confirm_sent_at, created_by)
  values (p_workspace_id, 'telegram', p_code_hash, now(), p_created_by)
  returning id into v_id;
  return v_id;
end;
$fn$;

-- The bot's answer to `/start <code>`: binds the chat that sent it to the link's channel, once,
-- within `p_max_age_sec` of the link. A chat already bound in that workspace keeps its channel
-- (subscribed again if it had sent `/stop`) and the link's is dropped. Either way a test event
-- is queued for the member who made the link, which is the message that says it worked.
create or replace function public.bind_telegram_chat(p_code_hash text, p_max_age_sec integer, p_chat_id bigint, p_label text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v       public.alert_channels;
  v_bound text;
  v_event text;
begin
  if p_max_age_sec is null or p_max_age_sec < 60 then
    raise exception 'limits_required' using errcode = '22004';
  end if;
  select * into v from public.alert_channels where confirm_hash = p_code_hash and kind = 'telegram' for update;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  if v.confirm_sent_at < now() - make_interval(secs => p_max_age_sec) then
    return jsonb_build_object('status', 'expired');
  end if;

  select id into v_bound from public.alert_channels
   where workspace_id = v.workspace_id and chat_id = p_chat_id for update;
  if found then
    delete from public.alert_channels where id = v.id;
    update public.alert_channels
       set unsubscribed_at = null, label = coalesce(pg_catalog.left(nullif(btrim(p_label), ''), 120), label)
     where id = v_bound;
  else
    v_bound := v.id;
    update public.alert_channels
       set chat_id = p_chat_id, confirmed_at = now(), confirm_hash = null,
           label = pg_catalog.left(nullif(btrim(p_label), ''), 120)
     where id = v.id;
  end if;

  if v.created_by is not null then
    insert into public.alert_events (workspace_id, kind, channel_id, requested_by)
    values (v.workspace_id, 'test', v_bound, v.created_by)
    returning id into v_event;
  end if;
  return jsonb_build_object('status', case when v_bound = v.id then 'bound' else 'rebound' end,
                            'channelId', v_bound, 'workspaceId', v.workspace_id, 'eventId', v_event);
end;
$fn$;

-- `/stop` in a chat, or the bot removed from it: every channel bound to the chat stops
-- receiving. Answers how many did.
create or replace function public.telegram_stop(p_chat_id bigint)
returns integer
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  update public.alert_channels set unsubscribed_at = now()
   where chat_id = p_chat_id and kind = 'telegram' and unsubscribed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

-- ── what the Alerts screen reads ─────────────────────────────────────────────

-- One workspace's channels, what each leaves out, who unsubscribed, and its latest receipts with
-- their incidents' titles. Never a confirmation hash or a sealed credential.
create or replace function public.alert_overview(p_workspace_id text, p_limit integer)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $fn$
  select jsonb_build_object(
    'channels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'kind', c.kind, 'audience', c.audience, 'address', c.address, 'label', c.label,
               'confirmedAt', c.confirmed_at, 'confirmSentAt', c.confirm_sent_at, 'unsubscribedAt', c.unsubscribed_at,
               'createdAt', c.created_at, 'createdBy', c.created_by,
               'appsOff', coalesce((select jsonb_agg(x.app_id order by x.app_id) from public.alert_exclusions x where x.channel_id = c.id), '[]'::jsonb),
               'suppressed', coalesce((select jsonb_agg(s.recipient order by s.recipient) from public.alert_suppressions s where s.channel_id = c.id), '[]'::jsonb)
             ) order by (c.audience = 'members') desc, c.created_at, c.id)
        from public.alert_channels c
       where c.workspace_id = p_workspace_id
    ), '[]'::jsonb),
    'deliveries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'event', d.event, 'status', d.status, 'detail', d.detail, 'attempts', d.attempts,
               'providerId', d.provider_id, 'redirected', d.redirected, 'channelId', d.channel_id, 'recipient', d.recipient,
               'incidentId', d.incident_id, 'incidentTitle', i.title, 'createdAt', d.created_at, 'sentAt', d.sent_at
             ) order by d.created_at desc, d.id)
        from (select * from public.alert_deliveries x
               where x.workspace_id = p_workspace_id
               order by x.created_at desc, x.id
               limit greatest(1, least(coalesce(p_limit, 30), 200))) d
        left join public.incidents i on i.id = d.incident_id
    ), '[]'::jsonb)
  )
$fn$;

revoke all on function public.alert_members_channel(), public.alert_events_from_incident(),
  public.alert_pending_events(integer, text), public.alert_expand(text, text[]),
  public.alert_claim(text, integer, integer, text),
  public.alert_mark(text, text, text, text, text, integer, boolean),
  public.create_alert_address(text, text, text, text, boolean), public.confirm_alert_address(text, integer),
  public.alert_unsubscribe(text), public.alert_overview(text, integer),
  public.create_telegram_link(text, text, text), public.bind_telegram_chat(text, integer, bigint, text),
  public.telegram_stop(bigint)
  from public, anon, authenticated;
grant execute on function public.alert_members_channel(), public.alert_events_from_incident(),
  public.alert_pending_events(integer, text), public.alert_expand(text, text[]),
  public.alert_claim(text, integer, integer, text),
  public.alert_mark(text, text, text, text, text, integer, boolean),
  public.create_alert_address(text, text, text, text, boolean), public.confirm_alert_address(text, integer),
  public.alert_unsubscribe(text), public.alert_overview(text, integer),
  public.create_telegram_link(text, text, text), public.bind_telegram_chat(text, integer, bigint, text),
  public.telegram_stop(bigint)
  to service_role;

commit;
