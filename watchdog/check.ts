import { z } from "zod";
import { parseConfig, probeId } from "../probe/env";
import { isLocationId, locations } from "../src/lib/plans";

export const watchdogSchema = z.object({
  WATCHDOG_PROBES: z.string().transform((v) => v.split(",")).pipe(z.array(probeId).min(1).max(100))
    .refine((ids) => new Set(ids).size === ids.length),
  WATCHDOG_TELEGRAM_CHAT_ID: z.string().regex(/^-?[0-9]{1,20}$/),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$/),
});
export type FlushStatus = { id: string; flushed_at: string | Date | null; age_sec: number | null };
export type Receipt = { state: "stale" | "healthy"; at: number; event: string };
export type Receipts = { get(key: string): Promise<Receipt | undefined>; put(key: string, value: Receipt): Promise<unknown> };
export type WatchdogDeps = {
  read(ids: string[]): Promise<FlushStatus[]>;
  receipts: Receipts;
  send(text: string): Promise<boolean>;
  now?: () => number;
};
const STALE_SEC = 600;
const REMIND_MS = 30 * 60_000;
const CHECK = "Check: npm run ops -- status";

/** The operator reads these on a phone: the probe by its city, what is known, what it means and
 * what to run. The event id stays in the receipt, not the message. */
const probeCity = (id: string) => {
  const loc = id.split("-")[0];
  return isLocationId(loc) ? locations[loc].city : id;
};
const probeName = (id: string) => `the ${probeCity(id)} probe (${id})`;
const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
const ago = (sec: number) => (sec < 60 ? "less than a minute ago" : sec < 120 ? "1 minute ago"
  : sec < 5400 ? `${Math.floor(sec / 60)} minutes ago` : `${Math.round(sec / 3600)} hours ago`);
const fresh = (row: FlushStatus) => row.flushed_at !== null && row.age_sec !== null && row.age_sec < STALE_SEC;
export function staleText(row: FlushStatus, now: number, rows: readonly FlushStatus[]): string {
  const who = probeName(row.id);
  const last = row.age_sec === null || row.flushed_at === null
    ? "hasn't sent its numbers yet."
    : `hasn't sent its numbers since ${utc(now - row.age_sec * 1000)}, ${ago(row.age_sec)}.`;
  // Flush receipts prove only that numbers arrived, not heartbeats, monitor ownership or outcomes.
  const peers = rows.filter((r) => r.id !== row.id && fresh(r)).map((r) => probeCity(r.id));
  const fleet = peers.length ? `Still sending: ${[...new Set(peers)].join(", ")}.`
    : "No probe is sending, so monitors may not be checked at all.";
  return `Staygreen: ${who} ${last} ${fleet} ${CHECK}`;
}
// The clock time alone would read as today after an outage of a day or more, so the age goes with it.
const recoveredText = (id: string, since: number, now: number) =>
  `Staygreen: ${probeName(id)} is sending its numbers again. It was first flagged at ${utc(since)}, ${ago((now - since) / 1000)}. ${CHECK}`;
const DATABASE_DOWN = "Staygreen: the watchdog can't read the probes' records, so it can't tell whether they're healthy. Check the database and the watchdog's Hyperdrive.";
const DATABASE_BACK = "Staygreen: the watchdog can read the probes' records again.";

/** Persist successful sends outside Postgres. A failed/ambiguous Telegram call stays retryable;
 * Telegram offers no idempotency key, so an accepted send whose answer is lost can be duplicated.
 * Healthy runs are read-only. Every outage gets an alert, a 30-minute reminder, and a recovery. */
export async function inspect(ids: string[], d: WatchdogDeps): Promise<void> {
  const now = (d.now ?? Date.now)();
  const notify = async (id: string, stale: boolean, text: (was: Receipt | undefined) => string) => {
    const key = `receipt:${id}`;
    const was = await d.receipts.get(key);
    if (!stale && (!was || was.state === "healthy")) return;
    if (stale && was?.state === "stale" && now - was.at < REMIND_MS) return;
    const event = stale && was?.state === "stale" ? was.event : `${id}:${now}`;
    if (!(await d.send(text(was)))) throw new Error("watchdog: Telegram delivery failed; receipt remains retryable");
    await d.receipts.put(key, { state: stale ? "stale" : "healthy", at: now, event });
  };

  let rows: FlushStatus[];
  try {
    rows = await d.read(ids);
    // A partial/malformed snapshot is a failed read, never a green fleet.
    if (rows.length !== ids.length || ids.some((id) => rows.filter((r) => r.id === id).length !== 1) ||
        rows.some((r) => r.age_sec !== null && !Number.isFinite(r.age_sec))) throw new Error("invalid snapshot");
  } catch {
    await notify("database", true, () => DATABASE_DOWN);
    return;
  }
  await notify("database", false, () => DATABASE_BACK);
  for (const id of ids) {
    const row = rows.find((r) => r.id === id)!;
    const stale = !fresh(row);
    await notify(id, stale, (was) => {
      // `at` tracks the latest send for reminders; the event suffix keeps the first flag time.
      const firstFlaggedAt = was ? Number(was.event.slice(was.event.lastIndexOf(":") + 1)) : now;
      return stale ? staleText(row, now, rows) : recoveredText(id, firstFlaggedAt, now);
    });
  }
}

export async function telegram(token: string, chat: string, text: string, request: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return false;
    return (await r.json() as { ok?: boolean }).ok === true;
  } catch { return false; } // Never log a URL containing the bot token, or a provider response.
}

export const config = (env: unknown) => parseConfig(watchdogSchema, env, "watchdog");
