import { randomBytes } from "node:crypto";
import { RESOLVERS, type Ask } from "@/checks/dns";
import { checkTcp } from "@/checks/tcp";
import { bodyText, mask } from "@/checks/mask";
import type { CheckResult, AddressGuard } from "@/checks/types";
import type { Observed } from "@/checks/http";
import { baseOf, decodeEntities, inlineCss, resolvedUrl, tagsOf } from "./html-read";
import { registrableDomain, sameDomain } from "./dependency-detect";
import type { Queue } from "./dependency-checks";
import { accentCandidates } from "./brand";
import { iconCandidates } from "./favicon";
import { FAILURE_WORDS, healthJson } from "./health-body";
import type { HttpSuggestion, TcpSuggestion } from "./suggestions";

export type SuggestRead = Pick<Observed, "url" | "status" | "headers" | "body" | "truncated" | "blockedByBot">;
export type SuggestGet = (url: string, own: number, bytes: number, extra?: { headers?: Record<string, string>; followRedirects?: boolean; keyword?: string }) => Promise<{ result: CheckResult; read: SuggestRead | null }>;
export const API_PATHS = ["/health", "/healthz", "/ping", "/status", "/api/health"] as const;
export const versionPath = (url: string) => /\/version\/?$/.test(new URL(url).pathname);

/** Failed health JSON stays visible but never participates in automatic picks/assertions. */
export function healthFailure(json: unknown, body: Buffer): string | null {
  let found: string | null = null;
  const walk = (v: unknown, depth: number) => {
    if (found || depth > 6 || !v || typeof v !== "object") return;
    for (const [key, value] of Object.entries(v).slice(0, 80)) {
      if ((["ok", "healthy", "success", "up"].includes(key.toLowerCase()) && value === false) ||
        key.toLowerCase() === "error" ||
        (["status", "state"].includes(key.toLowerCase()) && typeof value === "string" && FAILURE_WORDS.has(value.toLowerCase())) || value === "not_found") {
        found = `${key}: ${JSON.stringify(value)}`; return;
      }
      walk(value, depth + 1);
    }
  };
  walk(json, 0);
  if (!found && /^(?:not_found|error|fail(?:ed)?|down|unhealthy)$/i.test(bodyText(body).trim())) found = bodyText(body).trim();
  return found ? `The health body reported ${mask(found, []).slice(0, 200)}` : null;
}

export function appLink(html: string, pageUrl: string): string | null {
  const page = new URL(pageUrl);
  if (page.pathname !== "/") return null;
  const base = baseOf(html, pageUrl);
  // Anchor text, not a hostname guess. Scan one linked app and never recurse into its links.
  for (const match of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<a\b([^>]{0,4096})>([\s\S]{0,1000}?)<\/a\s*>/gi)) {
    const text = decodeEntities(match[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (!/^(?:log\s?in|sign\s?in|dashboard|app|console)$/i.test(text)) continue;
    const attr = tagsOf(`<a ${match[1]}>`, "a")[0];
    const address = resolvedUrl(attr?.get("href") ?? "", base);
    if (!address) continue;
    const u = new URL(address);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port || u.hostname === page.hostname || !sameDomain(page.hostname, u.hostname)) continue;
    return `${u.origin}/`;
  }
  return null;
}

