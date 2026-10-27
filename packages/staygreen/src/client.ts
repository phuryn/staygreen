import { setTimeout as delay } from "node:timers/promises";

export type ErrorBody = { error: { code: string; message: string; details?: unknown; retry_after?: number } };
export class ClientError extends Error {
  constructor(public body: ErrorBody) { super(body.error.message); }
}
const failure = (code: string, message: string) => new ClientError({ error: { code, message } });
const unavailable = () => failure("temporarily_unavailable", "Staygreen did not answer. Retry writes with the same request id and identical inputs.");

export function apiOrigin(origin: string) {
  let base: URL;
  try { base = new URL(origin); } catch { throw failure("invalid_origin", "Use an HTTPS API origin, or local HTTP for development."); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" ||
    (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname)))) {
    throw failure("invalid_origin", "Use an HTTPS API origin, or local HTTP for development.");
  }
  return base;
}

/** JSON-escape-safe redaction also covers object keys and protocol ids. */
export function redact<T>(value: T, token?: string): T {
  if (!token) return value;
  return JSON.parse(JSON.stringify(value).split(token).join("[REDACTED]")) as T;
}

function restError(raw: unknown, status: number): ClientError {
  const fallback = failure(status === 429 ? "rate_limited" : "request_refused",
    status === 429 ? "Scan or workspace budget reached. Retry later." : `Staygreen refused the request (HTTP ${status}). Check credentials, inputs and plan limits.`);
  if (!raw || typeof raw !== "object" || !("error" in raw) || !raw.error || typeof raw.error !== "object") return fallback;
  const e = raw.error as Record<string, unknown>;
  if (typeof e.code !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(e.code) || typeof e.message !== "string") return fallback;
  const body: ErrorBody = { error: { code: e.code, message: e.message.slice(0, 1000) } };
  // JSON already came through the byte cap. Keep ordinary hosted details intact;
  // unusually large/deep details are omitted, never replaced with a raw body.
  const shallow = (v: unknown, depth = 0): boolean => depth <= 8 && (!v || typeof v !== "object" || Object.values(v).every(child => shallow(child, depth + 1)));
  if (e.details !== undefined && JSON.stringify(e.details).length <= 16_384 && shallow(e.details)) body.error.details = e.details;
  if (typeof e.retry_after === "number" && Number.isFinite(e.retry_after) && e.retry_after >= 0 && e.retry_after <= 86_400) body.error.retry_after = e.retry_after;
  return new ClientError(body);
}

async function boundedJson(response: Response, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw failure("invalid_response", "Empty Staygreen response.");
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read(); signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) { await reader.cancel(); throw failure("response_too_large", "Response exceeds 256 KiB."); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
    catch { throw failure("invalid_response", "Staygreen returned an invalid JSON response."); }
  } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

export async function call(origin: string, operation: string, input: unknown, token?: string, fetcher = fetch, options: { signal?: AbortSignal } = {}) {
  const base = apiOrigin(origin);
  if (!/^[a-z][a-z0-9_]*$/.test(operation)) throw failure("invalid_arguments", "Unknown operation.");
  const path = operation === "scan_app" && !token ? "/api/scan" : `/api/v1/${operation}`;
  // One deadline covers the fetch, body, retry wait and second attempt together.
  const signal = AbortSignal.any([AbortSignal.timeout(50_000), ...(options.signal ? [options.signal] : [])]);
  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetcher(new URL(path, base), { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input), redirect: "error", signal });
      if (!response.ok && [429, 503].includes(response.status) && attempt < 1) {
        const seconds = Number(response.headers.get("Retry-After") ?? "1");
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 5) {
          await response.body?.cancel();
          await delay(Math.max(1, seconds) * 1000, undefined, { signal }); continue;
        }
      }
      let result: unknown;
      try { result = redact(await boundedJson(response, signal), token); }
      catch (e) {
        // A non-JSON refusal (e.g. an edge HTML page) has no public error fields.
        // Size and abort failures still apply to it, just as to a success body.
        if (!response.ok && e instanceof ClientError && e.body.error.code === "invalid_response") throw restError(null, response.status);
        throw e;
      }
      if (!response.ok) throw restError(result, response.status);
      return result;
    }
  } catch (e) {
    if (options.signal?.aborted) throw failure("request_cancelled", "Request cancelled.");
    if (signal.aborted) throw failure("temporarily_unavailable", "Staygreen did not answer within 50 seconds. Retry writes with the same request id and identical inputs.");
    if (e instanceof ClientError) throw e;
    // Fetch/body/parser exceptions can contain credentials and request URLs.
    throw unavailable();
  }
}
