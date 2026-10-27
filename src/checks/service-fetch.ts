import { checkHttp, type HttpOptions, type Observed } from "./http";
import type { FailureKind } from "./types";

export type ServiceAnswer = { status: number; body: string } | { error: FailureKind; code?: string };
export type ServiceFetch = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<ServiceAnswer>;

/** GET only, no redirects or cookies. The existing transport pins each connection to a
 * public DNS answer, caps the body at 64 KiB (1 MiB for Stripe's full Event objects only)
 * and bounds the entire request. No vendor body
 * or transport exception is copied into evidence: both can contain customer credentials. */
export function serviceFetch(options: HttpOptions = {}): ServiceFetch {
  return async (url, headers, timeoutMs) => {
    let seen: Observed | undefined;
    const maxBodyBytes = URL.canParse(url) && new URL(url).origin === "https://api.stripe.com" ? 1024 * 1024 : 65536;
    const r = await checkHttp({ url, method: "GET", expect: "2xx", slowMs: Number.MAX_SAFE_INTEGER,
      timeoutSec: Math.max(0.001, timeoutMs / 1000), followRedirects: false, headers },
    { ...options, maxBodyBytes, observe: (answer) => { seen = answer; } });
    if (!seen) return { error: r.failure?.kind ?? "connect",
      // Only NXDOMAIN/name-not-found counts as paused; SERVFAIL and temporary DNS errors don't.
      code: r.failure?.message.includes("(ENOTFOUND)") ? "ENOTFOUND" : undefined };
    if (seen.truncated) return { error: "protocol", code: "BODY_TOO_LARGE" };
    return { status: seen.status, body: seen.body.toString("utf8") };
  };
}

export const jsonObject = (body: string): Record<string, unknown> | null => {
  try { const v: unknown = JSON.parse(body); return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null; }
  catch { return null; }
};

/** One overall deadline, including every page, rather than a fresh timeout per request. */
export function within(fetch: ServiceFetch, timeoutMs = 15_000): ServiceFetch {
  const end = performance.now() + timeoutMs;
  return async (url, headers) => {
    const remaining = end - performance.now();
    if (remaining <= 0) return { error: "timeout" };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([fetch(url, headers, remaining), new Promise<ServiceAnswer>((resolve) => {
        timer = setTimeout(() => resolve({ error: "timeout" }), remaining);
      })]);
    } catch { return { error: "connect" }; }
    finally { clearTimeout(timer); }
  };
}
