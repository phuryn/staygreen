import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { isPublicIp } from "../lib/ip";
import { judgeAll, type Assertion } from "./assertions";
import { guardedLookup, refusal } from "./lookup";
import { bodyText, maskHeader, redact, redactValues, snippet } from "./mask";
import { trustContext } from "./tls-context";
import { RedirectCookies } from "./redirect-cookies";
import { BOT_PROTECTION, botProtection } from "../lib/bot-protection";
import { fail, USER_AGENT, type AddressGuard, type CheckResult, type FailureKind, type Timings } from "./types";

/* HTTP(S) with assertions (`spec.md § 3.1`). Every check opens a fresh connection (no keep-alive
   pool), so a check measures what a new visitor gets and a dead server can't hide behind a
   pooled socket. Response cookies live only within this redirect chain, with Domain, Path and
   Secure scope; they are never kept across checks, and an observer sees Set-Cookie masked. A
   builder's stored Cookie wins on its original origin. A bot challenge in the final answer fails the check (`bot-protection.ts`).
   It reads at most 64 KB of body, follows at most 5 redirects,
   and asks the address guard again for every hop (`lookup.ts`). The builder's headers are spread
   over its own, so a stored User-Agent or Accept replaces them.

   A builder's secret headers go only to the origin they were written for: a redirect to another
   origin drops them, the way a browser drops Authorization. */

export type HttpCheck = {
  url: string;
  method: "GET" | "HEAD" | "POST";
  body?: string;
  /** `2xx`, `3xx`, or one exact code. */
  expect: string;
  keyword?: string | null;
  slowMs: number;
  timeoutSec?: number;
  assertions?: readonly Assertion[];
  /** Secret header values, already opened by the caller. Masked out of every snippet. */
  headers?: Readonly<Record<string, string>>;
  followRedirects?: boolean;
};

/** One response as the check read it (at most `maxBodyBytes` of its body), and whether the check
 *  went on to follow it as a redirect. */
export type Observed = {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
  address?: string;
  redirect: boolean;
  /** Detected before cookie redaction can hide a challenge marker. */
  blockedByBot?: true;
};

export type HttpOptions = {
  allow?: AddressGuard;
  /** Additional URL policy, checked before connecting on every hop. The scan uses its
   * entry rules here; monitors omit it because builders may redirect to other ports. */
  allowUrl?: (url: string) => boolean;
  /** A CA to trust, for a test or the benchmark serving its own certificate. */
  ca?: string | Buffer;
  maxBodyBytes?: number;
  /** Sees every response the check reads, redirects included, for the dashboard's test of a
   *  monitor, which shows them (`src/lib/monitor-test.ts`). The probes pass none, so what they
   *  check and store is the same with or without it. */
  observe?: (r: Observed) => void;
};

/** Redirects a check follows before it fails (`spec.md § 3.1`). `/bot` quotes it. */
export const MAX_REDIRECTS = 5;
/** How much of a response body a check reads; the rest is never downloaded. `/bot` quotes it. */
export const MAX_BODY_BYTES = 64 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

type Exchange =
  | { status: number; headers: IncomingHttpHeaders; body: Buffer; truncated: boolean; address?: string; timings: Timings }
  | { kind: FailureKind; message: string; timings: Timings };

export function statusMatches(expect: string, status: number): boolean {
  if (expect === "2xx") return status >= 200 && status < 300;
  if (expect === "3xx") return status >= 300 && status < 400;
  return status === Number(expect);
}

