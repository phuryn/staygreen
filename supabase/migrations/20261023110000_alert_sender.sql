-- 027: additive sender boundary, after sibling migration 026 (20261023100000).
-- No public function, table, receipt or lease changes: an old service-role sender can overlap.
begin;

do $fn$ begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'alert_sender') then
    create role alert_sender nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
end $fn$;

-- Not exposed through PostgREST. Definers live here rather than widening the public APIs.
create schema if not exists alert_sender authorization postgres;
revoke all on schema alert_sender from public, anon, authenticated, service_role, probe, ingest, watchdog, alert_sender;
grant usage on schema alert_sender to alert_sender;
-- PUBLIC's function default is global; a per-schema REVOKE alone cannot remove it.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema alert_sender revoke all on functions from anon, authenticated, service_role, probe, ingest, watchdog, alert_sender;
alter default privileges for role postgres in schema alert_sender revoke all on tables from public, anon, authenticated, service_role, probe, ingest, watchdog, alert_sender;
alter default privileges for role postgres in schema alert_sender revoke all on sequences from public, anon, authenticated, service_role, probe, ingest, watchdog, alert_sender;

create or replace function alert_sender.alert_pending_events(p_limit integer, p_event_id text)
returns jsonb language sql security definer set search_path = '' as $fn$
  select public.alert_pending_events(p_limit, p_event_id);
$fn$;
alter function alert_sender.alert_pending_events(p_limit integer, p_event_id text) owner to postgres;

create or replace function alert_sender.alert_expand(p_event_id text, p_members text[])
returns jsonb language sql security definer set search_path = '' as $fn$
  select public.alert_expand(p_event_id, p_members);
$fn$;
alter function alert_sender.alert_expand(p_event_id text, p_members text[]) owner to postgres;

create or replace function alert_sender.alert_claim(p_claim text, p_limit integer, p_lease_sec integer, p_event_id text)
returns jsonb language sql security definer set search_path = '' as $fn$
  select public.alert_claim(p_claim, p_limit, p_lease_sec, p_event_id);
$fn$;
alter function alert_sender.alert_claim(p_claim text, p_limit integer, p_lease_sec integer, p_event_id text) owner to postgres;

create or replace function alert_sender.alert_mark(p_id text, p_claim text, p_status text, p_provider_id text, p_detail text, p_retry_sec integer, p_redirected boolean)
returns boolean language sql security definer set search_path = '' as $fn$
  select public.alert_mark(p_id, p_claim, p_status, p_provider_id, p_detail, p_retry_sec, p_redirected);
$fn$;
alter function alert_sender.alert_mark(p_id text, p_claim text, p_status text, p_provider_id text, p_detail text, p_retry_sec integer, p_redirected boolean) owner to postgres;

create or replace function alert_sender.bind_telegram_chat(p_code_hash text, p_max_age_sec integer, p_chat_id bigint, p_label text)
returns jsonb language sql security definer set search_path = '' as $fn$
  select public.bind_telegram_chat(p_code_hash, p_max_age_sec, p_chat_id, p_label);
$fn$;
alter function alert_sender.bind_telegram_chat(p_code_hash text, p_max_age_sec integer, p_chat_id bigint, p_label text) owner to postgres;

create or replace function alert_sender.telegram_stop(p_chat_id bigint)
returns integer language sql security definer set search_path = '' as $fn$
  select public.telegram_stop(p_chat_id);
$fn$;
alter function alert_sender.telegram_stop(p_chat_id bigint) owner to postgres;

revoke all on all functions in schema alert_sender from public, anon, authenticated, service_role, probe, ingest, watchdog, alert_sender;
grant execute on function alert_sender.alert_pending_events(p_limit integer, p_event_id text) to alert_sender;
grant execute on function alert_sender.alert_expand(p_event_id text, p_members text[]) to alert_sender;
grant execute on function alert_sender.alert_claim(p_claim text, p_limit integer, p_lease_sec integer, p_event_id text) to alert_sender;
grant execute on function alert_sender.alert_mark(p_id text, p_claim text, p_status text, p_provider_id text, p_detail text, p_retry_sec integer, p_redirected boolean) to alert_sender;
grant execute on function alert_sender.bind_telegram_chat(p_code_hash text, p_max_age_sec integer, p_chat_id bigint, p_label text) to alert_sender;
grant execute on function alert_sender.telegram_stop(p_chat_id bigint) to alert_sender;
commit;

