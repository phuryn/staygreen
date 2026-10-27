/* What a builder may submit as a new or edited monitor, and the row it becomes.

   Pure, and shared: the monitor form runs it as you save, so a mistake is named
   beside its field, and the creating or editing action runs it again on the
   server, because the form is a proposal (`AGENTS.md § 1.2`). It refuses an
   address in a private range or a name that only means this network (`ip.ts`).
   Whether a public-looking name resolves somewhere private is the server's
   question (`targets.ts`), and the plan's numbers are the database's
   (`create_monitor`, `update_monitor`).

   Errors are keyed by form field and already worded, so the form shows them as
   they come. */

import { z } from "zod";
import { parsePath } from "../checks/assertions";
import { isSecretName, mask } from "../checks/mask";
import { heartbeatIntervalSec, isValidCron } from "./cron";
import { ipVersion as isIP, isLocalName, isPublicIp } from "./ip";
import { monitorDefaults } from "./monitor-defaults";
import { databaseReadName, projectRef, restrictedKey, SERVICE_KEY, STRIPE_CRITICAL } from "./service-monitor";
import { isPublishableKey } from "./supabase-detect";

export const OPS = ["==", "!=", "<", ">", "<=", ">=", "contains", "exists"] as const;
export const DNS_RECORDS = ["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "NS"] as const;
export const METHODS = ["GET", "HEAD", "POST"] as const;

/** The fixed schedules (`spec.md § 3.2`, `§ 3.4`): a certificate every six hours, a DNS record
 *  every ten minutes, on every plan. HTTP and TCP take the plan's interval. `/bot` quotes them. */
export const SSL_INTERVAL_SEC = 21_600;
export const DNS_INTERVAL_SEC = 600;

/** The types a builder can add in Phase 1; the rest say Coming soon (`plan.md`, stage 1.4). */
export const CREATABLE = ["http", "ssl", "dns", "tcp", "heartbeat", "stripe", "supabase"] as const;
export type CreatableType = (typeof CREATABLE)[number];
export const isCreatable = (t: string): t is CreatableType => (CREATABLE as readonly string[]).includes(t);

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** DNS record names may carry underscores (`_dmarc.example.com`). */
const RECORD_NAME = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** RFC 9110's token, and the shape `monitor_secrets.name` accepts. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
/** Headers the probe sets itself; a builder's value would only be overwritten or break the request.
 *  Every other header is sent as stored, `User-Agent` and `Cookie` included (`/bot` says so). */
export const RESERVED_HEADERS = ["host", "content-length", "transfer-encoding", "connection"];

const PRIVATE = (h: string) => `${h} is a private address. Staygreen checks from the public internet, so it can't reach it.`;

const appId = z.string().regex(/^app_[0-9a-f]{24}$/, "Pick the app this monitor belongs to");
const name = z.string().trim().max(80, "Names run to 80 characters");
const slowMs = z.number().int().min(100, "Between 100 and 60,000 ms").max(60000, "Between 100 and 60,000 ms");
const assertion = z.object({
  path: z.string().trim().min(1).max(200),
  op: z.enum(OPS),
  value: z.string().max(500),
});

const draftSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("supabase"), appId, name,
    projectUrl: z.string().trim().max(100), key: z.string().trim().max(2000),
    databaseRead: z.string().trim().max(67).default("") }),
  z.object({ type: z.literal("stripe"), appId, name, key: z.string().trim().max(220),
    endpoints: z.array(z.string().regex(/^we_[A-Za-z0-9]{1,100}$/, "Use endpoint IDs beginning we_")).min(1).max(20),
    critical: z.array(z.string().max(150).regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*(?:\.\*)?$/, "Use event names, optionally ending in .*" )).max(20).default(STRIPE_CRITICAL),
    failureThreshold: z.number().int().min(1).max(100).default(3),
    windowMin: z.number().int().min(1).max(1440).default(30),
    pendingMin: z.number().int().min(1).max(1440).default(30) }),
  z.object({
    type: z.literal("http"),
    appId,
    name,
    url: z.string().trim().max(2048, "Addresses run to 2,048 characters"),
    method: z.enum(METHODS),
    expect: z.string().trim().regex(/^(2xx|3xx|[1-5]\d\d)$/, "2xx, or a code like 200 or 301"),
    keyword: z.string().max(200, "Keep it under 200 characters").default(""),
    slowMs,
    assertions: z.array(assertion).max(10),
    headers: z.array(z.object({ name: z.string().trim(), value: z.string() })).max(10, "At most 10 secret headers"),
  }),
  z.object({ type: z.literal("ssl"), appId, name, host: z.string().trim().toLowerCase() }),
  z.object({
    type: z.literal("tcp"),
    appId,
    name,
    host: z.string().trim().toLowerCase(),
    port: z.number().int().min(1, "Ports run from 1 to 65535").max(65535, "Ports run from 1 to 65535"),
    tls: z.boolean(),
    slowMs: slowMs.default(monitorDefaults.slowMs.tcp),
  }),
  z.object({
    type: z.literal("dns"),
    appId,
    name,
    record: z.enum(DNS_RECORDS),
    recordName: z.string().trim().toLowerCase().transform((v) => v.replace(/\.$/, "")).pipe(z.string().regex(RECORD_NAME, "Enter the record's full name, like www.example.com")),
    expected: z.string().trim().min(1, "Enter the value it should have, so a change can be caught").max(500, "Keep it under 500 characters"),
  }),
  z.object({
    type: z.literal("heartbeat"),
    appId,
    name,
    schedule: z.string().trim().refine(isValidCron, "A schedule has five parts, like 0 6 * * * for every day at 06:00"),
    tz: z.string().refine(isTimeZone, "Pick a time zone from the list"),
    graceMin: z.number().int().min(1, "Between 1 and 1,440 minutes").max(1440, "Between 1 and 1,440 minutes"),
    maxRunMin: z.number().int().min(1, "Between 1 and 1,440 minutes").max(1440, "Between 1 and 1,440 minutes"),
    assertions: z.array(assertion).max(10),
  }),
]);

