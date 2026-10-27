import { restrictedKey, type StripeConfig } from "../lib/service-monitor";
import { jsonObject, serviceFetch, within, type ServiceFetch } from "./service-fetch";
import { fail, type CheckResult } from "./types";

export type StripeEvent = { id: string; type: string; created: number; pending: number };
export type StripeObservation = { events: StripeEvent[]; disabled: string[]; at: number };
export type StripeRuntime = { seen?: string[] };
const API = "https://api.stripe.com/v1";
const MAX_EVENTS = 1000;
const PAGE_SIZE = 10;
const DAY = 86400;
const matches = (type: string, pattern: string) => pattern.endsWith(".*") ? type.startsWith(pattern.slice(0, -1)) : type === pattern;

/** The same age/window rules decide the verdict and which terminal ids an incident handled. */
export const affectedStripeEvents = (c: StripeConfig, seen: StripeObservation): StripeEvent[] =>
  seen.events.filter(e => e.pending > 0 ? e.created <= seen.at - c.pendingMin * 60 : e.created >= seen.at - c.windowMin * 60);

/** Stripe does not publish per-endpoint delivery attempts through List Events. Endpoint
 * selection checks endpoint status only; delivery evidence is explicitly account-wide. */
export function judgeStripe(c: StripeConfig, seen: StripeObservation, previous?: StripeRuntime, recovering = false): CheckResult {
  const affected = affectedStripeEvents(c, seen);
  // Terminal failures already handled by an earlier incident must not reopen it on the
  // third clean poll. Pending deliveries are never suppressed by the recovery cursor.
  const relevant = affected.filter(e => e.pending > 0 || !(previous?.seen ?? []).includes(e.id));
  const critical = relevant.some(e => c.critical.some(p => matches(e.type, p)));
  const pending = affected.filter(e => e.pending > 0).length;
  const failing = seen.disabled.length > 0 || (recovering ? relevant.length > 0 : relevant.length >= c.failureThreshold || critical);
  const types = [...new Set(affected.map(e => e.type))].sort();
  const oldest = affected.length ? new Date(Math.min(...affected.map(e => e.created)) * 1000).toISOString() : null;
  const detail = { scope: "account", eventTypes: types, count: affected.length, pending, oldestEventAt: oldest, disabled: seen.disabled };
  if (!failing) return { ok: true, ms: 0, detail };
  // The count, pending and oldest time come before the type list, so the 500-character cap
  // can only shorten the list (an account-wide failure can span dozens of types).
  const message = seen.disabled.length ? `Webhook endpoint disabled: ${seen.disabled.join(", ")}. Stripe does not identify who disabled it.`
    : `${affected.length} affected Stripe events across this account. ${pending} pending.${oldest ? ` Oldest affected event: ${oldest}.` : ""}${types.length ? ` Types: ${types.join(", ")}` : ""}`;
  return fail(0, "stripe", message.slice(0, 500), { detail });
}

/** Reads only. The negative permission check is a harmless Customers list, never a write
 * that an overprivileged key could execute. Its denial proves that permission alone;
 * Stripe offers no endpoint here that attests the key's entire permission set. */
