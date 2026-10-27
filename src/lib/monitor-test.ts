import "server-only";
import net from "node:net";
import tls, { type PeerCertificate } from "node:tls";
import type { IncomingHttpHeaders } from "node:http";
import { judgeAll, type Assertion } from "@/checks/assertions";
import { checkCert } from "@/checks/cert";
import { checkDns, RESOLVERS, type Ask, type DnsRecord } from "@/checks/dns";
import { checkHttp, statusMatches, type Observed } from "@/checks/http";
import { bodyText, mask, maskField, maskHeader, redact, redactValues } from "@/checks/mask";
import { checkTcp } from "@/checks/tcp";
import { monitorDefaults } from "@/lib/monitor-defaults";
import { fail, type AddressGuard, type CheckResult } from "@/checks/types";
import type { MonitorRow } from "./monitor-input";
import type { DnsTest, HttpTest, JsonEntry, JsonNode, SslTest, TestOutcome } from "./test-result";
import { checkSupabase } from "@/checks/supabase";
import { checkStripe } from "@/checks/stripe";
import { serviceFetch, type ServiceFetch } from "@/checks/service-fetch";
import { isService, SERVICE_KEY, type StripeConfig, type SupabaseConfig } from "./service-monitor";
import { botProtection, checkedForBot } from "./bot-protection";

/* Testing a monitor before saving it (`docs/flows.md § Testing a monitor`): the check runs once,
   now, from the dashboard's own server, through the probes' own code (`src/checks/`), and this
   module turns what it read into what the form shows (`test-result.ts`).

   - **The same guard.** The checks refuse a private, loopback, link-local, CGNAT or reserved
     address before they connect, after every resolution and at every redirect (`lookup.ts`).
     Nothing here passes another guard: `TestNetwork` exists for the unit suite, which serves
     its targets from this machine, and `testMonitor` never passes one.
   - **Masked like everything the probes show.** Every header, the body, each value of a JSON
     body, a redirect's address and the failure's sentence pass through the masker
     (`src/checks/mask.ts`), with the monitor's own secret header values among the secrets it
     hides, so a value the builder kept sealed never comes back to the browser.
   - **Inside a function's time.** The check is given at most what remains of the action's
     `TEST_DEADLINE_MS`, never more than its own timeout, and a timer beside it answers for it
     a second after that, so a check that overstays still ends the test.
   - **Nothing is written.** No state, no rollup, no failure row; the action spends one use of
     the budget before calling here, and that is the only write a test makes. */

export type TestNetwork = { allow?: AddressGuard; ca?: string | Buffer; dnsAsk?: Ask; now?: () => number; serviceFetch?: ServiceFetch };

/** A Server Action on Netlify runs in a synchronous function, which the platform stops after
 *  60 s (`docs/integrations.md § Netlify`). A test, from its first line to its answer, takes
 *  at most this much, plus the one second the timer allows. */
export const TEST_DEADLINE_MS = 25_000;
/** Less than this left after the reads and the budget, and the test is refused rather than run
 *  with a timeout too short to mean anything. */
export const TEST_MIN_MS = 3_000;

const HTTP_TIMEOUT_SEC = 15;
const TCP_TIMEOUT_SEC = 10;
const CERT_TIMEOUT_SEC = 15;
/** The resolvers' own timeouts (`dns.ts`) end a DNS check in about 9 s. */
const DNS_TIMEOUT_SEC = 10;

/** How much of a JSON body becomes a tree; the masked text carries all of it. */
const TREE_NODES = 1500;
const TREE_DEPTH = 32;
const STRING_SHOWN = 300;
const HEADERS_SHOWN = 100;
const HEADER_SHOWN = 1000;

const BINARY = /^(image|audio|video|font)\/|^application\/(octet-stream|pdf|zip|gzip|x-gzip|wasm|x-protobuf|protobuf)\b/i;