export type MonitorDraft = z.input<typeof draftSchema>;

/** What `create_monitor` is given, less what the server adds (id, interval, token, sealing). */
export type MonitorRow = {
  type: CreatableType;
  appId: string;
  name: string;
  target: string;
  /** The host the checks reach, for the per-host cap; null when no host is reached. */
  targetHost: string | null;
  config: Record<string, unknown>;
  /** Plaintext here; `actions.ts` seals each one before it leaves the server. */
  secrets: { name: string; value: string }[];
  /** The interval for types whose interval is fixed or derived; http and tcp take the plan's. */
  fixedIntervalSec: number | null;
};

export type ParseResult = { ok: true; row: MonitorRow } | { ok: false; fieldErrors: Record<string, string> };

/** Editing: the secret headers already stored. One of them sent with no value keeps its stored value. */
export type ParseOptions = { storedHeaders?: readonly string[] };

/** Zod's path for a field, as the form names it. */
const FIELD: Record<string, string> = { recordName: "dnsName", expected: "dnsExpected", schedule: "cron", assertions: "asserts", graceMin: "grace", maxRunMin: "maxRun" };

export function parseMonitorDraft(raw: unknown, opts: ParseOptions = {}): ParseResult {
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = FIELD[String(issue.path[0])] ?? String(issue.path[0] ?? "form");
      if (fieldErrors[key]) continue;
      fieldErrors[key] = key === "asserts" ? "Each assertion needs a path and a comparison" : key === "headers" && issue.path.length > 1 ? "Each header needs a name and a value" : issue.message;
    }
    return { ok: false, fieldErrors };
  }
  const d = parsed.data;
  const errors: Record<string, string> = {};
  let row: MonitorRow | null = null;

  if (d.type === "supabase") {
    const ref = projectRef(d.projectUrl);
    const kept = !d.key && opts.storedHeaders?.includes(SERVICE_KEY);
    if (!ref) errors.projectUrl = "Use the project URL: https://<project-ref>.supabase.co";
    if (!kept && (!ref || !isPublishableKey(d.key, ref))) errors.key = "Use this project's publishable or legacy anon key, never a secret or service-role key.";
    if (d.databaseRead && !databaseReadName(d.databaseRead)) errors.databaseRead = "Use a table or view name, or rpc/function_name, with no query or path.";
    if (ref) row = { type: d.type, appId: d.appId, name: d.name || "Supabase project", target: `https://${ref}.supabase.co`, targetHost: `${ref}.supabase.co`,
      config: { projectUrl: `https://${ref}.supabase.co`, databaseRead: d.databaseRead }, secrets: [{ name: SERVICE_KEY, value: d.key }], fixedIntervalSec: null };
  } else if (d.type === "stripe") {
    if (!d.key && !opts.storedHeaders?.includes(SERVICE_KEY) || d.key && !restrictedKey(d.key)) errors.key = "Use a restricted rk_test_ or rk_live_ key. Secret keys are refused.";
    row = { type: d.type, appId: d.appId, name: d.name || "Stripe webhooks", target: "https://api.stripe.com", targetHost: null,
      config: { endpoints: [...new Set(d.endpoints)], critical: [...new Set(d.critical)], failureThreshold: d.failureThreshold, windowMin: d.windowMin, pendingMin: d.pendingMin },
      secrets: [{ name: SERVICE_KEY, value: d.key }], fixedIntervalSec: null };
  } else if (d.type === "http") {
    const u = parseUrl(d.url);
    if (!u) errors.url = "Enter a full address, starting with https://";
    else if (u.username || u.password) errors.url = "Put credentials in a secret header, not in the address.";
    else {
      const host = bareHost(u.hostname);
      const refusal = refuseHost(host, true);
      if (refusal) errors.url = refusal;
    }
    const headerError = checkHeaders(d.headers, opts.storedHeaders ?? []);
    if (headerError) errors.headers = headerError;
    if (u && !Object.keys(errors).length) {
      row = {
        type: "http",
        appId: d.appId,
        name: d.name || defaultName(u.href),
        target: u.href,
        targetHost: bareHost(u.hostname),
        config: { method: d.method, expect: d.expect, keyword: d.keyword || null, slowMs: d.slowMs, timeoutSec: 15, assertions: cleanAssertions(d.assertions) },
        secrets: d.headers.map((h) => ({ name: h.name, value: h.value })),
        fixedIntervalSec: null,
      };
    }
  } else if (d.type === "ssl" || d.type === "tcp") {
    const host = d.host.replace(/\.$/, "");
    const shape = d.type === "ssl" ? HOSTNAME.test(host) : HOSTNAME.test(host) || isIP(host) !== 0;
    const refusal = shape ? refuseHost(host, d.type === "tcp") : "Enter a hostname, like api.example.com, without https://";
    if (refusal) errors.host = refusal;
    else if (d.type === "ssl") {
      row = { type: "ssl", appId: d.appId, name: d.name || host, target: host, targetHost: host, config: { host }, secrets: [], fixedIntervalSec: SSL_INTERVAL_SEC };
    } else {
      row = { type: "tcp", appId: d.appId, name: d.name || `${host} port ${d.port}`, target: `${host}:${d.port}`, targetHost: host, config: { host, port: d.port, tls: d.tls, slowMs: d.slowMs }, secrets: [], fixedIntervalSec: null };
    }
  } else if (d.type === "dns") {
    if (d.record === "NS") {
      const names = [...new Set(d.expected.split(/[\s,]+/).filter(Boolean).map(n => n.toLowerCase().replace(/\.$/, "")))].sort();
      if (!names.length || names.some(n => !HOSTNAME.test(n) || isLocalName(n))) errors.dnsExpected = "Enter the complete set of public nameservers, separated by commas or spaces.";
      d.expected = names.join(", ");
      if (d.expected.length > 500) errors.dnsExpected = "Keep the complete nameserver set under 500 characters.";
    }
    // Public resolvers are asked, never the host, so only names that can't be public are refused.
    if (isLocalName(d.recordName)) errors.dnsName = `${d.recordName} only exists inside a private network, so public resolvers can't answer for it.`;
    else {
      const owner = d.recordName.split(".").filter((l, i, all) => !(l.startsWith("_") && all.slice(0, i).every((x) => x.startsWith("_")))).join(".");
      row = {
        type: "dns",
        appId: d.appId,
        name: d.name || `${d.recordName} ${d.record}`,
        target: `${d.record} ${d.recordName}`,
        targetHost: /^[a-z0-9.-]+$/.test(owner) ? owner : null,
        config: { record: d.record, name: d.recordName, expected: d.expected },
        secrets: [],
        fixedIntervalSec: DNS_INTERVAL_SEC,
      };
    }
  } else {
    const masked = d.assertions.map(maskedAssertion).find((m) => m !== null);
    if (masked) errors.asserts = masked;
    row = {
      type: "heartbeat",
      appId: d.appId,
      name: d.name || "Scheduled job",
      target: "in.staygreen.io",
      targetHost: null,
      config: { schedule: d.schedule, tz: d.tz, graceMin: d.graceMin, maxRunMin: d.maxRunMin, assertions: cleanAssertions(d.assertions) },
      secrets: [],
      fixedIntervalSec: heartbeatIntervalSec(d.schedule),
    };
  }

  if (Object.keys(errors).length || !row) return { ok: false, fieldErrors: errors };
  return { ok: true, row };
}

