import "server-only";
import { db } from "../db";
import { env } from "../env";
import { CONFIRM_MAX_AGE_SEC, hashConfirmToken, isConfirmToken, linkSecret, readUnsubscribeToken } from "./links";

/* The two things a link in an email does without a sign-in (`spec.md § 5`): stop alerts, and
   confirm an address. The token is the whole authority, so each is checked before a query is
   spent: an unsubscribe link's signature (`links.ts`), a confirmation's shape and then its hash.
   Neither ever acts on a GET: mail scanners open links, so the page asks and a button does it,
   and only the one-click POST of RFC 8058 acts at once (`/api/alerts/unsubscribe/[token]`). */

export type UnsubscribeOutcome = "unsubscribed" | "already" | "gone" | "invalid" | "unavailable";

/** Whether a token is one this server signed, before anything is shown for it. */
export function unsubscribeTokenValid(token: string): boolean {
  const secret = env().ALERT_LINK_SECRET;
  return !!secret && readUnsubscribeToken(linkSecret(secret), token) !== null;
}

export async function unsubscribeByToken(token: string): Promise<{ outcome: UnsubscribeOutcome; members: boolean }> {
  const secret = env().ALERT_LINK_SECRET;
  if (!secret) return { outcome: "unavailable", members: false };
  const id = readUnsubscribeToken(linkSecret(secret), token);
  if (!id) return { outcome: "invalid", members: false };
  const { data, error } = await db().rpc("alert_unsubscribe", { p_delivery_id: id });
  if (error) throw new Error(`alert_unsubscribe failed: ${error.code}`);
  const r = (data ?? {}) as { status?: string; audience?: string };
  const outcome: UnsubscribeOutcome = r.status === "unsubscribed" || r.status === "already" ? r.status : "gone";
  return { outcome, members: r.audience === "members" };
}

export type ConfirmOutcome = "confirmed" | "expired" | "missing";

export async function confirmByToken(token: string): Promise<ConfirmOutcome> {
  if (typeof token !== "string" || !isConfirmToken(token)) return "missing";
  const { data, error } = await db().rpc("confirm_alert_address", { p_confirm_hash: hashConfirmToken(token), p_max_age_sec: CONFIRM_MAX_AGE_SEC });
  if (error) throw new Error(`confirm_alert_address failed: ${error.code}`);
  const status = (data as { status?: string } | null)?.status;
  return status === "confirmed" || status === "expired" ? status : "missing";
}
