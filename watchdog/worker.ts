import { Client } from "pg";
import { config, inspect, telegram, type FlushStatus, type Receipts } from "./check";

type Env = {
  HYPERDRIVE: { connectionString: string };
  WATCHDOG_PROBES: string;
  WATCHDOG_TELEGRAM_CHAT_ID: string;
  TELEGRAM_BOT_TOKEN: string;
  WATCHDOG: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string): Promise<Response> } };
};

/** One SQLite-backed object serializes cron deliveries and holds durable receipts. Its fetch
 * is accessible only through this binding. There is no public cron or administration route. */
export class Watchdog {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private state: { storage: Receipts }, private env: Env) {}

  fetch(): Promise<Response> {
    const job = this.tail.then(async () => {
      const e = config(this.env);
      await inspect(e.WATCHDOG_PROBES, {
        receipts: this.state.storage,
        send: (text) => telegram(e.TELEGRAM_BOT_TOKEN, e.WATCHDOG_TELEGRAM_CHAT_ID, text),
        read: async (ids) => {
          const c = new Client({ connectionString: this.env.HYPERDRIVE.connectionString, connectionTimeoutMillis: 4_000, query_timeout: 4_000 });
          try {
            await c.connect();
            const { rows } = await c.query<FlushStatus>("select * from public.watchdog_flush_status($1::text[])", [ids]);
            return rows;
          } finally { await c.end().catch(() => {}); }
        },
      });
      return new Response(null, { status: 204 });
    });
    this.tail = job.catch(() => {});
    return job.catch(() => {
      console.error("watchdog run failed; check configuration or Telegram delivery");
      return new Response(null, { status: 503 });
    });
  }
}

export default {
  fetch() { return new Response(null, { status: 404 }); },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const r = await env.WATCHDOG.get(env.WATCHDOG.idFromName("fleet")).fetch("https://watchdog.internal/run");
    if (!r.ok) throw new Error("watchdog scheduled run failed");
  },
};