/** Why a heartbeat's assertion could never pass, or null. The receiver masks what a job sends
 *  before it is stored (`ingest/src/handler.ts`, `src/checks/mask.ts`): everything under a
 *  secret-named field, and the emails, keys and long hex strings inside any value. The home
 *  judges what was stored, so an assertion that needs a masked value would fail on every ping and
 *  its incident would never close. It is refused here, saying what to assert instead: an
 *  assertion never fails because of the masking. */
export function maskedAssertion(a: { path: string; op: string; value: string }): string | null {
  const steps = parsePath(a.path) ?? [];
  for (const [i, step] of steps.entries()) {
    if (typeof step !== "string") continue;
    if (mask(step) !== step) {
      return "A field named like an email address or a key is hidden when a ping arrives, so it can't be checked. Send that value under a plain name, like recipient.";
    }
    if (isSecretName(step) && (i < steps.length - 1 || a.op !== "exists")) {
      return `Staygreen hides whatever a job sends under ${step}, because the name says it's a secret, so this could never pass. Check that ${step} exists instead, or send the value under another name.`;
    }
  }
  if (a.op === "exists") return null;
  // A needle that is part of an email or a hash can't be found in one that was masked.
  const fragment = a.op === "contains" && (a.value.includes("@") || (a.value.match(/[0-9a-fA-F]{7,}/g) ?? []).some((h) => /\d/.test(h)));
  if (mask(a.value) !== a.value || fragment) {
    return "Staygreen hides email addresses, keys and long hashes in what a job sends before it checks it, so this could never pass. Compare a count or a status instead, or check that the field exists.";
  }
  return null;
}

