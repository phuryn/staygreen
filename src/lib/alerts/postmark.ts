/* Postmark's HTTP API, with plain `fetch` (`docs/integrations.md § Postmark`): one send, and one
   search that tells the sender whether a message it may have sent already reached Postmark.

   Postmark has no idempotency key (its support article says so, checked 2026-10-22), so a
   receipt's id travels in each message's `Metadata` and the outbound search can find it again by
   that alone (`metadata_<key>=<value>`). That is how a claim that stopped after Postmark accepted
   the message is settled without a second send (`sender.ts`).

   Every outcome is sorted into what the sender can act on:
   - `sent`: Postmark accepted it, with its MessageID.
   - `rejected`: Postmark answered and refused this message; sending it again can't help.
   - `retry`: Postmark answered and didn't take it, or the request never left; try later.
   - `unknown`: the request may have reached Postmark and no answer came back. Never retried
     blind: the receipt stays claimed, and the search settles it once the claim's lease is over.

   Never a response body in what this returns: only Postmark's error number and our own words. */

import { neverLeft, type SendResult } from "./outcome";

export type { SendResult };

export const POSTMARK_API = "https://api.postmarkapp.com";

/** Postmark's discard address: accepted and processed, never delivered. Every development test
 *  and drill sends here (`docs/emails.md`). */
export const DISCARD_ADDRESS = "test@blackhole.postmarkapp.com";

export type PostmarkConfig = {
  token: string;
  from: string;
  /** Postmark's transactional stream on the `staygreen.io` server. */
  stream?: string;
  /** `EMAIL_REDIRECT_TO`, in any environment it is set in: every message goes here instead of its recipient. */
  redirectTo?: string | null;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  tag: "alert" | "test" | "confirm";
  metadata: Record<string, string>;
  headers?: { Name: string; Value: string }[];
};

export type FindResult = { kind: "found"; messageId: string } | { kind: "none" } | { kind: "error"; detail: string };

const SEND_TIMEOUT_MS = 10_000;

/** Postmark's refusals of one message, in our words (`/developer/api/overview#error-codes`). */
function refusal(code: number): string {
  switch (code) {
    case 300:
      return "Postmark refused the message as invalid (error 300).";
    case 406:
      return "Postmark has stopped sending to this address: it bounced, complained or was suppressed (error 406).";
    case 412:
      return "Postmark sends only to addresses on the sender's own domain until it approves the account (error 412).";
    case 413:
      return "Postmark hasn't approved this account to send (error 413).";
    default:
      return `Postmark refused the message (error ${code}).`;
  }
}

async function errorCode(r: Response): Promise<number | null> {
  try {
    const body = (await r.json()) as { ErrorCode?: unknown };
    return typeof body.ErrorCode === "number" ? body.ErrorCode : null;
  } catch {
    return null;
  }
}

export async function sendEmail(cfg: PostmarkConfig, email: OutgoingEmail): Promise<SendResult> {
  const doFetch = cfg.fetch ?? fetch;
  const redirected = !!cfg.redirectTo;
  let r: Response;
  try {
    r = await doFetch(`${POSTMARK_API}/email`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": cfg.token },
      body: JSON.stringify({
        From: cfg.from,
        To: cfg.redirectTo || email.to,
        Subject: email.subject,
        TextBody: email.text,
        MessageStream: cfg.stream ?? "outbound",
        Tag: email.tag,
        Metadata: email.metadata,
        Headers: email.headers ?? [],
        TrackOpens: false,
        TrackLinks: "None",
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs ?? SEND_TIMEOUT_MS),
    });
  } catch (e) {
    return neverLeft(e)
      ? { kind: "retry", detail: "Couldn't reach Postmark." }
      : { kind: "unknown", detail: "Postmark didn't answer in time; the message may have been sent." };
  }
  if (r.ok) {
    let body: { ErrorCode?: unknown; MessageID?: unknown } = {};
    try {
      body = (await r.json()) as typeof body;
    } catch {
      return { kind: "unknown", detail: "Postmark's answer couldn't be read; the message may have been sent." };
    }
    if (body.ErrorCode === 0 && typeof body.MessageID === "string" && body.MessageID) return { kind: "sent", messageId: body.MessageID, redirected };
    return { kind: "unknown", detail: "Postmark answered without a message id; the message may have been sent." };
  }
  if (r.status === 429) return { kind: "retry", detail: "Postmark asked us to slow down." };
  if (r.status >= 500) return { kind: "retry", detail: `Postmark answered ${r.status}.` };
  if (r.status === 401) return { kind: "retry", detail: "Postmark refused the server token." };
  const code = await errorCode(r);
  return { kind: "rejected", code: code ?? r.status, detail: code === null ? `Postmark refused the message (HTTP ${r.status}).` : refusal(code) };
}

/** Whether Postmark already holds a message carrying `metadata[key] = value`, on the stream. */
export async function findSent(cfg: PostmarkConfig, key: string, value: string): Promise<FindResult> {
  const doFetch = cfg.fetch ?? fetch;
  const q = new URLSearchParams({ count: "1", offset: "0", messagestream: cfg.stream ?? "outbound", [`metadata_${key}`]: value });
  try {
    const r = await doFetch(`${POSTMARK_API}/messages/outbound?${q}`, {
      headers: { Accept: "application/json", "X-Postmark-Server-Token": cfg.token },
      signal: AbortSignal.timeout(cfg.timeoutMs ?? SEND_TIMEOUT_MS),
    });
    if (!r.ok) return { kind: "error", detail: `Postmark's message search answered ${r.status}.` };
    const body = (await r.json()) as { TotalCount?: unknown; Messages?: { MessageID?: unknown }[] };
    const id = body.Messages?.[0]?.MessageID;
    if (typeof body.TotalCount === "number" && body.TotalCount > 0 && typeof id === "string" && id) return { kind: "found", messageId: id };
    if (body.TotalCount === 0) return { kind: "none" };
    return { kind: "error", detail: "Postmark's message search answered in a shape we don't read." };
  } catch {
    return { kind: "error", detail: "Couldn't reach Postmark's message search." };
  }
}
