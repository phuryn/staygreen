import { getDomain } from "tldts";
import { baseOf, decodeEntities, resolvedUrl, tagsOf } from "./html-read";
import { ipVersion, isLocalName } from "./ip";
import { findSupabase, supabaseUrl } from "./supabase-detect";

/** Deterministic catalogue; signatures/endpoints and their sources are pinned in
 * tests/unit/dependency-detect.test.ts. No script is executed or fetched to detect these. */
export type DependencyProvider = "Clerk" | "Supabase Auth" | "Firebase Auth" | "Auth0" | "Auth.js" | "First-party dependency";
export type DependencyTarget = { provider: DependencyProvider; host: string; url: string; keyword: string; purpose: string; headers?: Record<string, string>; requiresKey?: boolean };
export const MAX_DEPENDENCIES = 6;
export const registrableDomain = (host: string) => isLocalName(host) || ipVersion(host) ? null : getDomain(host, { allowPrivateDomains: true, extractHostname: false });
export const sameDomain = (a: string, b: string) => !!registrableDomain(a) && registrableDomain(a) === registrableDomain(b);

/** Same-domain vendor aliases can live under an API name too. DNS evidence decides the
 * vendor; an API prefix alone must never turn into a generic sign-in HTTP check. */
export function cnameHosts(text: string, appUrl: string): string[] {
  const owner = new URL(appUrl).hostname;
  const hosts: string[] = [];
  for (const m of text.replace(/\\(?:u002[fF]|\/)/g, "/").matchAll(/https?:\/\/[^\s<>"'`\\),;]+/g)) {
    try { const u = new URL(m[0]); if (!u.username && !u.password && /^(?:api|auth|accounts|clerk)\./.test(u.hostname) && sameDomain(owner, u.hostname) && !hosts.includes(u.hostname)) hosts.push(u.hostname); } catch { /* Not a URL. */ }
  }
  return hosts.slice(0, MAX_DEPENDENCIES);
}

function publicHost(value: string): string | null {
  try {
    const u = new URL(`https://${value}`);
    return u.host === value.toLowerCase() && !u.port && u.pathname === "/" && !u.username && !u.password && !u.search && !u.hash &&
      !ipVersion(u.hostname) && !isLocalName(u.hostname) && registrableDomain(u.hostname) ? u.hostname : null;
  } catch { return null; }
}
export function clerkHost(key: string): string | null {
  if (!/^pk_(?:live|test)_[A-Za-z0-9+/=_-]{4,400}$/.test(key)) return null;
  try {
    const decoded = atob(key.slice(8).replace(/-/g, "+").replace(/_/g, "/"));
    return decoded.endsWith("$") ? publicHost(decoded.slice(0, -1)) : null;
  } catch { return null; }
}

export function detectDependencies(html: string, pageUrl: string, headers: Record<string, string | string[] | undefined> = {}, appUrl = pageUrl): DependencyTarget[] {
  const app = new URL(pageUrl); const base = baseOf(html, pageUrl);
  const ownerHost = new URL(appUrl).hostname;
  // Hydration strings may escape their quotes and slashes. Comments aren't evidence.
  const clean = html.replace(/<!--[\s\S]*?-->/g, "");
  const evidence = [...clean.matchAll(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi), ...clean.matchAll(/\bdata-clerk-publishable-key\s*=\s*["'][^"']+["']/gi)].map(m => m[0]).join("\n");
  const source = decodeEntities(evidence).replace(/\\(?:u002[fF]|\/)/g, "/").replace(/\\"/g, '"');
  const policy = [headers.link, headers["content-security-policy"]].flat().filter(Boolean).join(" ");
  const scripts = tagsOf(html, "script").flatMap(tag => { const url = resolvedUrl(tag.get("src") ?? "", base); return url ? [url] : []; });
  const targets: DependencyTarget[] = [];
  const add = (provider: DependencyProvider, url: string, keyword: string, purpose: string, auth?: Record<string, string>) => {
    try {
      const u = new URL(url);
      // Never reflect or fetch embedded query credentials, userinfo or keys. The scan also
      // applies scanUrl at every connection; suggestions retain the normal network guard.
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || !publicHost(u.hostname) || (u.port && !["80", "443"].includes(u.port)) || /pk_(?:live|test)_/i.test(decodeURIComponent(u.href))) return;
      if (targets.length < MAX_DEPENDENCIES && !targets.some(t => t.url === u.href)) targets.push({ provider, host: u.hostname, url: u.href, keyword, purpose, ...(auth ? { headers: auth } : {}) });
    } catch { /* A malformed signature supplies no endpoint. */ }
  };
  const clerkScripts = scripts.filter(url => /\/npm\/@clerk\/clerk-js(?:@[^/]+)?\/dist\/clerk\.browser(?:\.production)?\.js$/.test(new URL(url).pathname));
  for (const url of clerkScripts) add("Clerk", url, "Clerk", "Catches a missing sign-in script, including a broken custom-domain DNS record.");
  for (const match of source.matchAll(/\bpk_(?:live|test)_[A-Za-z0-9+/=_-]{4,400}/g)) {
    const host = clerkHost(match[0]);
    if (host && !targets.some(t => t.provider === "Clerk" && t.host === host)) add("Clerk", `https://${host}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, "Clerk", "Catches a missing sign-in script, including a broken custom-domain DNS record.");
  }
  for (const match of source.matchAll(/["']?authDomain["']?\s*:\s*["']([^"']+)["']/g)) {
    const host = publicHost(match[1]);
    if (host) add("Firebase Auth", `https://${host}/__/auth/iframe`, "iframe.js", "Catches an unavailable Firebase sign-in helper; it does not test a user's login.");
  }
  // A bare 'domain' field isn't Auth0. Require its SDK configuration or an actual tenant URL.
  for (const match of source.matchAll(/(?:createAuth0Client|Auth0Client|auth0\.WebAuth)\s*\(\s*\{([^}]{0,2000})\}/g)) {
    const domain = /["']?domain["']?\s*:\s*["']([^"']+)["']/.exec(match[1])?.[1];
    const host = domain ? publicHost(domain) : null;
    if (host) add("Auth0", `https://${host}/.well-known/openid-configuration`, '"authorization_endpoint"', "Catches unavailable sign-in discovery on the Auth0 tenant or custom domain.");
  }
  const addresses = [...scripts, ...[...`${source}\n${policy}`.matchAll(/https:\/\/[^\s<>"'`\\),;]+/g)].map(m => m[0])];
  for (const address of addresses) {
    try {
      const u = new URL(address);
      // Auth0's shared SDK CDN identifies no tenant and cannot prove an app's sign-in.
      if (u.hostname !== "cdn.auth0.com" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)?\.auth0\.com$/.test(u.hostname)) add("Auth0", `https://${u.hostname}/.well-known/openid-configuration`, '"authorization_endpoint"', "Catches unavailable sign-in discovery on the Auth0 tenant or custom domain.");
    } catch { /* Not an address. */ }
  }
  const cookieNames = (Array.isArray(headers["set-cookie"]) ? headers["set-cookie"] : [headers["set-cookie"]]).map(v => v?.split("=", 1)[0] ?? "").join(" ");
  if (/\/(?:api\/auth)\/(?:signin|session|providers|csrf)\b|\bnext-auth\/react\b|\bNextAuth\s*\(/.test(source) || tagsOf(html, "a").some(t => /^\/api\/auth\/signin(?:$|[/?])/.test(t.get("href") ?? "")) || /(?:next-auth|authjs)\.(?:csrf-token|session-token|callback-url)/.test(cookieNames)) {
    add("Auth.js", `${app.origin}/api/auth/providers`, '"signinUrl"', "Catches a missing provider list on the app's sign-in route.");
  }
  const project = findSupabase([source]);
  if (project) {
    add("Supabase Auth", supabaseUrl(project.ref, "auth"), "GoTrue", "Catches an unavailable Supabase Auth service; requires the project's publishable key.", project.key ? { apikey: project.key } : undefined);
    const target = targets.find(t => t.provider === "Supabase Auth");
    if (target && !project.key) target.requiresKey = true;
  }
  // Unknown first-party hosts are still dependencies. Watch the actual script/API URL,
  // never invent a provider-specific path or a keyword its response need not contain.
  for (const address of addresses) {
    try {
      const u = new URL(address);
      if (u.hostname !== ownerHost && /^(?:clerk|accounts|auth)\./.test(u.hostname) && sameDomain(u.hostname, ownerHost) && !targets.some(t => t.host === u.hostname)) {
        add("First-party dependency", u.href, "", "Catches an unavailable first-party sign-in endpoint; no sign-in flow is exercised.");
      }
    } catch { /* Not an address. */ }
  }
  return targets.slice(0, MAX_DEPENDENCIES);
}