export function namedApi(texts: readonly string[], pageUrl: string, headers: SuggestRead["headers"] = {}): string | null {
  const host = `api.${registrableDomain(new URL(pageUrl).hostname)}`;
  const text = [...texts, ...Object.values(headers).flat().filter(Boolean)].join("\n").replace(/\\(?:u002[fF]|\/)/g, "/");
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`\\),;]+/g)) {
    try { const u = new URL(m[0]); if (u.hostname === host && !u.port && !u.username && !u.password) return u.origin; } catch { /* Not a URL. */ }
  }
  return null;
}

const titleOf = (html: string) => decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
export function sameBrand(a: { html: string; url: string }, b: { html: string; url: string }): boolean {
  // A title match must include the domain's brand token; common words such as "Sign in"
  // cannot make a vendor's tenant and its corporate homepage appear to be the same app.
  const domain = registrableDomain(new URL(a.url).hostname);
  const label = domain?.split(".")[0].toLowerCase() ?? "";
  const brands = [label, label.replace(/apps?$/, "")].filter(b => b.length >= 3);
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  if (brands.some(brand => words(titleOf(a.html)).includes(brand) && words(titleOf(b.html)).includes(brand))) return true;
  const icons = (p: typeof a) => iconCandidates(p.html, p.url, []).filter(u => !new URL(u, p.url).pathname.endsWith("/favicon.ico"));
  if (icons(a).some(u => icons(b).includes(u))) return true;
  const colours = (html: string) => accentCandidates({ html, css: [inlineCss(html)] }).map(c => c.hex);
  return colours(a.html).some(c => colours(b.html).includes(c));
}

/** A guessed hostname counts only when DNS tells it apart from a random label: A and AAAA from
 * both resolvers. With no wildcard any address does; under a wildcard only addresses the random
 * label never got, as `smtp.postmarkapp.com` has its own beside `*.postmarkapp.com`. Timeouts and
 * SERVFAIL are unknown, never evidence. */
export function hostDiscovery(domain: string | null, ask: Ask, queue: Queue, left: () => number) {
  // Every answer, with null for one that never came: the random label needs all four, the
  // guessed name only one address, since an unanswered query can't add a wildcard's address.
  const resolve = (host: string) => Promise.all(RESOLVERS.flatMap(({ server }) => (["A", "AAAA"] as const).map(record => queue(async () => {
    if (left() < 100) return null;
    try { return await ask(server, host, record); }
    catch (error) { return ["ENODATA", "ENOTFOUND"].includes((error as NodeJS.ErrnoException).code ?? "") ? [] : null; }
  }))));
  const wildcard = domain ? resolve(`staygreen-${randomBytes(12).toString("hex")}.${domain}`).then(a => a.includes(null) ? null : new Set(a.flat())) : Promise.resolve(null);
  return async (label: "api" | "smtp") => {
    const random = await wildcard;
    if (!domain || !random) return null;
    const own = (await resolve(`${label}.${domain}`)).flatMap(a => a ?? []);
    return own.length && own.every(a => !random.has(a as string)) ? `${label}.${domain}` : null;
  };
}

export async function websiteSuggestion(html: string, pageUrl: string, get: SuggestGet, address = pageUrl): Promise<HttpSuggestion | null> {
  const u = new URL(address), page = new URL(pageUrl), domain = registrableDomain(u.hostname);
  if (!domain || u.port || u.hostname === domain || u.hostname === `www.${domain}` || !sameDomain(u.hostname, page.hostname)) return null;
  // Apex redirects normally select www. Try www explicitly if the apex isn't a matching site.
  for (const host of [domain, `www.${domain}`]) {
    const url = `https://${host}/`;
    const { result, read } = await get(url, 4, 256 * 1024);
    if (!result.ok || !read) continue;
    if (read.url === pageUrl || new URL(read.url).origin === page.origin) continue;
    if (!sameDomain(new URL(read.url).hostname, u.hostname) || !/html/i.test(String(read.headers["content-type"]))) continue;
    const otherHtml = bodyText(read.body);
    if (!sameBrand({ html, url: pageUrl }, { html: otherHtml, url: read.url })) continue;
    return { kind: "http", url, name: "Website", root: false, discovered: true, ok: true, ticked: false, status: result.status, ms: result.ms, purpose: "The brand's website, on a host of its own: it can be down while the app is up." };
  }
  return null;
}

export async function smtpSuggestion(host: string | null, queue: Queue, left: () => number, net: { allow?: AddressGuard; ca?: string | Buffer }): Promise<TcpSuggestion[]> {
  if (!host) return [];
  for (const port of [587, 465]) {
    const result = await queue(async () => {
      const timeoutSec = Math.min(3, left() / 1000);
      return timeoutSec < 0.1 ? null : checkTcp({ host, port, tls: port === 465, timeoutSec, slowMs: 1000 }, net);
    });
    if (result?.ok) return [{ kind: "tcp", host, port, tls: port === 465, name: "SMTP", ms: result.ms }];
  }
  return [];
}

/** What a JSON answer looks like without its wording: its top-level keys, or "array". */
export const jsonShape = (v: unknown) => v === undefined ? null : Array.isArray(v) ? "array" : v && typeof v === "object" ? Object.keys(v).sort().join(",") : typeof v;

export function jsonAnswer(read: SuggestRead | null): unknown {
  return read && /(?:application\/json|\+json)\b/i.test(String(read.headers["content-type"])) ? healthJson(read.body, read.truncated) : undefined;
}
