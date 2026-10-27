import { domainToASCII } from "node:url";
import { ipVersion } from "../lib/ip";
import { checkHttp, type Observed } from "./http";
import type { AddressGuard } from "./types";

/* A domain's registration expiry, read from its registry's RDAP service (`spec.md § 3.2`;
   RFC 9224 for the bootstrap, RFC 9083 for the answer). WHOIS, the spec's fallback, isn't read
   yet (`docs/BACKLOG.md`): a TLD with no RDAP service says so, and nothing guesses.

   - **Which server:** IANA's bootstrap file maps each TLD to its registry's RDAP base URL. It is
     read once and kept for a day.
   - **Which name:** an SSL monitor names a host, not a domain. The lookup asks about the host,
     then each parent in turn, and stops at the first name the registry answers with a domain
     object. It never asks about a bare TLD, and it starts at most five labels deep, which every
     registrable domain fits in, so a host a hundred labels long costs four requests, not ninety-
     nine. Registries refuse a name that isn't registered in two ways: Verisign (`.com`) answers
     404, while Public Interest Registry (`.org`) and Google (`.dev`) answer 400 for a subdomain
     (recorded 2026-10-22, `tests/fixtures/rdap/`). Both mean "not this name, try its parent";
     anything else is a failed lookup, tried again later.
   - **How fast:** one request a second to each registry server at most (`GAP_MS`, per origin,
     so a registry serving hundreds of TLDs from one host still sees one client at a walking
     pace). A 429 is the registry asking for less: the lookup comes back `busy`, nothing is
     recorded, and that server is asked nothing more until its `Retry-After` has passed, and
     nothing more in this pass whatever it said (`probe/domains.ts`).
   - **What is read:** the `expiration` event and the registrar entity's name. Some registries
     publish no expiry; that is said, not filled in.
   - **How it is fetched:** through `checkHttp`, so every request has a timeout, reads a bounded
     body, follows at most five redirects and asks the private-range guard about every address
     it connects to, as every check does (`lookup.ts`).

   Pure apart from the fetch, which is a parameter, so the tests serve recorded answers. */

export const BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 86_400_000;
/** The least time between two requests to one registry server. */
export const GAP_MS = 1000;
/** How long a bootstrap file that couldn't be read is left before it is asked for again. */
const BOOTSTRAP_RETRY_MS = 600_000;
const IANA = new URL(BOOTSTRAP_URL).origin;
/** The longest a `Retry-After` is honoured for; a registry asking for more is asked again then. */
const MAX_BACKOFF_MS = 86_400_000;
/** The deepest name the walk starts at: every registrable domain has at most this many labels. */
const MAX_LABELS = 5;
const MAX_TEXT = 200;

/** `retryAfter` is the response's `Retry-After` header, when it had one. */
export type RdapAnswer = { status: number; body: string; retryAfter?: string } | { error: string };
/** One GET, answered with the final response's status and body, or why there was none. */
export type RdapFetch = (url: string, maxBytes: number) => Promise<RdapAnswer>;

export type DomainResult =
  /** `domain` is the name the registry answered for; `expiresAt` is epoch ms, or null when the
      registry publishes no expiry. */
  | { status: "found"; domain: string; expiresAt: number | null; registrar: string | null }
  /** `domain` is the host: its TLD has no RDAP service, or no name from it up is registered. */
  | { status: "no_rdap" | "not_found"; domain: string }
  /** No definitive answer. `domain` is the name being refreshed, or the host for a walk. */
  | { status: "failed"; domain: string; error: string };

/** What a lookup can come back with: an answer to record, or `busy`: nothing could be asked now,
 *  because the registry server (`server`, its origin) asked for less (a 429) now or earlier in
 *  this pass, or IANA's list couldn't be read. A busy lookup records nothing; the host is asked
 *  again in a later pass. */
export type LookupResult = DomainResult | { status: "busy"; domain: string; server: string };

/** A `Retry-After` value in milliseconds from `now`: seconds, or an HTTP date. Null when absent
 *  or unreadable. */
export function retryAfterMs(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const v = value.trim();
  const ms = /^\d+$/.test(v) ? Number(v) * 1000 : Date.parse(v) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_BACKOFF_MS) : null;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The host as RDAP names it: lowercase ASCII (`xn--` for an internationalized name), no trailing
 *  dot, two labels or more. Null for an IP literal, a one-label name or anything else. */
export function asciiHost(host: string): string | null {
  const ascii = domainToASCII(host.trim().replace(/\.$/, "")).toLowerCase();
  if (!ascii || ascii.length > 253 || ipVersion(ascii) !== 0 || /^[\d.]+$/.test(ascii)) return null;
  const labels = ascii.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) ? ascii : null;
}