/** `withinMs`: what remains of the action's deadline. */
export async function runTest(row: MonitorRow, headers: Readonly<Record<string, string>>, withinMs: number, o: TestNetwork = {}): Promise<TestOutcome> {
  const at = (o.now ?? Date.now)();
  const cap = (own: number) => Math.max(1, Math.min(own, Math.floor(withinMs / 1000)));
  const c = row.config;

  if (isService(row.type)) {
    const timeoutSec = cap(20);
    const fetch = o.serviceFetch ?? serviceFetch({ allow: o.allow, ca: o.ca });
    const key = headers[SERVICE_KEY] ?? "";
    const r = row.type === "supabase"
      ? await checkSupabase(c as SupabaseConfig, key, { fetch, timeoutMs: timeoutSec * 1000 })
      : await checkStripe(c as StripeConfig, key, { fetch, timeoutMs: timeoutSec * 1000, now: o.now, verifyKey: true });
    // A valid Stripe configuration may already be failing. It may be saved once both
    // allowed reads and the forbidden read were verified; no vendor payload is returned.
    return { ...verdict(r, [key]), at, timeoutSec, type: row.type,
      service: { saveable: row.type === "supabase" ? r.ok : r.detail?.verified === true,
        steps: row.type === "supabase" ? (r.detail?.steps as { name: string; ok: boolean; status?: number }[] ?? []) : [],
        summary: row.type === "stripe" ? `${Number(r.detail?.count ?? 0)} affected events across the account; ${Number(r.detail?.pending ?? 0)} pending.` : r.ok ? "Auth and Storage answered; the configured database read answered too, when present." : "Fix the failed check before saving." } };
  }

  if (row.type === "http") {
    const timeoutSec = cap(Number(c.timeoutSec ?? HTTP_TIMEOUT_SEC));
    const secrets = Object.values(headers);
    const seen: Observed[] = [];
    const expect = String(c.expect ?? "2xx");
    const keyword = typeof c.keyword === "string" && c.keyword ? c.keyword : null;
    const assertions = (Array.isArray(c.assertions) ? c.assertions : []) as Assertion[];
    const r = await bounded(
      checkHttp(
        { url: row.target, method: (c.method as "GET" | "HEAD" | "POST") ?? "GET", expect, keyword, slowMs: Number(c.slowMs ?? monitorDefaults.slowMs.http), timeoutSec, assertions, headers },
        { allow: o.allow, ca: o.ca, observe: (x) => seen.push(x) },
      ),
      timeoutSec,
      `No answer within ${timeoutSec} s`,
    );
    // Every exchange before the last was a redirect the check followed; the last one that wasn't
    // is the answer the check judged.
    const final = seen.find((x) => !x.redirect);
    const http: HttpTest = {
      url: mask(row.target, secrets),
      method: String(c.method ?? "GET"),
      expect,
      slowMs: Number(c.slowMs ?? monitorDefaults.slowMs.http),
      status: final?.status ?? r.status,
      statusOk: final ? statusMatches(expect, final.status) : undefined,
      address: final?.address ?? r.address,
      redirects: seen.filter((x) => x.redirect).map((x) => ({ status: x.status, location: cut(mask(String(x.headers.location ?? ""), secrets), 2048) })),
      headers: final ? headersOf(final.headers, secrets) : [],
      body: final ? bodyOf(final, secrets) : undefined,
      keyword: keyword && final ? { text: keyword, found: redact(bodyText(final.body), secrets).includes(keyword) } : undefined,
      // Judged on the answer whatever the verdict, so a builder reads every assertion against it
      // (the check itself stops at the first thing that fails). The same function, the same text,
      // with the monitor's own secrets hidden as the check hides them.
      assertions: final && assertions.length ? judgeAll(redactValues(parseJson(bodyText(final.body)), secrets), assertions, secrets) : [],
    };
    return { ...verdict(checkedForBot(r, seen.some((x) => botProtection(x, http.method))), secrets), at, timeoutSec, type: "http", http };
  }

  if (row.type === "tcp") {
    const timeoutSec = cap(TCP_TIMEOUT_SEC);
    const host = String(c.host);
    const port = Number(c.port);
    const r = await bounded(checkTcp({ host, port, tls: c.tls === true, timeoutSec, slowMs: Number(c.slowMs ?? monitorDefaults.slowMs.tcp) }, { allow: o.allow, ca: o.ca }), timeoutSec, `No connection within ${timeoutSec} s`);
    return { ...verdict(r), at, timeoutSec, type: "tcp", tcp: { host, port, tls: c.tls === true, address: r.address } };
  }

  if (row.type === "ssl") {
    const timeoutSec = cap(CERT_TIMEOUT_SEC);
    const host = String(c.host ?? row.target);
    // As the probe reads it (`probe/runtime.ts`): the form saves none, so 443.
    const port = c.port === undefined ? undefined : Number(c.port);
    let seen: { cert: PeerCertificate; authorized: boolean; authorizationError?: string } | null = null;
    const r = await bounded(
      checkCert({ host, port, timeoutSec }, { allow: o.allow, ca: o.ca, now: o.now, observe: (s) => (seen = s) }),
      timeoutSec,
      `No TLS handshake within ${timeoutSec} s`,
    );
    return { ...verdict(r), at, timeoutSec, type: "ssl", ssl: sslOf(host, r, seen) };
  }

  if (row.type === "dns") {
    const timeoutSec = cap(DNS_TIMEOUT_SEC);
    const record = String(c.record) as DnsRecord;
    const name = String(c.name);
    const expected = String(c.expected);
    const r = await bounded(checkDns({ record, name, expected }, o.dnsAsk), timeoutSec, "Neither resolver answered in time");
    return { ...verdict(r), at, timeoutSec, type: "dns", dns: dnsOf(record, name, expected, r) };
  }

  throw new Error(`a ${row.type} monitor has nothing to test`);
}

