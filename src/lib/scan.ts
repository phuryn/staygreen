import "server-only";
import { checkCert } from "@/checks/cert";
import { checkHttp, type Observed } from "@/checks/http";
import { guardedFetch, Rdap, type RdapFetch } from "@/checks/rdap";
import { checkSupabase } from "@/checks/supabase";
import { checkStripe } from "@/checks/stripe";
import { serviceFetch, type ServiceFetch } from "@/checks/service-fetch";
import { mask } from "@/checks/mask";
import { scanInput, scanOutput, scanUrl, type ScanInput, type ScanResult } from "./scan-contract";
import { cnameHosts, detectDependencies } from "./dependency-detect";
import { checkDependencies, dependencyDns, type DependencyReport } from "./dependency-checks";
import { requestLimit } from "./request-limit";
import type { Ask } from "@/checks/dns";
import { botProtection, checkedForBot } from "./bot-protection";

export const scanDependencies = { cert: checkCert, http: checkHttp, supabase: checkSupabase, stripe: checkStripe,
  rdapFetch: guardedFetch({ timeoutSec: 4, allowUrl: address => scanUrl.safeParse(address).success }), serviceFetch: serviceFetch(), dns: undefined as Ask | undefined };

/** Links are evidence of a discoverable status page, not a claim that its host is healthy.
 * We never fetch a discovered link. Query strings and credentials never leave the scan. */
