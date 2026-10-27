import { Client } from "pg";
import { config, type Config } from "./config";
import { membersOf } from "../src/lib/alerts/clerk";
import { linkSecret } from "../src/lib/alerts/links";
import { rpcFromPg, type Rpc } from "../src/lib/alerts/rpc";
import { SCHEDULED_DEADLINE_MS, summary } from "../src/lib/alerts/scheduled";
import { runSender, type SenderDeps } from "../src/lib/alerts/sender";
import { handleUpdate, webhookAuthorized } from "../src/lib/alerts/telegram";
import { pinnedWebhookTransport } from "../src/lib/alerts/webhook";

export type Env = Partial<Record<keyof Config, string>> & { HYPERDRIVE: { connectionString: string } };
export type Connection = { rpc: Rpc; close(): Promise<void> };

async function connect(env: Env): Promise<Connection> {
  // Hyperdrive pools upstream. A fresh client belongs to this event alone, never an isolate.
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 4_000, query_timeout: 4_000 });
  // pg makes a dropped client unqueryable and rejects current/future queries. Absorb the idle
  // error event so it cannot kill the invocation outside our awaited RPC error handling.
  client.on("error", () => {});
  try { await client.connect(); }
  catch { await client.end().catch(() => {}); throw new Error("Sender database unavailable"); }
  return { rpc: rpcFromPg(client as unknown as Pick<import("pg").Pool, "query">, "alert_sender"), close: () => client.end() };
}

function deps(e: Config, rpc: Rpc, doFetch: typeof fetch, log: (line: string) => void): SenderDeps {
  return {
    rpc, appUrl: e.APP_URL, linkSecret: linkSecret(e.ALERT_LINK_SECRET), log,
    postmark: { token: e.POSTMARK_SERVER_TOKEN, from: e.EMAIL_FROM, stream: "outbound", redirectTo: e.EMAIL_REDIRECT_TO ?? null, fetch: doFetch },
    telegram: { token: e.TELEGRAM_BOT_TOKEN, fetch: doFetch },
    members: (org) => membersOf(e.CLERK_SECRET_KEY, org, doFetch),
    channels: { key: Buffer.from(e.CREDENTIALS_KEY, "base64url"), fetch: doFetch, webhook: pinnedWebhookTransport() },
  };
}

export const WEBHOOK_PATH = "/api/telegram/webhook";
export const MAX_UPDATE_BYTES = 64 * 1024;

/** Read incrementally: neither a missing nor understated Content-Length bypasses the limit. */
async function readUpdate(req: Request): Promise<{ value: unknown } | { status: number }> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return { status: 415 };
  const reader = req.body?.getReader();
  if (!reader) return { status: 400 };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPDATE_BYTES) { await reader.cancel(); return { status: 413 }; }
      chunks.push(value);
    }
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch { return { status: 400 }; }
  finally { reader.releaseLock(); }
}

// The injected boundaries drive the actual handlers in unit tests, without Cloudflare or a DB.
export function createWorker(open = connect, doFetch: typeof fetch = fetch, log: (line: string) => void = console.log) {
  const withConnection = async <T>(env: Env, work: (d: SenderDeps) => Promise<T>) => {
    const e = config(env); // Validate before a connection or a provider call.
    const c = await open(env);
    try { return await work(deps(e, c.rpc, doFetch, log)); }
    finally { await c.close().catch(() => {}); }
  };
  return {
    async scheduled(_event: unknown, env: Env): Promise<void> {
      try {
        // Claim only what we are about to deliver: a broken connection cannot release a batch
        // of unstarted claims, and their expired leases would falsely imply Telegram was sent.
        const r = await withConnection(env, (d) => runSender(d, { batch: 1, deadlineMs: SCHEDULED_DEADLINE_MS }));
        log(`[alerts] ${summary(r)}`);
      } catch {
        // No driver errors, URLs, provider bodies, addresses or credentials in runtime logs.
        throw new Error("Sender scheduled run failed; check configuration and database availability");
      }
    },
    async fetch(req: Request, env: Env): Promise<Response> {
      if (new URL(req.url).pathname !== WEBHOOK_PATH) return new Response(null, { status: 404 });
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
      if (!env.TELEGRAM_WEBHOOK_SECRET) return new Response(null, { status: 503 });
      // Telegram is a server caller, so its secret replaces browser Origin validation. Check
      // it before reading a byte, connecting to Postgres or calling any provider.
      if (!webhookAuthorized(req.headers.get("x-telegram-bot-api-secret-token"), env.TELEGRAM_WEBHOOK_SECRET)) return new Response(null, { status: 401 });
      const body = await readUpdate(req);
      if ("status" in body) return new Response(null, { status: body.status });
      try {
        await withConnection(env, (d) => handleUpdate({
          rpc: d.rpc, telegram: d.telegram!, appUrl: d.appUrl, log,
          deliver: (eventId) => runSender(d, { eventId, batch: 1, deadlineMs: 8_000 }),
        }, body.value));
      } catch {
        // Preserve the old webhook's acknowledgement policy: an uncertain reply must not be
        // repeated. A bound chat's queued test is durable and the cron will finish it.
        log("[telegram] update failed; not replayed");
      }
      return new Response(null, { status: 200 });
    },
  };
}

export default createWorker();
