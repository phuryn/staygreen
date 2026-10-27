import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database as Generated } from "./database.types";
import { env } from "./env";
import { createServerClient, NoRealtime } from "./supabase-client";
import type { AgentFunctions, AgentTables } from "./agent-database.types";

/* The one database client (`AGENTS.md § 1.4`): the server is the only Supabase
   client there is, it holds the secret key, and no browser ever sees a key.
   RLS is on with zero policies, so this key is also the only thing that can
   read anything. The tenant isolation is `authz.ts`, not RLS. */

/** The generator types every function argument as non-null, because Postgres
 *  does not say which ones accept null. These do, and the functions read a
 *  null as "none" (`supabase/migrations/`). Everything else stays as generated. */
type WithNullable<F extends { Args: object }, K extends keyof F["Args"]> = Omit<F, "Args"> & {
  Args: Omit<F["Args"], K> & { [P in K]: F["Args"][P] | null };
};
type Fns = Generated["public"]["Functions"];
type Functions = Omit<Fns, "create_monitor" | "create_status_page" | "save_status_page" | "save_incident_note" | "pause_monitor"> & {
  create_monitor: WithNullable<Fns["create_monitor"], "p_id" | "p_target_host" | "p_heartbeat_token_hash" | "p_secrets" | "p_heartbeat_token_sealed">;
  create_status_page: WithNullable<Fns["create_status_page"], "p_homepage">;
  save_status_page: WithNullable<Fns["save_status_page"], "p_homepage">;
  save_incident_note: WithNullable<Fns["save_incident_note"], "p_note_id" | "p_author_user_id" | "p_author_client">;
  pause_monitor: WithNullable<Fns["pause_monitor"], "p_minutes">;
};
export type Database = Omit<Generated, "public"> & { public: Omit<Generated["public"], "Functions" | "Tables"> & { Functions: Functions & AgentFunctions; Tables: Generated["public"]["Tables"] & AgentTables } };
export type Row<T extends keyof Database["public"]["Tables"]> = Database["public"]["Tables"][T]["Row"];

// The client options (no session, no Realtime, no cache, a timeout on every query) live in
// `supabase-client.ts`, shared with the alert sender when it runs outside Next.
export { NoRealtime };

let client: SupabaseClient<Database> | null = null;

export function db(): SupabaseClient<Database> {
  if (!client) {
    const { SUPABASE_URL, SUPABASE_SECRET_KEY } = env();
    client = createServerClient<Database>(SUPABASE_URL, SUPABASE_SECRET_KEY);
  }
  return client;
}
