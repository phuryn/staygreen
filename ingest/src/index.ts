import { Client } from "pg";
import { Breaker, handle, LimitCache, type Kind, type Note, type Recorded } from "./handler";

/* The heartbeat Worker (`AGENTS.md § 2.3` item 3, `spec.md § 9`): `in.staygreen.io` in
   production. It connects as its environment's `ingest` login through Hyperdrive, whose
   connection string is a binding, never a value in this repository (`wrangler.toml`,
   `docs/environments.md` § Heartbeat ingest). One query per ping: `record_heartbeat`, the only
   thing that role may run. A new client per request is Hyperdrive's model: it pools the
   connections to Postgres itself. `HEARTBEAT_TOKEN_KEY` is a Worker secret
   (`npx wrangler secret put`), read from `.dev.vars` under `wrangler dev`. */

type Env = { HYPERDRIVE: { connectionString: string }; HEARTBEAT_TOKEN_KEY?: string };
type Context = { waitUntil(promise: Promise<unknown>): void };

// Per instance: what the database refused this minute, and whether a call to it just failed.
const limited = new LimitCache();
const breaker = new Breaker();

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    const record = async (hash: string, kind: Kind, payload: Record<string, unknown>, note: Note | null): Promise<Recorded> => {
      // Bounded, so a database that hangs fails the call (and opens the breaker) inside the ping
      // lines' 10-second limit instead of holding the job's request open.
      const client = new Client({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 4_000, query_timeout: 4_000 });
      try {
        await client.connect();
        const { rows } = await client.query("select public.record_heartbeat($1, $2, $3::jsonb, $4) as r", [hash, kind, JSON.stringify(payload), note]);
        return rows[0].r as Recorded;
      } finally {
        ctx.waitUntil(client.end().catch(() => {}));
      }
    };
    return handle(request, { record, tokenKey: env.HEARTBEAT_TOKEN_KEY, cache: limited, breaker });
  },
};
