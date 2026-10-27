/* What a provider's answer to one send means to the sender (`sender.ts`), whichever provider:
   - `sent`: accepted, with the provider's id for the message.
   - `rejected`: the provider answered and refused this message; sending it again can't help.
   - `retry`: the provider answered and didn't take it, or the request never left; try later
     (after `retryAfterSec` when the provider said how long).
   - `unknown`: the request may have arrived and no answer came back. Never retried blind.

   `detail` is always our own words, never a provider's response body. */

export type SendResult =
  | { kind: "sent"; messageId: string; redirected: boolean }
  | { kind: "rejected"; code: number; detail: string }
  | { kind: "retry"; detail: string; retryAfterSec?: number }
  | { kind: "unknown"; detail: string };

/** Only failures known to precede transmission, never a generic connection loss or timeout. */
export function neverLeft(e: unknown, redirect: RequestRedirect = "follow"): boolean {
  // Workers checks this limit before starting a subrequest (docs/telegram.md). With redirects
  // enabled it could instead refuse a later hop after the original POST reached its provider,
  // so that case cannot use this proof. Other Workers network errors don't identify the phase.
  if (redirect === "manual" && e instanceof Error && e.message === "Too many subrequests.") return true;
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  return code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN" || code === "UND_ERR_CONNECT_TIMEOUT";
}