export async function checkStripe(c: StripeConfig, key: string, o: {
  fetch?: ServiceFetch; timeoutMs?: number; now?: () => number; verifyKey?: boolean;
  runtime?: StripeRuntime; recovering?: boolean;
} = {}): Promise<CheckResult> {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  if (!restrictedKey(key)) return fail(ms(), "protocol", "Use a restricted rk_test_ or rk_live_ key. Secret keys are refused.");
  const fetch = within(o.fetch ?? serviceFetch(), o.timeoutMs);
  const headers = { Authorization: `Bearer ${key}`, accept: "application/json" };
  const read = async (path: string) => fetch(`${API}${path}`, headers, 0);
  if (o.verifyKey) {
    const denied = await read("/customers?limit=1");
    // Only an authenticated permission denial counts; a bad key, network error, rate limit
    // or generic 403 from an intermediary is not proof of restriction.
    if ("error" in denied || denied.status !== 403 || jsonObject(denied.body)?.error === undefined)
      return fail(ms(), "protocol", "The key must allow only Events and Webhook Endpoints read access; Customers access must be denied.");
    const error = jsonObject(denied.body)?.error as Record<string, unknown> | undefined;
    if (error?.type !== "invalid_request_error")
      return fail(ms(), "protocol", "Stripe did not confirm a permission denial. Check the restricted key and try again.");
  }
  const disabled: string[] = [];
  for (const id of c.endpoints) {
    if (!/^we_[A-Za-z0-9]{1,100}$/.test(id)) return fail(ms(), "protocol", "Choose valid webhook endpoint IDs.");
    const a = await read(`/webhook_endpoints/${id}`);
    if ("error" in a) return fail(ms(), a.error, "Stripe webhook endpoint status could not be read.");
    if (a.status !== 200) return fail(ms(), "status", `Stripe webhook endpoint lookup answered ${a.status}.`, { status: a.status });
    const endpoint = jsonObject(a.body);
    if (endpoint?.id !== id || !["enabled", "disabled"].includes(String(endpoint.status))) return fail(ms(), "protocol", "Stripe returned an invalid webhook endpoint.");
    if (endpoint.status === "disabled") disabled.push(id);
  }
  const at = Math.floor((o.now ?? Date.now)() / 1000);
  const events: StripeEvent[] = [];
  const ids = new Set<string>();
  let after = "";
  let pageSize = PAGE_SIZE;
  let requests = 0;
  const backlog = () => fail(ms(), "protocol", "Stripe's event backlog exceeds this check's limit; delivery health is unknown.");
  for (;;) {
    // At most 1,000 progressing pages plus one retry of a truncated multi-event page.
    if (++requests > MAX_EVENTS + 1) return backlog();
    const a = await read(`/events?delivery_success=false&created[gte]=${at - 30 * DAY}&created[lte]=${at}&limit=${pageSize}${after ? `&starting_after=${after}` : ""}`);
    if ("error" in a && a.code === "BODY_TOO_LARGE" && pageSize > 1) {
      // Retry the same cursor, then stay at one event. A multi-event page cut off by
      // our byte budget says nothing about delivery health; a single oversized event
      // cannot be split further, so that case still fails closed below.
      pageSize = 1;
      continue;
    }
    if ("error" in a) return fail(ms(), a.error, "Stripe events could not be read.");
    if (a.status !== 200) return fail(ms(), "status", `Stripe events answered ${a.status}.`, { status: a.status });
    const list = jsonObject(a.body);
    if (!Array.isArray(list?.data) || typeof list.has_more !== "boolean" || list.data.length > pageSize) return fail(ms(), "protocol", "Stripe returned an invalid event list.");
    for (const raw of list.data) {
      const e = raw as Record<string, unknown> | null;
      if (!e || typeof e.id !== "string" || !/^evt_[A-Za-z0-9]{1,100}$/.test(e.id) || typeof e.type !== "string" || !/^[a-z0-9_.]{1,150}$/.test(e.type)
        || !Number.isSafeInteger(e.created) || Number(e.created) < 0 || Number(e.created) > 253402300799 || !Number.isSafeInteger(e.pending_webhooks) || Number(e.pending_webhooks) < 0)
        return fail(ms(), "protocol", "Stripe returned an invalid event.");
      if (ids.has(e.id)) continue;
      if (events.length >= MAX_EVENTS) return backlog();
      ids.add(e.id);
      events.push({ id: e.id, type: e.type, created: Number(e.created), pending: Number(e.pending_webhooks) });
    }
    if (!list.has_more) break;
    const last = events.at(-1)?.id;
    if (!last || last === after || events.length >= MAX_EVENTS) return backlog();
    after = last;
  }
  const observation: StripeObservation = { events, disabled, at };
  const verdict = judgeStripe(c, observation, o.runtime, o.recovering);
  return { ...verdict, ms: ms(), detail: { ...verdict.detail, observation, verified: o.verifyKey === true } };
}
