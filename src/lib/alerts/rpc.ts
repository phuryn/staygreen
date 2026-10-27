import type { SupabaseClient } from "@supabase/supabase-js";
import type pg from "pg";

/* How the sender calls its SQL functions (`supabase/migrations/…_alerts_email.sql`), whatever
   holds the connection: the server's Supabase client (dashboard tests), a `pg` client through the sender's
   Hyperdrive, or a local Postgres pool (integration tests and the drill). Every function here returns one value (a
   JSON document, a row, a scalar), and both adapters answer it as JSON. */

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

export class RpcError extends Error {
  constructor(
    readonly fn: string,
    readonly code: string | null,
  ) {
    super(`${fn} failed${code ? `: ${code}` : ""}`);
    this.name = "RpcError";
  }
}

export function rpcFromSupabase(client: SupabaseClient<never>): Rpc {
  return async (fn, args) => {
    const { data, error } = await (client.rpc as (f: string, a: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { code?: string } | null }>)(fn, args);
    if (error) throw new RpcError(fn, error.code ?? null);
    return data;
  };
}

const NAME = /^[a-z_][a-z0-9_]*$/;

export function rpcFromPg(pool: Pick<pg.Pool, "query">, schema = "public"): Rpc {
  if (!NAME.test(schema)) throw new Error("not a schema name");
  return async (fn, args) => {
    const keys = Object.keys(args);
    if (!NAME.test(fn) || !keys.every((k) => NAME.test(k))) throw new Error("not a function or argument name");
    // `to_jsonb` answers as PostgREST does: a row as an object, a scalar as itself.
    const sql = `select to_jsonb(${schema}.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})) as r`;
    try {
      const r = await pool.query(sql, keys.map((k) => args[k]));
      return r.rows[0]?.r ?? null;
    } catch (e) {
      throw new RpcError(fn, (e as { code?: string }).code ?? null);
    }
  };
}
