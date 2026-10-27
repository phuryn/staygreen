import { getDomain } from "tldts";
import { isIP } from "node:net";

type Cookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; expires: number };
const domainMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** A bounded, in-memory jar owned by ONE check. No persistence or cross-check state.
 * SameSite is immaterial here: this is one top-level redirect chain, never a browser session. */
export class RedirectCookies {
  private cookies: Cookie[] = [];

  receive(url: URL, headers: readonly string[], now = Date.now()) {
    for (const header of headers.slice(0, 50)) {
      if (header.length > 4096) continue;
      const [pair, ...attributes] = header.split(";");
      const at = pair.indexOf("=");
      if (at < 1) continue;
      const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\x00-\x20\x7f;,]/.test(value)) continue;
      const attrs = new Map(attributes.map(a => { const i = a.indexOf("="); return i < 0 ? [a.trim().toLowerCase(), ""] : [a.slice(0, i).trim().toLowerCase(), a.slice(i + 1).trim()]; }));
      const host = url.hostname.toLowerCase();
      const domain = attrs.get("domain")?.replace(/^\./, "").toLowerCase() ?? host;
      const hostOnly = !attrs.has("domain");
      if (!domainMatches(host, domain) || (!hostOnly && (isIP(host) || !getDomain(domain, { allowPrivateDomains: true, extractHostname: false })))) continue;
      const secure = attrs.has("secure");
      if (secure && url.protocol !== "https:") continue;
      const defaultPath = url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
      const path = attrs.get("path")?.startsWith("/") ? attrs.get("path")! : defaultPath;
      if (name.startsWith("__Secure-") && !secure) continue;
      if (name.startsWith("__Host-") && (!secure || !hostOnly || path !== "/")) continue;
      const date = Date.parse(attrs.get("expires") ?? "");
      let expires = Number.isNaN(date) ? Infinity : date;
      const age = attrs.get("max-age");
      if (age && /^-?\d+$/.test(age)) expires = Number(age) <= 0 ? 0 : now + Number(age) * 1000;
      // An insecure response cannot overwrite a Secure cookie from an earlier HTTPS hop.
      if (url.protocol !== "https:" && this.cookies.some(c => c.secure && c.name === name && domainMatches(host, c.domain))) continue;
      this.cookies = this.cookies.filter(c => !(c.name === name && c.domain === domain && c.path === path));
      if (expires > now && this.cookies.length < 50) this.cookies.push({ name, value, domain, hostOnly, path, secure, expires });
    }
  }

  header(url: URL, now = Date.now()): string {
    return this.cookies.filter(c => c.expires > now && (!c.secure || url.protocol === "https:") &&
      (c.hostOnly ? c.domain === url.hostname : domainMatches(url.hostname, c.domain)) &&
      (url.pathname === c.path || (url.pathname.startsWith(c.path) && (c.path.endsWith("/") || url.pathname[c.path.length] === "/"))))
      .sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join("; ");
  }
}
