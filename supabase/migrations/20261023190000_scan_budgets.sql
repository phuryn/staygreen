-- 033: transient abuse counters only. No targets, keys, results or raw IPs.
begin;
create table if not exists public.scan_budgets (
  key text primary key check (key = 'global' or key ~ '^(ip|agent):[a-f0-9]{64}$'),
  used integer not null check (used >= 0),
  expires_at timestamptz not null
);
create index if not exists scan_budgets_expiry on public.scan_budgets(expires_at);
alter table public.scan_budgets enable row level security;
revoke all on public.scan_budgets from public, anon, authenticated;
grant select, insert, update, delete on public.scan_budgets to service_role;

-- One lock order: global, then actor. A refusal spends neither budget. Global
-- serialization bounds live actor rows to at most 1,100 across overlapping windows.
create or replace function public.admit_scan(p_key text) returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  t timestamptz := clock_timestamp();
  g public.scan_budgets; a public.scan_budgets;
  cap integer;
begin
  if p_key is null or p_key !~ '^(ip|agent):[a-f0-9]{64}$' then
    raise exception 'invalid_scan_actor' using errcode = '22023';
  end if;
  cap := case when p_key like 'ip:%' then 5 else 10 end;
  insert into public.scan_budgets values ('global', 0, t + interval '1 minute') on conflict do nothing;
  select * into g from public.scan_budgets where key = 'global' for update;
  -- Use the time after the lock wait, so a queued caller cannot spend an old window.
  t := clock_timestamp();
  if g.expires_at <= t then
    update public.scan_budgets set used = 0, expires_at = t + interval '1 minute' where key = 'global' returning * into g;
  end if;
  delete from public.scan_budgets where key <> 'global' and expires_at <= t;
  if g.used >= 100 then return greatest(1, ceil(extract(epoch from g.expires_at - t))::integer); end if;
  insert into public.scan_budgets values (p_key, 0, t + interval '10 minutes') on conflict do nothing;
  select * into a from public.scan_budgets where key = p_key for update;
  if a.used >= cap then return greatest(1, ceil(extract(epoch from a.expires_at - t))::integer); end if;
  update public.scan_budgets set used = used + 1 where key in ('global', p_key);
  return 0;
end;
$$;
revoke all on function public.admit_scan(text) from public, anon, authenticated;
grant execute on function public.admit_scan(text) to service_role;
commit;
