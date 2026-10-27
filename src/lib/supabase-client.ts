import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* How the server's database client is made, in one place, for the two kinds of process that hold
   the secret key: the Next server (`db.ts`, behind `server-only`) and the alert sender when it
   runs outside Next in the local Postmark drill
   (`src/lib/alerts/standalone.ts`). Pure: it reads no environment, so the caller passes the URL
   and the key it parsed. */

/** A query that hangs holds a serverless function open until the platform
 *  kills it; ten seconds is longer than any query here should take. */
export const QUERY_TIMEOUT_MS = 10_000;

/** Realtime is never used (`AGENTS.md § 1.3`: polling, not Realtime), but
 *  supabase-js builds its Realtime client anyway and refuses to construct on a
 *  Node without a global `WebSocket` (Node 20 without a flag;
 *  `docs/integrations.md § Supabase › Gotchas`). This transport lets the client
 *  construct on any Node, and makes an accidental subscribe fail loudly instead
 *  of opening a socket. */
export class NoRealtime {
  constructor() {
    throw new Error("Staygreen does not use Supabase Realtime (AGENTS.md § 1.3)");
  }
}

export function createServerClient<Db>(url: string, secretKey: string): SupabaseClient<Db> {
  return createClient<Db>(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: NoRealtime as never },
    // Next patches `fetch` with a data cache. A dashboard read must never come
    // from it: a monitor saved a second ago has to be on the next render.
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, cache: "no-store", signal: init?.signal ?? AbortSignal.timeout(QUERY_TIMEOUT_MS) }),
    },
  });
}
