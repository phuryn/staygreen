-- What clients send /mcp, as names and shapes, never values (`src/lib/agent-shapes.ts`).
-- Temporary: the app writes it until 2026-11-10, and a later migration drops the column.
-- Apply before the app that writes it: a call log naming an unknown column is lost.
alter table public.agent_calls add column if not exists shape jsonb
  check (shape is null or (jsonb_typeof(shape) = 'object' and octet_length(shape::text) <= 4096));