/** The names to ask about, longest first: the host, then each parent of two labels or more,
 *  starting no deeper than five labels. */
export function candidates(host: string): string[] {
  const ascii = asciiHost(host);
  if (!ascii) return [];
  const labels = ascii.split(".");
  const out: string[] = [];
  for (let i = Math.max(0, labels.length - MAX_LABELS); i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/** IANA's bootstrap file as TLD → base URL ending in `/`, preferring https. */
export function parseBootstrap(json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const services = (json as { services?: unknown })?.services;
  if (!Array.isArray(services)) throw new Error("The bootstrap file has no services");
  for (const s of services) {
    if (!Array.isArray(s) || !Array.isArray(s[0]) || !Array.isArray(s[1])) continue;
    const urls = s[1].filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
    const url = urls.find((u) => u.startsWith("https://")) ?? urls[0];
    if (!url) continue;
    for (const tld of s[0]) if (typeof tld === "string") map.set(tld.toLowerCase(), url.endsWith("/") ? url : `${url}/`);
  }
  return map;
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_TEXT);

/** The registrar's name, from the entity whose roles include `registrar`: its vCard `fn`. */
function registrarOf(entities: unknown): string | null {
  if (!Array.isArray(entities)) return null;
  for (const e of entities) {
    const roles = (e as { roles?: unknown })?.roles;
    if (!Array.isArray(roles) || !roles.includes("registrar")) continue;
    const vcard = (e as { vcardArray?: unknown }).vcardArray;
    const props = Array.isArray(vcard) && Array.isArray(vcard[1]) ? vcard[1] : [];
    for (const p of props) {
      if (Array.isArray(p) && p[0] === "fn" && typeof p[3] === "string" && p[3].trim()) return clean(p[3]);
    }
  }
  return null;
}

/** A registry's answer for `asked`, when it is a domain object for that name or one of its
 *  parents: the name, the expiration event (epoch ms) and the registrar. Null for anything else. */
export function parseDomain(json: unknown, asked: string): { domain: string; expiresAt: number | null; registrar: string | null } | null {
  const o = json as { objectClassName?: unknown; ldhName?: unknown; events?: unknown; entities?: unknown } | null;
  if (!o || typeof o !== "object" || o.objectClassName !== "domain") return null;
  const ldh = typeof o.ldhName === "string" ? o.ldhName.toLowerCase().replace(/\.$/, "") : asked;
  if (ldh !== asked && !asked.endsWith(`.${ldh}`)) return null;
  if (!asciiHost(ldh)) return null;
  let expiresAt: number | null = null;
  if (Array.isArray(o.events)) {
    for (const action of ["expiration", "registrar expiration"]) {
      const ev = o.events.find((x) => typeof x?.eventAction === "string" && x.eventAction.toLowerCase() === action);
      const t = typeof ev?.eventDate === "string" ? Date.parse(ev.eventDate) : NaN;
      if (Number.isFinite(t)) {
        expiresAt = t;
        break;
      }
    }
  }
  return { domain: ldh, expiresAt, registrar: registrarOf(o.entities) };
}

/** The production fetch: `checkHttp` with the address guard, a timeout and a bounded body. Only
 *  an https address is asked. The `accept` header rides in the check's header map, which also
 *  hides header values from snippets; an RDAP answer is public, so that costs nothing. */
export function guardedFetch(o: { allow?: AddressGuard; ca?: string | Buffer; timeoutSec?: number; allowUrl?: (url: string) => boolean } = {}): RdapFetch {
  return async (url, maxBytes) => {
    if (!url.startsWith("https://")) return { error: "Not an https address" };
    let last: Observed | undefined;
    const r = await checkHttp(
      { url, method: "GET", expect: "2xx", slowMs: Number.MAX_SAFE_INTEGER, timeoutSec: o.timeoutSec ?? 10, headers: { accept: "application/rdap+json" } },
      { allow: o.allow, ca: o.ca, allowUrl: o.allowUrl, maxBodyBytes: maxBytes, observe: (x) => { if (!x.redirect) last = x; } },
    );
    if (!last) return { error: r.failure?.message ?? "No answer" };
    const ra = last.headers["retry-after"];
    const retryAfter = Array.isArray(ra) ? ra[0] : ra;
    if (last.status === 429) return { status: 429, body: "", ...(retryAfter ? { retryAfter } : {}) };
    if (last.truncated) return { error: `The answer was over ${Math.round(maxBytes / 1024)} KB` };
    return { status: last.status, body: last.body.toString("utf8") };
  };
}

export type RdapOptions = {
  now?: () => number;
  /** How the pacing waits; tests pass one that moves their clock instead. */
  sleep?: (ms: number) => Promise<void>;
  /** The least time between two requests to one registry server (`GAP_MS`). */
  gapMs?: number;
};

export class Rdap {
  private boot: { at: number; servers: Map<string, string> } | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gapMs: number;
  /** When each registry server (an origin) may next be asked. */
  private readonly nextAt = new Map<string, number>();
  /** Until when a server that answered 429 with a `Retry-After` is left alone. */
  private readonly pausedUntil = new Map<string, number>();
  private bootFailed = { at: -Infinity, error: "" };

  constructor(
    private readonly fetch: RdapFetch,
    o: RdapOptions = {},
  ) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.gapMs = o.gapMs ?? GAP_MS;
  }

  /** Waits for `server`'s turn, then takes it. The lookups are sequential, so turns don't race. */
  private async turn(server: string): Promise<void> {
    const wait = (this.nextAt.get(server) ?? 0) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextAt.set(server, this.now() + this.gapMs);
  }

  /** TLD → RDAP base URL, from IANA's bootstrap file, read at most once a day. A read that fails
   *  keeps the copy already held, and is tried again `BOOTSTRAP_RETRY_MS` later, never on every
   *  lookup. */
  async servers(): Promise<Map<string, string>> {
    const now = this.now();
    if (this.boot && now - this.boot.at < BOOTSTRAP_TTL_MS) return this.boot.servers;
    if (now - this.bootFailed.at < BOOTSTRAP_RETRY_MS) {
      if (this.boot) return this.boot.servers;
      throw new Error(this.bootFailed.error);
    }
    try {
      const a = await this.fetch(BOOTSTRAP_URL, 1024 * 1024);
      if ("error" in a) throw new Error(a.error);
      if (a.status !== 200) throw new Error(`IANA's bootstrap file answered ${a.status}`);
      const servers = parseBootstrap(JSON.parse(a.body));
      this.boot = { at: this.now(), servers };
      return servers;
    } catch (err) {
      this.bootFailed = { at: this.now(), error: (err as Error).message };
      if (this.boot) return this.boot.servers;
      throw err;
    }
  }

  /** The registration of `host`'s domain. With `known`, the domain an earlier lookup found, that
   *  name alone is asked: once a day per domain, rather than a walk from every host on it.
   *  `busy` holds the servers that answered 429 in the caller's pass: none of them is asked
   *  again in it, and one that answers 429 now is added. */
  async lookup(host: string, known?: string, busy: Set<string> = new Set()): Promise<LookupResult> {
    const ascii = asciiHost(host);
    const subject = known ?? ascii ?? host;
    if (!ascii) return { status: "failed", domain: subject, error: "Not a domain name" };
    let servers: Map<string, string>;
    try {
      servers = await this.servers();
    } catch {
      // Nothing is known about the host: nothing to record. Asked again in a later pass.
      return { status: "busy", domain: subject, server: IANA };
    }
    const base = servers.get(ascii.slice(ascii.lastIndexOf(".") + 1));
    if (!base) return { status: "no_rdap", domain: ascii };
    let server: string;
    try {
      server = new URL(base).origin;
    } catch {
      return { status: "failed", domain: subject, error: "IANA's RDAP list names an unreadable address" };
    }
    for (const name of known ? [known] : candidates(ascii)) {
      if (busy.has(server) || (this.pausedUntil.get(server) ?? 0) > this.now()) {
        busy.add(server);
        return { status: "busy", domain: subject, server };
      }
      await this.turn(server);
      const a = await this.fetch(`${base}domain/${name}`, 256 * 1024);
      if ("error" in a) return { status: "failed", domain: subject, error: clean(a.error) };
      if (a.status === 429) {
        const wait = retryAfterMs(a.retryAfter, this.now());
        if (wait !== null) this.pausedUntil.set(server, this.now() + wait);
        busy.add(server);
        return { status: "busy", domain: subject, server };
      }
      if (a.status === 404 || a.status === 400) continue;
      if (a.status !== 200) return { status: "failed", domain: subject, error: `The registry answered ${a.status}` };
      let json: unknown;
      try {
        json = JSON.parse(a.body);
      } catch {
        return { status: "failed", domain: subject, error: "The registry's answer isn't JSON" };
      }
      const found = parseDomain(json, name);
      if (!found) return { status: "failed", domain: subject, error: "The registry's answer isn't a domain" };
      return { status: "found", ...found };
    }
    return { status: "not_found", domain: subject };
  }
}