export function classify(err: NodeJS.ErrnoException & { code?: string }): { kind: FailureKind; message: string } {
  const code = err.code ?? "";
  if (code === "EPRIVATE") return { kind: "private", message: err.message };
  if (code === "ETIMEOUT_CHECK") return { kind: "timeout", message: err.message };
  if (["ENOTFOUND", "EAI_AGAIN", "ENODATA", "EAI_NONAME", "EAI_FAIL"].includes(code)) return { kind: "dns", message: `The name didn't resolve (${code})` };
  // The network's own codes come before any test of the wording: Node words a reset during the
  // handshake "Client network socket disconnected before secure TLS connection was established".
  if (code === "ECONNREFUSED") return { kind: "connect", message: "Connection refused" };
  if (code === "ECONNRESET") return { kind: "connect", message: "Connection reset" };
  if (["EPIPE", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "EHOSTDOWN", "ENETDOWN"].includes(code)) return { kind: "connect", message: `Couldn't connect (${code})` };
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL)/.test(code) || /certificate|SSL|TLS/i.test(err.message))
    return { kind: "tls", message: `TLS failed: ${err.message}` };
  if (code.startsWith("HPE_")) return { kind: "protocol", message: `Not a valid HTTP response (${code})` };
  return { kind: "connect", message: code ? `Couldn't connect (${code})` : err.message };
}

function exchange(url: URL, method: string, headers: Record<string, string>, body: string | undefined, deadline: number, o: HttpOptions): Promise<Exchange> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const timings: Timings = {};
    const since = () => Math.round(performance.now() - t0);
    const max = o.maxBodyBytes ?? MAX_BODY_BYTES;
    let settled = false;
    const done = (x: Exchange) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(x);
    };
    const remaining = Math.max(0, deadline - performance.now());
    const mod = url.protocol === "https:" ? https : http;
    let req: http.ClientRequest;
    try {
      req = mod.request(url, {
        method,
        agent: false,
        lookup: guardedLookup(o.allow ?? isPublicIp),
        headers: { "user-agent": USER_AGENT, accept: "*/*", ...headers, ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) },
        ...(url.protocol === "https:" ? { secureContext: trustContext(o.ca) } : {}),
      });
    } catch (err) {
      // A request Node refuses to build, such as a header value it can't carry, is a failure the
      // builder sees, never a check that silently didn't happen.
      // (Before the timer exists, so not through `done`.) Node names the header, never its value.
      settled = true;
      return resolve({ kind: "protocol", message: `Couldn't send the request: ${(err as Error).message}`, timings });
    }
    const timer = setTimeout(() => {
      req.destroy(Object.assign(new Error(`No answer within ${Math.round((deadline - t0) / 1000) || 1} s`), { code: "ETIMEOUT_CHECK" }));
    }, remaining);
    req.on("socket", (s) => {
      s.once("lookup", () => (timings.dnsMs = since()));
      s.once("connect", () => (timings.connectMs = since()));
      s.once("secureConnect", () => (timings.tlsMs = since()));
    });
    req.on("response", (res) => {
      timings.ttfbMs = since();
      const address = res.socket?.remoteAddress;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      const finish = () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated, address, timings });
      res.on("data", (chunk: Buffer) => {
        if (truncated) return;
        const room = max - size;
        if (chunk.length >= room) {
          chunks.push(chunk.subarray(0, room));
          size = max;
          truncated = true;
          finish();
          res.destroy();
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
      });
      res.on("end", finish);
      res.on("error", (err) => (size > 0 ? finish() : done({ ...classify(err), timings })));
    });
    req.on("error", (err) => done({ ...classify(err), timings }));
    if (body !== undefined && method !== "GET" && method !== "HEAD") req.write(body);
    req.end();
  });
}

