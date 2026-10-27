import { isSecretName, mask } from "../../src/checks/mask";
import { isTokenKey, tokenHash, verifyToken } from "../../src/lib/heartbeat-token";

/* The heartbeat receiver's request handling (`spec.md § 3.3`, `docs/flows.md § A heartbeat's
   ping`). A plain function of a Request and one database call, so the unit suite runs it with a
   fake call (`tests/unit/ingest-handler.test.ts`) and the Worker (`index.ts`) gives it the real
   one. It uses only what a Worker and Node both have: Request, Response, Web Crypto.

   - `/<token>`, `/<token>/start`, `/<token>/fail`, on GET (or HEAD) with query parameters and on
     POST with a JSON object body (a form body reads like query parameters). Anything else is 404.
   - A token must carry its tag under `HEARTBEAT_TOKEN_KEY` (`src/lib/heartbeat-token.ts`). One
     that doesn't is answered exactly as an unknown token is, `404`, and never reaches the
     database, so a flood of made-up URLs costs the database nothing.
   - The token never leaves this function: its SHA-256 (`heartbeat_token_hash`) is what's sent.
   - It records and doesn't judge: `200 ok` whenever the token is known, even when an assertion
     will fail, and `404` for an unknown token. The answer comes only after the database said the
     ping is recorded, because a ping lost after a `200` is a missed run for a job that ran. A
     database that doesn't answer is a `503` with `Retry-After`, which the shell, Actions, Node
     and Python lines retry (`HeartbeatUrl.tsx`); Supabase's request is sent after the job's
     transaction commits, so that job never sees the answer (`docs/BACKLOG.md`). After a failed
     call, this instance answers `503` for `BREAKER_MS` without opening a connection, so a
     database in trouble isn't sent a connection per ping while it recovers.
   - The payload is masked here, value by value through `src/checks/mask.ts`, before it reaches
     the database, and cut to `PAYLOAD_LIMIT` bytes of JSON, dropping whole fields from the end.
   - It never sends a cookie or reads one. */

export type Kind = "ping" | "start" | "fail";
export type Note = "not_json" | "too_large" | "truncated";
export type Recorded = "recorded" | "limited" | "unknown";
export type RecordPing = (tokenHash: string, kind: Kind, payload: Record<string, unknown>, note: Note | null) => Promise<Recorded>;

/** How much of a POST body is read: a job's report is a handful of numbers. */
export const BODY_LIMIT = 8_192;
/** How much of the masked payload is kept, as JSON. */
export const PAYLOAD_LIMIT = 1_024;

/** How long an instance answers 503 without trying the database after a call to it failed. */
export const BREAKER_MS = 5_000;

const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const answer = (status: number, body: string, extra: Record<string, string> = {}) => new Response(body, { status, headers: { ...headers, ...extra } });

/** A token's kind over its per-minute bound, remembered by one Worker instance until the minute
    ends, so a job in a tight loop costs that instance one database call a minute, not one a
    request. Per kind, as the database's bound is: only a kind the database refused is answered
    from memory, so a `/fail` after a burst of pings still reaches it. Another instance asks the
    database once and learns the same. */
export class LimitCache {
  private until = new Map<string, number>();
  constructor(private readonly max = 1_000) {}

  limited(hash: string, kind: Kind, now: number): boolean {
    const t = this.until.get(`${hash}/${kind}`);
    if (t === undefined) return false;
    if (t > now) return true;
    this.until.delete(`${hash}/${kind}`);
    return false;
  }

  remember(hash: string, kind: Kind, now: number): void {
    if (this.until.size >= this.max) this.until.delete(this.until.keys().next().value!);
    this.until.set(`${hash}/${kind}`, Math.ceil((now + 1) / 60_000) * 60_000);
  }
}

/** After a database that failed to answer, `BREAKER_MS` of 503s from memory: one instance's, not
    the fleet's. A database that answered by refusing one request doesn't open it (`refused`). */
export class Breaker {
  private until = 0;
  constructor(private readonly ms = BREAKER_MS) {}

  /** The seconds it stays open, or 0 when calls may go through. */
  open(now: number): number {
    return now < this.until ? Math.ceil((this.until - now) / 1_000) : 0;
  }

  trip(now: number): void {
    this.until = now + this.ms;
  }
}

/** The body, up to `BODY_LIMIT` bytes, counted while it streams; null when it runs past. */
async function readBody(request: Request): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const DOTS = "•••";

