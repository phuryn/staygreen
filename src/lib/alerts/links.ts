import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/* The two links an alert email can carry that act without a sign-in (`spec.md § 5`):

   - **Unsubscribe**, in every alert: `<delivery id>.<signature>`. The signature is an HMAC of the
     receipt's id under `ALERT_LINK_SECRET`, so the link names exactly the recipient that receipt
     reached and nobody can make one for another address without the secret. It is deterministic,
     so a retried send carries the same link as the first try. It never expires: an old email's
     link keeps working.
   - **Confirmation**, for an address that isn't a member's: a random 256-bit token whose
     SHA-256 is stored on the channel, good once and for `CONFIRM_MAX_AGE_SEC`.

   Pure: the secret is passed in, never read from the environment here. */

/** How long a confirmation link works, from the email that carried it. */
export const CONFIRM_MAX_AGE_SEC = 7 * 24 * 60 * 60;

const DELIVERY_ID = /^dlv_[0-9a-f]{24}$/;
const sign = (secret: Buffer, deliveryId: string) => createHmac("sha256", secret).update(`staygreen/unsubscribe/v1/${deliveryId}`).digest("base64url");

export function unsubscribeToken(secret: Buffer, deliveryId: string): string {
  if (!DELIVERY_ID.test(deliveryId)) throw new Error("not a delivery id");
  return `${deliveryId}.${sign(secret, deliveryId)}`;
}

/** The delivery id a token names, or null for anything that isn't a token this secret signed. */
export function readUnsubscribeToken(secret: Buffer, token: string): string | null {
  if (typeof token !== "string" || token.length > 120) return null;
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!DELIVERY_ID.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  const want = Buffer.from(sign(secret, id));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? id : null;
}

/** The secret, from its base64url form in the environment (32 bytes, checked by the env schema). */
export const linkSecret = (encoded: string) => Buffer.from(encoded, "base64url");

export function newConfirmToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashConfirmToken(token) };
}

export const hashConfirmToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A token's shape, checked before a database read is spent on it. */
export const isConfirmToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);

export function unsubscribeUrls(appUrl: string, token: string): { page: string; oneClick: string } {
  const base = appUrl.replace(/\/+$/, "");
  return { page: `${base}/unsubscribe/${token}`, oneClick: `${base}/api/alerts/unsubscribe/${token}` };
}

/** The body RFC 8058 has a mail provider POST to the one-click address: the form field
 *  `List-Unsubscribe=One-Click`. Anything else that POSTs the header's URL (a client that only
 *  follows it, a scanner) stops nothing. */
export const isOneClickBody = (body: string) => body.split("&").some((pair) => pair.trim() === "List-Unsubscribe=One-Click");

export const confirmUrl = (appUrl: string, token: string) => `${appUrl.replace(/\/+$/, "")}/alerts/confirm/${token}`;