/** The check, or a timeout a second after its own should have ended it. The suggestion run
 *  bounds its checks the same way (`suggestion-checks.ts`). */
export function bounded(check: Promise<CheckResult>, timeoutSec: number, message: string): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => resolve(fail(timeoutSec * 1000, "timeout", message)), timeoutSec * 1000 + 1000);
  });
  return Promise.race([check, late]).finally(() => clearTimeout(timer));
}

function verdict(r: CheckResult, secrets: readonly string[] = []): Pick<TestOutcome, "ok" | "slow" | "ms" | "failure"> {
  return {
    ok: r.ok,
    ...(r.slow ? { slow: true } : {}),
    ms: r.ms,
    ...(r.failure ? { failure: { kind: r.failure.kind, message: mask(r.failure.message, secrets) } } : {}),
  };
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function headersOf(h: IncomingHttpHeaders, secrets: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(h)) {
    for (const v of Array.isArray(value) ? value : [value ?? ""]) out.push([name, cut(maskHeader(name, String(v), secrets), HEADER_SHOWN)]);
  }
  return out.slice(0, HEADERS_SHOWN);
}

function bodyOf(x: Observed, secrets: readonly string[]): NonNullable<HttpTest["body"]> {
  const ct = x.headers["content-type"];
  const contentType = typeof ct === "string" ? ct : null;
  const base = { bytes: x.body.length, truncated: x.truncated, contentType };
  if (x.body.length === 0) return { ...base, kind: "empty" };
  if (BINARY.test(contentType ?? "") || x.body.includes(0)) return { ...base, kind: "binary" };
  const text = bodyText(x.body);
  // A body cut at 64 KB is never whole JSON; the check says so as its failure.
  const json = x.truncated ? undefined : parseJson(text);
  const masked = mask(text, secrets);
  return json === undefined ? { ...base, kind: "text", text: masked } : { ...base, kind: "json", text: masked, json: treeOf(json, secrets) };
}

/** The parsed body, masked value by value: a string under a key named like a secret is hidden
 *  whole, every other string and every key goes through `mask`. An array keeps its key, so
 *  `{"token": ["…"]}` hides its elements too. */
