import type { Json } from "./database.types";

type Table<R, I = Partial<R>> = { Row: R; Insert: I; Update: Partial<R>; Relationships: [] };
export type ApiTokenRow = { id: string; workspace_id: string; name: string; kid: string; hash: string; scope: "read" | "write"; created_at: string; last_used_at: string | null; revoked_at: string | null };
export type ActivityRow = { id: string; workspace_id: string; actor: string; client: string; tool: string; resource_id: string; created_at: string };
export type AgentTables = {
  api_tokens: Table<ApiTokenRow>;
  agent_activity: Table<ActivityRow>;
  agent_requests: Table<{ workspace_id: string; actor: string; request_id: string; input_hash: string; tool: string; result: Json; created_at: string }>;
  agent_calls: Table<{ id: string; workspace_id: string | null; actor: string | null; client: string | null; auth: string; source: string; method: string; tool: string | null; status: number; outcome: string; duration_ms: number; shape: Json | null; created_at: string }>;
};
export type AgentFunctions = {
  agent_check_times: { Args: { p_workspace_id: string }; Returns: Json };
  agent_published_notes: { Args: { p_workspace_id: string; p_incident_ids: string[] }; Returns: Json };
  agent_token_create: { Args: { p_workspace_id: string; p_id: string; p_name: string; p_kid: string; p_hash: string; p_scope: string }; Returns: undefined };
  agent_budget: { Args: { p_key: string; p_limit: number }; Returns: number };
  agent_write: { Args: { p_workspace_id: string; p_actor: string; p_client: string; p_scope: string; p_tool: string; p_request_id: string; p_input_hash: string; p_payload: Json; p_limits: Json }; Returns: Json };
  agent_history: { Args: { p_workspace_id: string; p_monitor_id: string; p_days: number; p_limit: number; p_after: string | null }; Returns: Json };
  agent_response_times: { Args: { p_workspace_id: string; p_monitor_id: string; p_days: number; p_location: string | null; p_offset: number; p_limit: number }; Returns: Json };
};