function cleanAssertions(list: { path: string; op: (typeof OPS)[number]; value: string }[]) {
  return list.map((a) => ({ path: a.path, op: a.op, value: a.op === "exists" ? "" : a.value }));
}

function checkHeaders(list: { name: string; value: string }[], stored: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const h of list) {
    if (!HEADER_NAME.test(h.name)) return "A header name uses letters, digits and dashes, like Authorization";
    if (RESERVED_HEADERS.includes(h.name.toLowerCase())) return `Staygreen sets ${h.name} itself.`;
    if (seen.has(h.name.toLowerCase())) return `${h.name} is in the list twice.`;
    seen.add(h.name.toLowerCase());
    if (!h.value && stored.includes(h.name)) continue;
    if (!h.value || h.value.length > 4096 || /[\r\n]/.test(h.value)) return `Enter a value for ${h.name}, on one line.`;
    // What Node will send in a header; anything else stops the request before it leaves.
    if (/[^\t\x20-\x7e\x80-\xff]/.test(h.value)) return `${h.name} has a character a header can't carry, such as a curly quote. Retype it with plain characters.`;
  }
  return null;
}

function parseUrl(v: string): URL | null {
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** `URL` keeps IPv6 literals in brackets; the table keeps them bare. */
const bareHost = (h: string) => h.replace(/^\[|\]$/g, "").replace(/\.$/, "");

/** Why a host can't be checked, or null. `allowIp` is false where a certificate is the subject. */
function refuseHost(host: string, allowIp: boolean): string | null {
  if (isIP(host)) {
    if (!allowIp) return "Enter a hostname, like api.example.com, without https://";
    return isPublicIp(host) ? null : PRIVATE(host);
  }
  if (isLocalName(host)) return PRIVATE(host);
  return null;
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A readable name from an address's last path segment, as the form suggests it. */
export function defaultName(u: string) {
  const path = u.replace(/^https?:\/\/[^/]+/, "").replace(/[?#].*$/, "").replace(/\/$/, "");
  const last = path.split("/").filter(Boolean).pop();
  if (!last) return "Website";
  const words = decodeURIComponentSafe(last).replace(/[-_]/g, " ");
  return (words.charAt(0).toUpperCase() + words.slice(1)).slice(0, 80);
}

function decodeURIComponentSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function hostOf(v: string) {
  try {
    return bareHost(new URL(v.startsWith("http") ? v : `https://${v}`).hostname);
  } catch {
    return "";
  }
}
