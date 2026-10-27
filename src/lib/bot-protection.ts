import type { Observed } from "@/checks/http";
import { USER_AGENT, type CheckResult } from "@/checks/types";

export const BOT_PROTECTION = `Blocked by bot protection: the address answered with its bot protection, not the app. Allow Staygreen's checks through (User-Agent: ${USER_AGENT}).`;

/** A bot challenge is never a pass: not in suggestions, Test or a running monitor (owner,
 *  2026-10-24). Only the small Imperva shell is a wall; full pages legitimately load its script.
 *  An empty 202 counts only for GET, since an API may accept a POST with one. */
export function botProtection(r: Pick<Observed, "status" | "headers" | "body" | "truncated" | "blockedByBot">, method = "GET"): boolean {
  const text = r.body.toString("utf8");
  return r.blockedByBot === true || r.headers["x-amzn-waf-action"] !== undefined || r.headers["cf-mitigated"] === "challenge" ||
    (r.status === 202 && method === "GET" && !r.truncated && !text.trim()) ||
    (!r.truncated && r.body.length < 1024 && /incapsula|imperva|_Incapsula_Resource/i.test(text)) ||
    (r.status === 403 && /cf-chl-|just a moment|cloudflare.*challenge/i.test(text));
}

/** `checkHttp` already fails a challenge in its final answer. This applies the same verdict
 *  where a caller saw one on another hop, or judges an injected check. */
export function checkedForBot(result: CheckResult, blocked: boolean): CheckResult {
  return blocked ? { ...result, ok: false, slow: false, failure: { kind: "status", message: BOT_PROTECTION } } : result;
}
