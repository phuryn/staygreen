/** Exact signatures: a new definer or grant must earn a deliberate addition, not match a prefix. */
export const PROBE_FUNCTIONS = [
  "probe_builder_workspaces(text[])",
  "probe_commit_heartbeat(text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,bigint,timestamp with time zone,text,jsonb)",
  "probe_commit_monitor(text,text,timestamp with time zone,text,integer,integer,integer,text[],jsonb)",
  "probe_flush_rollups(text[],text[],timestamp with time zone[],integer[],integer[],integer[],integer[],integer[])",
  "probe_flush_with_receipt(text,text[],text[],timestamp with time zone[],integer[],integer[],integer[],integer[],integer[])",
  "probe_heartbeat(text,text,boolean,text)",
  "probe_leave(text)",
  "probe_live()",
  "probe_load_domains(text[])",
  "probe_load_heartbeats(text[])",
  "probe_load_monitors(text[])",
  "probe_load_service_monitors(text[])",
  "probe_lock_heartbeat(text)",
  "probe_lock_monitor(text)",
  "probe_record_domain(text,text,text,timestamp with time zone,text,text)",
];

/** The heartbeat Worker's one function (migration 019), executable by `ingest` alone. */
export const INGEST_FUNCTIONS = ["record_heartbeat(text,text,jsonb,text)"];
export const WATCHDOG_FUNCTIONS = ["watchdog_flush_status(text[])"];

/** Every `security definer` function in `public`: the two roles' APIs and nothing else. */
export const DEFINER_FUNCTIONS = [...PROBE_FUNCTIONS, ...INGEST_FUNCTIONS, ...WATCHDOG_FUNCTIONS].sort();
