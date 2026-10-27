-- 018: apply ONLY after both probes run the build using 017's probe_* API.
-- Old binaries cannot run after this step. See docs/environments.md, Probes, for the rolling
-- sequence and the per-environment ALTER ROLE ... NOBYPASSRLS for both login roles.
-- No login roles or passwords belong in a migration. Idempotent; no data changes.
begin;
revoke all on all tables in schema public from probe;
revoke all on all sequences in schema public from probe;
revoke all on function public.new_id(text) from probe;
commit;