export function treeOf(root: unknown, secrets: readonly string[] = []): JsonNode {
  let left = TREE_NODES;
  const walk = (v: unknown, key: string | null, depth: number): JsonNode => {
    left--;
    if (v === null || v === undefined) return { t: "null" };
    if (typeof v === "string") {
      const shown = maskField(key, v, secrets);
      const node: Extract<JsonNode, { t: "string" }> = { t: "string", v: shown };
      if (shown !== v) node.masked = true;
      if (node.v.length > STRING_SHOWN) {
        node.v = node.v.slice(0, STRING_SHOWN);
        node.cut = true;
      }
      return node;
    }
    if (typeof v === "number" || typeof v === "boolean") {
      // A secret echoed as a number or a boolean is hidden like one in a string, and a leaf that
      // holds one can only be asked whether it exists.
      const hidden = redact(String(v), secrets);
      if (hidden !== String(v)) return { t: "string", v: hidden, masked: true };
      return typeof v === "number" ? { t: "number", v } : { t: "boolean", v };
    }
    if (Array.isArray(v)) {
      const items: JsonNode[] = [];
      for (const el of v) {
        if (left <= 0 || depth >= TREE_DEPTH) break;
        items.push(walk(el, key, depth + 1));
      }
      return { t: "array", items, more: v.length - items.length };
    }
    const all = Object.entries(v as Record<string, unknown>);
    const entries: JsonEntry[] = [];
    for (const [k, val] of all) {
      if (left <= 0 || depth >= TREE_DEPTH) break;
      const shownKey = mask(k, secrets);
      entries.push(shownKey === k ? { k, n: walk(val, k, depth + 1) } : { k: shownKey, masked: true, n: walk(val, k, depth + 1) });
    }
    return { t: "object", entries, more: all.length - entries.length };
  };
  return walk(root, null, 0);
}

function sslOf(host: string, r: CheckResult, seen: { cert: PeerCertificate; authorized: boolean; authorizationError?: string } | null): SslTest {
  const d = r.detail ?? {};
  const cert = seen?.cert && seen.cert.valid_to ? seen.cert : null;
  // `subjectaltname` reads "DNS:example.com, DNS:*.example.com, IP Address:192.0.2.1".
  const names = (cert?.subjectaltname ?? "")
    .split(/,\s*/)
    .map((n) => n.replace(/^(DNS|IP Address):/, ""))
    .filter(Boolean)
    .slice(0, 20);
  return {
    host,
    address: r.address,
    issuer: typeof d.issuer === "string" ? d.issuer : null,
    subject: typeof d.subject === "string" ? d.subject : null,
    names,
    expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : undefined,
    daysLeft: typeof d.daysLeft === "number" ? d.daysLeft : undefined,
    nameMatches: cert && !net.isIP(host) ? tls.checkServerIdentity(host, cert) === undefined : null,
    // Node reports a name that doesn't match as unauthorized too; trust is about the chain alone.
    trusted: cert && seen ? seen.authorized || /ALTNAME/.test(seen.authorizationError ?? "") : null,
  };
}

const DNS_ERRORS: Record<string, string> = {
  ENOTFOUND: "No such name",
  ENODATA: "No record of this type",
  ETIMEOUT: "No answer in time",
  ECONNREFUSED: "Refused the question",
  ESERVFAIL: "Couldn't answer (SERVFAIL)",
  EREFUSED: "Refused the question",
};

/** What each resolver said. Not masked: these are public records any resolver hands anyone, and
 *  a TXT value (a DKIM key, a verification string) is what the builder needs to read to write
 *  the value it should have. */
function dnsOf(record: string, name: string, expected: string, r: CheckResult): DnsTest {
  const said = r.detail?.resolvers;
  const answers = Array.isArray(said) ? (said as { resolver: string; answers?: string[]; error?: string; matches: boolean }[]) : [];
  return {
    record,
    name,
    expected,
    resolvers: RESOLVERS.map(({ id, server }) => {
      const a = answers.find((x) => x.resolver === id);
      const label = `${id === "cloudflare" ? "Cloudflare" : "Google"} (${server})`;
      if (!a) return { id, label, error: "No answer in time", matches: false };
      return { id, label, ...(a.answers ? { answers: a.answers.slice(0, 50).map((x) => cut(x, 1000)) } : {}), ...(a.error ? { error: DNS_ERRORS[a.error] ?? a.error } : {}), matches: a.matches };
    }),
  };
}
