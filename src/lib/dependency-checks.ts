import "server-only";
import { Resolver } from "node:dns/promises";
import { dnsSet, RESOLVERS, type Ask } from "@/checks/dns";
import type { CheckResult } from "@/checks/types";
import { registrableDomain, sameDomain, type DependencyTarget, type DependencyProvider } from "./dependency-detect";
import { BOT_PROTECTION } from "./bot-protection";

export type DependencyState = "ok" | "issue" | "unknown" | "skipped";
export type DependencyFinding = Omit<DependencyTarget, "headers" | "requiresKey"> & { dns: DependencyState; tls: DependencyState; frontend: DependencyState; status?: number; ms?: number; reason?: string };
export type DnsSuggestion = { kind: "dns"; record: "NS" | "CNAME"; recordName: string; expected: string; name: string; purpose: string; watched?: boolean };
export type DependencyReport = { checks: DependencyFinding[]; dns: DnsSuggestion[] };
export type DependencyCheckResult = CheckResult & { entryAnswered?: boolean };
export type DependencyGet = (target: DependencyTarget) => Promise<DependencyCheckResult>;
export type Queue = <T>(task: () => Promise<T>) => Promise<T>;

/** Fixed public resolvers only; one bounded attempt per resolver, no target connection. */
export function dependencyDns(left: () => number): Ask {
  return async (server, name, record) => {
    if (left() < 100) throw Error("deadline");
    const resolver = new Resolver({ timeout: Math.min(1500, Math.floor(left())), tries: 1 });
    resolver.setServers([server]);
    if (record === "NS") return resolver.resolveNs(name);
    if (record === "CNAME") return resolver.resolveCname(name);
    if (record === "A") return resolver.resolve4(name);
    if (record === "AAAA") return resolver.resolve6(name);
    throw Error("unsupported record");
  };
}

/** These are observations, not a browser login. A timeout supplies no evidence of DNS/TLS
 * success; later HTTP failures do, as do the transport's connection/handshake timings. */
export function dependencyFinding(target: DependencyTarget, result: DependencyCheckResult): DependencyFinding {
  const { headers: _headers, requiresKey: _requiresKey, ...publicTarget } = target;
  const failure = result.failure?.kind;
  const reached = result.entryAnswered || !!result.status || result.timings?.connectMs !== undefined || result.timings?.tlsMs !== undefined;
  const dns: DependencyState = reached || failure === "connect" || failure === "tls" ? "ok" : failure === "dns" || failure === "private" ? "issue" : "unknown";
  const tls: DependencyState = !target.url.startsWith("https:") ? "skipped" : result.entryAnswered || result.timings?.tlsMs !== undefined || !!result.status ? "ok" : failure === "tls" ? "issue" : "unknown";
  return { ...publicTarget, dns, tls, frontend: result.ok ? "ok" : failure === "timeout" ? "unknown" : "issue", ...(result.status ? { status: result.status } : {}), ms: result.ms, ...(result.failure?.message === BOT_PROTECTION ? { reason: BOT_PROTECTION } : {}) };
}

export async function checkDependencies(targets: DependencyTarget[], pageUrl: string, get: DependencyGet, ask: Ask, queue: Queue, left: () => number, otherHosts: string[] = []): Promise<DependencyReport> {
  const appHost = new URL(pageUrl).hostname;
  const domain = registrableDomain(appHost);
  const dnsTargets = [
    ...(domain ? [{ record: "NS" as const, recordName: domain, name: "Domain nameservers", purpose: "Alerts when the domain's nameservers change, as in a registrar transfer or a hijack. A domain that stops resolving already fails its HTTP check." }] : []),
    ...[...new Set([...targets.map(t => t.host), ...otherHosts].filter(host => host !== appHost && sameDomain(host, appHost)))].slice(0, 6).map(recordName => ({ record: "CNAME" as const, recordName, name: "Sign-in DNS alias", purpose: "Alerts when this vendor's custom-domain CNAME changes. If it stops resolving, the host's HTTP check fails anyway." })),
  ];
  const dns = Promise.all(dnsTargets.map(async target => {
    const answers = await Promise.all(RESOLVERS.map(({ server }) => queue(async () => {
      if (left() < 100) return null;
      try { return dnsSet(await ask(server, target.recordName, target.record)); } catch { return null; }
    })));
    // No baseline from a missing record, disagreement or incomplete read: don't invent a
    // CNAME for a flattened/proxied host, or freeze a partial nameserver set as correct.
    const [a, b] = answers;
    if (!a?.length || !b?.length || JSON.stringify(a) !== JSON.stringify(b)) return null;
    const vendor = target.record === "CNAME" ? cnameVendor(a[0]) : null;
    if (target.record === "CNAME" && (a.length !== 1 || !vendor)) return null;
    const expected = a.join(", ");
    if (expected.length > 500 || a.some(name => !registrableDomain(name) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(name))) return null;
    return { kind: "dns" as const, ...target, ...(vendor ? { name: `${vendor} DNS record` } : {}), expected };
  }));
  const checks = await Promise.all(targets.map(async target => {
    if (target.requiresKey) return { ...dependencyFinding(target, { ok: false, ms: 0 }), frontend: "skipped" as const };
    if (left() < 100) return { ...dependencyFinding(target, { ok: false, ms: 0 }), frontend: "unknown" as const };
    try { return dependencyFinding(target, await get(target)); }
    catch { return { ...dependencyFinding(target, { ok: false, ms: 0 }), frontend: "unknown" as const }; }
  }));
  return { checks, dns: (await dns).filter((v): v is DnsSuggestion => v !== null) };
}

export const dependencyName = (provider: DependencyProvider) => `${provider} frontend`;

/** Only vendor-controlled custom-domain targets, never a rotating CDN/LB hostname.
 * The source catalogue and the deliberately narrow patterns live in docs/dependencies.md. */
export function cnameVendor(target: string): string | null {
  const host = target.toLowerCase().replace(/\.$/, "");
  const vendors: [string, RegExp][] = [
    ["Clerk", /^[\w.-]+\.clerk\.services$/],
    ["Auth0", /^[a-z0-9-]+\.edge\.(?:tenants\.)?(?:[a-z]{2}\.)?auth0\.com$/],
    ["Okta", /^[a-z0-9-]+\.(?:customdomains\.)?okta(?:-dnssec)?\.com$/],
    ["Stytch", /^[a-z0-9-]+\.customers\.stytch\.com$/],
    ["Supabase", /^[a-z0-9-]+\.supabase\.co$/],
    ["Ory", /^[a-z0-9-]+\.projects\.oryapis\.com$/],
    ["WorkOS", /^[a-z0-9-]+\.authkit\.app$/],
  ];
  return vendors.find(([, pattern]) => pattern.test(host))?.[0] ?? null;
}
