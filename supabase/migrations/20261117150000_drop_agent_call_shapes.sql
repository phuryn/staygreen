-- Call shapes were temporary (20261027090000_agent_call_shapes.sql): the app wrote them until
-- 2026-11-10 and no longer names the column. Dropping it deletes what was recorded, on the owner's
-- word (2026-11-17, "Do what you want with the column"); the column's own check goes with it.
-- The build in production when this applies never writes the column after 2026-11-10, so the order
-- against the release that removes the code does not matter.
alter table public.agent_calls drop column if exists shape;