export async function checkHttp(c: HttpCheck, o: HttpOptions = {}): Promise<CheckResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const deadline = started + (c.timeoutSec ?? 15) * 1000;
  const allow = o.allow ?? isPublicIp;
  const secrets = Object.values(c.headers ?? {});
  const cookies = new RedirectCookies();

  let url: URL;
  try {
    url = new URL(c.url);
  } catch {
    return fail(0, "protocol", "That isn't an address Staygreen can request");
  }
  const origin = url.origin;
  let method: string = c.method;
  let body = c.method === "POST" ? (c.body ?? "") : undefined;
  const follow = (c.followRedirects ?? true) && !c.expect.startsWith("3");

  for (let hop = 0; ; hop++) {
    if (o.allowUrl && !o.allowUrl(url.href)) return fail(elapsed(), hop === 0 ? "protocol" : "redirects", "That address is not allowed for this request");
    if (url.protocol !== "http:" && url.protocol !== "https:") return fail(elapsed(), "redirects", `Redirected to a ${url.protocol} address, which Staygreen doesn't follow`);
    const refused = refusal(url.hostname, allow);
    if (refused) return fail(elapsed(), "private", hop === 0 ? refused : `A redirect led to ${refused}`);
    const sendSecrets: Record<string, string> = url.origin === origin ? Object.fromEntries(Object.entries(c.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) : {};
    const cookie = cookies.header(url);
    if (cookie && !("cookie" in sendSecrets)) sendSecrets.cookie = cookie;
    const x = await exchange(url, method, sendSecrets, body, deadline, o);
    if ("kind" in x) return fail(elapsed(), x.kind, x.message, { timings: x.timings });
    cookies.receive(url, x.headers["set-cookie"] ?? []);
    const redirect = follow && REDIRECTS.has(x.status) && typeof x.headers.location === "string";
    // The body is judged and observed exactly as the site sent it: masking a site's own cookie
    // values out of it would rewrite a healthy answer (`lang=en` inside a keyword, `consent=1`
    // inside a number). A Set-Cookie value is masked in the headers an observer may show.
    const setCookie = x.headers["set-cookie"];
    const observedHeaders = setCookie ? { ...x.headers, "set-cookie": setCookie.map((s) => maskHeader("set-cookie", s)) } : x.headers;
    o.observe?.({ url: url.href, status: x.status, headers: observedHeaders, body: x.body, truncated: x.truncated, address: x.address, redirect, ...(botProtection(x, method) ? { blockedByBot: true } : {}) });

    if (redirect) {
      if (hop >= MAX_REDIRECTS) return fail(elapsed(), "redirects", `More than ${MAX_REDIRECTS} redirects`, { status: x.status, address: x.address });
      try {
        url = new URL(x.headers.location as string, url);
      } catch {
        return fail(elapsed(), "redirects", "The redirect's Location isn't a valid address", { status: x.status, timings: x.timings });
      }
      if (x.status === 303 || ((x.status === 301 || x.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }

    const ms = elapsed();
    const base = { ms, status: x.status, address: x.address, timings: x.timings };
    // Judged with the monitor's own secrets hidden, so no keyword or assertion reads one: the
    // keyword in the text, the assertions in the decoded JSON (`redactValues`).
    const raw = bodyText(x.body);
    const text = redact(raw, secrets);
    const evidence = () => snippet(x.body, secrets);

    // A bot challenge is its protection answering, not the app, whatever status it carries
    // (owner, 2026-10-24). Judged on the raw answer, before cookie masking can hide a marker.
    if (botProtection(x, method)) return { ...base, ok: false, failure: { kind: "status", message: BOT_PROTECTION }, snippet: evidence() };
    if (!statusMatches(c.expect, x.status)) return { ...base, ok: false, failure: { kind: "status", message: `Answered ${x.status}, expected ${c.expect}` }, snippet: evidence() };
    if (c.keyword && !text.includes(c.keyword)) return { ...base, ok: false, failure: { kind: "keyword", message: `"${c.keyword}" isn't in the response` }, snippet: evidence() };

    const list = c.assertions ?? [];
    if (list.length > 0) {
      let json: unknown;
      let parsed = true;
      try {
        json = redactValues(JSON.parse(raw), secrets);
      } catch {
        parsed = false;
      }
      const assertions = judgeAll(parsed ? json : undefined, list, secrets);
      const first = assertions.find((a) => !a.pass);
      if (!parsed)
        return { ...base, ok: false, assertions, failure: { kind: "assertion", message: x.truncated ? "The body is over 64 KB, so it can't be read as JSON" : "The body isn't JSON" }, snippet: evidence() };
      if (first) {
        const got = first.got === undefined ? "nothing there" : `got ${first.got}`;
        return { ...base, ok: false, assertions, failure: { kind: "assertion", message: `${[first.path, first.op, first.expected].filter(Boolean).join(" ")} failed: ${got}` }, snippet: evidence() };
      }
      return { ...base, ok: true, slow: ms > c.slowMs, assertions };
    }
    return { ...base, ok: true, slow: ms > c.slowMs };
  }
}