/** Text Postgres's `jsonb` refuses, made storable: U+0000 dropped and a lone surrogate turned into
    U+FFFD. Either one would fail the cast in the ping's own call, every time it was sent. */
export function storable(s: string): string {
  return s.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** Every key and string value through the masker. Whatever sits under a secret-named key is
    hidden whole, whatever its type: a string, a number, a list, an object, even null. Anywhere
    else only the parts of a string that look like a secret (an email, a key, a long hex string)
    are replaced and the rest of it is kept, so an assertion on the rest still holds; numbers and
    booleans are kept as they are. Which assertions the masking would defeat is refused when the
    heartbeat is saved (`maskedAssertion`, `src/lib/monitor-input.ts`). */
export function maskPayload(v: unknown, key: string | null = null): unknown {
  if (key !== null && isSecretName(key)) return DOTS;
  if (typeof v === "string") return mask(storable(v));
  if (Array.isArray(v)) return v.map((x) => maskPayload(x, null));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [mask(storable(k)), maskPayload(x, storable(k))]));
  }
  return v;
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;

/** At most `PAYLOAD_LIMIT` bytes of JSON: whole fields kept in order while they fit. */
export function capPayload(p: Record<string, unknown>): { payload: Record<string, unknown>; truncated: boolean } {
  if (bytes(p) <= PAYLOAD_LIMIT) return { payload: p, truncated: false };
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    kept[k] = v;
    if (bytes(kept) > PAYLOAD_LIMIT) delete kept[k];
  }
  return { payload: kept, truncated: true };
}

export type Deps = {
  record: RecordPing;
  /** `HEARTBEAT_TOKEN_KEY`, the Worker's secret. Missing or malformed, every ping is a `500`
      before any database call: a misconfigured receiver says so instead of calling every token
      unknown. */
  tokenKey: string | undefined;
  cache?: LimitCache;
  breaker?: Breaker;
  now?: () => number;
};

/** The database answered and refused this one request: a data, integrity, syntax or permission
    error, or one the function raised (SQLSTATE classes 22, 23, 42 and P0). Anything else, a
    connection that failed or a timeout included, may mean it isn't answering at all. */
function refused(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^(22|23|42|P0)[0-9A-Z]{3}$/.test(code);
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  const { record, tokenKey, cache, breaker, now = Date.now } = deps;
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return answer(405, "method not allowed\n", { allow: "GET, HEAD, POST" });
  const url = new URL(request.url);
  // One trailing slash is forgiven: `/<token>/` is a ping.
  const parts = url.pathname.slice(1).replace(/\/$/, "").split("/");
  const token = parts[0] ?? "";
  const kind: Kind | null = parts.length === 1 ? "ping" : parts.length === 2 && (parts[1] === "start" || parts[1] === "fail") ? parts[1] : null;
  if (!kind) return answer(404, "not found\n");
  if (!isTokenKey(tokenKey)) return answer(500, "receiver not configured\n");
  // A token Staygreen never made: the same answer as an unknown one, and no database call.
  if (!(await verifyToken(tokenKey, token))) return answer(404, "not found\n");

  const hash = await tokenHash(token);
  if (cache?.limited(hash, kind, now())) return answer(200, "ok\n");
  const wait = breaker?.open(now()) ?? 0;
  if (wait > 0) return answer(503, "not recorded, try again\n", { "retry-after": String(wait) });

  let note: Note | null = null;
  let raw: Record<string, unknown> = Object.fromEntries(url.searchParams);
  if (method === "POST") {
    const body = await readBody(request);
    if (body === null) note = "too_large";
    else if (body.trim() !== "") {
      const type = request.headers.get("content-type") ?? "";
      if (/^application\/x-www-form-urlencoded/i.test(type)) raw = { ...raw, ...Object.fromEntries(new URLSearchParams(body)) };
      else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = undefined;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = { ...raw, ...(parsed as Record<string, unknown>) };
        else note = "not_json";
      }
    }
  }
  const { payload, truncated } = capPayload(maskPayload(raw) as Record<string, unknown>);
  if (truncated && !note) note = "truncated";

  let result: Recorded;
  try {
    result = await record(hash, kind, payload, note);
  } catch (e) {
    if (refused(e)) return answer(500, "not recorded\n");
    breaker?.trip(now());
    return answer(503, "not recorded, try again\n", { "retry-after": String(Math.ceil(BREAKER_MS / 1_000)) });
  }
  if (result === "unknown") return answer(404, "not found\n");
  if (result === "limited") cache?.remember(hash, kind, now());
  return answer(200, "ok\n");
}