export function statusLink(html: string, base: string): string | null {
  for (const tag of html.matchAll(/<(?:a|link)\b[^>]{0,4096}>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag[0])?.[1];
    if (!href) continue;
    try {
      const u = new URL(href, base);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash) continue;
      if (/(?:^|\.)status\./i.test(u.hostname) || /(?:^|\/)status(?:\/|$)/i.test(u.pathname) || /\brel\s*=\s*["']status["']/i.test(tag[0])) return u.href;
    } catch { /* Not an absolute or relative web address. */ }
  }
  return null;
}

/** Caller MUST admit the request before entering. No DB access, persistence, shared results,
 * raw error messages or provider payloads. Each branch has a time and request/byte ceiling. */
export async function runScan(raw: ScanInput, deps = scanDependencies): Promise<ScanResult> {
  const input = scanInput.parse(raw); const url = new URL(input.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const safe = async <T>(work: () => Promise<T>): Promise<T | null> => { try { return await work(); } catch { return null; } };
  let final: Observed | undefined;
  const end = performance.now() + 18_000;
  const left = () => end - performance.now();
  const queue = requestLimit(4);
  let dependencies: DependencyReport = { checks: [], dns: [] };
  let rdapCalls = 0;
  const rdapFetch: RdapFetch = async (address, maxBytes) => {
    if (++rdapCalls > 5 || performance.now() >= end) return { error: "Scan limit reached" };
    return queue(() => left() > 0 ? deps.rdapFetch(address, maxBytes) : Promise.resolve({ error: "Scan limit reached" }));
  };
  let serviceCalls = 0;
  const fetch: ServiceFetch = (address, headers, timeout) => ++serviceCalls > 24
    ? Promise.resolve({ error: "protocol" }) : queue(() => left() < 100 ? Promise.resolve({ error: "timeout" }) : deps.serviceFetch(address, headers, Math.min(timeout, left())));
  const [cert, domain, http, supabase, stripe] = await Promise.all([
    url.protocol === "https:" ? safe(() => queue(() => deps.cert({ host, port: Number(url.port || 443), timeoutSec: 10 }))) : null,
    safe(() => new Rdap(rdapFetch).lookup(host)),
    safe(async () => {
      const result = await queue(() => deps.http({ url: url.href, method: "GET", expect: "2xx", slowMs: 5000, timeoutSec: 8 },
        { allowUrl: address => scanUrl.safeParse(address).success, maxBodyBytes: 65536, observe: r => { if (!r.redirect) final = r; } }));
      if (final && !botProtection(final)) {
        const targets = detectDependencies(final.body.toString("utf8"), final.url, final.headers, url.href);
        dependencies = await checkDependencies(targets, url.href, target => queue(async () => {
          if (left() < 100) return { ok: false, ms: 0, failure: { kind: "timeout", message: "Scan limit reached" } };
          let entryAnswered = false;
          let blocked = false;
          const checked = await deps.http({ url: target.url, method: "GET", expect: "2xx", keyword: target.keyword, headers: target.headers, slowMs: 5000, timeoutSec: Math.min(4, left() / 1000) },
            { allowUrl: address => scanUrl.safeParse(address).success, maxBodyBytes: 512 * 1024, observe: r => { blocked ||= botProtection(r); if (r.url === target.url) entryAnswered = true; } });
          return { ...checkedForBot(checked, blocked), entryAnswered };
        }), deps.dns ?? dependencyDns(left), queue, left, cnameHosts([final.body.toString("utf8"), ...Object.values(final.headers).flat()].join("\n"), url.href));
      }
      return checkedForBot(result, !!final && botProtection(final));
    }),
    input.supabase_url ? safe(() => deps.supabase({ projectUrl: input.supabase_url!, databaseRead: "" }, input.supabase_key!, { fetch, timeoutMs: 12_000 })) : null,
    input.stripe_key ? safe(() => deps.stripe({ endpoints: [], critical: [], failureThreshold: 1, windowMin: 30 * 1440, pendingMin: 0 }, input.stripe_key!,
      { fetch, timeoutMs: 18_000, verifyKey: true })) : null,
  ]);
  const expiry = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
  const certExpiry = expiry(cert?.detail?.expiresAt);
  const domainExpiry = domain?.status === "found" && domain.expiresAt !== null ? new Date(domain.expiresAt).toISOString() : null;
  const found = http?.ok && final ? statusLink(final.body.toString("utf8"), final.url) : null;
  const count = typeof stripe?.detail?.count === "number" ? stripe.detail.count : null;
  const pending = typeof stripe?.detail?.pending === "number" ? stripe.detail.pending : null;
  const steps = Array.isArray(supabase?.detail?.steps) ? supabase.detail.steps : [];
  const result = scanOutput.parse({ checked_at: new Date().toISOString(), dependencies,
    certificate: { state: url.protocol !== "https:" ? "skipped" : cert ? cert.ok ? "ok" : "issue" : "unknown", expires_at: certExpiry,
      message: url.protocol !== "https:" ? "This address does not use HTTPS." : cert?.ok ? "The certificate is valid for this host." : "A valid certificate could not be confirmed." },
    domain: { state: domainExpiry ? Date.parse(domainExpiry) < Date.now() + 30 * 86400000 ? "issue" : "ok" : "unknown", expires_at: domainExpiry,
      message: domainExpiry ? "Registration expiry reported by the registry." : "The registry did not provide an expiry date during this scan." },
    status_page: { state: found ? "found" : "unknown", url: found, message: found ? "A status-page link appears on the app's page; its destination was not checked." : "No status-page link was found in the HTML we could read. A page may still exist." },
    supabase: { state: !input.supabase_url ? "skipped" : supabase?.ok ? "ok" : supabase ? "issue" : "unknown", steps,
      message: !input.supabase_url ? "Add a project URL and publishable key to check Auth and Storage." : supabase?.ok ? "Auth and Storage answered. These checks alone do not prevent a free project from pausing."
        : supabase?.failure?.kind === "project_paused" ? "The project address does not resolve: it may be paused or deleted." : "Auth or Storage could not be verified. Check the project's key and availability." },
    stripe: { state: !input.stripe_key ? "skipped" : count === null ? "unknown" : count > 0 ? "issue" : "ok", failed_events: count === null ? null : count - (pending ?? 0), pending_events: pending,
      message: !input.stripe_key ? "Add a restricted key to check failed deliveries." : count === null ? "Stripe's last 30 days could not be read completely within this scan's limits. Check Events read permission and that Customers read is denied."
        : "Account-wide events with failed delivery in the last 30 days; pending deliveries are counted separately. Stripe does not identify the affected endpoint here." },
    crons: input.crons ?? [], crons_message: input.crons ? "Repository findings supplied by the caller; a configured heartbeat has not been tested for delivery." : "Run npx staygreen scan <url> --repo <path> to inspect cron configuration.", mcp: "Coming soon" });
  // Explicit values cover a credential echoed in a caller-supplied cron name as well as
  // vendor data. The output schema already discards every undeclared field.
  const secrets = [input.stripe_key, input.supabase_key].filter((s): s is string => !!s);
  const scrub = (v: unknown): unknown => typeof v === "string" ? mask(v, secrets) : Array.isArray(v) ? v.map(scrub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)])) : v;
  return scanOutput.parse(scrub(result));
}
