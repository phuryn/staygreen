import type { Assertion } from "@/checks/assertions";
import { defaultName } from "./monitor-input";
import type { SupabaseService } from "./supabase-detect";
import type { DependencyProvider } from "./dependency-detect";
import type { DnsSuggestion } from "./dependency-checks";

/* The checks Staygreen suggests for an app's address (`docs/flows.md § Suggested checks`): an HTTP
   check on the address, its SSL and domain check, any common health route that answers, with an
   assertion on what its body says, and a Supabase project's Auth and Storage when the page uses
   one. The server tries each once, through the probes' own code and guard
   (`suggestion-checks.ts`); this module is what both sides agree on, the browser included: which
   addresses are tried, what each is called, and when the SSL check comes free with an HTTPS
   check.

   Pure and browser-safe. */

/** A short fixed list, each fetched once, no more than four at a time with the run's other
 *  requests to the site: the routes coding agents and frameworks write. `/health`, `/healthz`
 *  and `/api/health(z)` are what agents and Node, Go and Next.js examples use; `/status` is the
 *  older convention; `/up` is the route Rails (7.1+) and Laravel (11+) generate in every new app;
 *  `/readyz` and `/livez` are the Kubernetes probes' names, readiness first because it is the one
 *  that says the app can serve; `/actuator/health` is Spring Boot's, on by default wherever its
 *  actuator is. Ordered by how likely each is on an app a coding agent built, which is also the
 *  order a tie is broken in when more than one answers. */
export const HEALTH_PATHS = ["/health", "/healthz", "/api/health", "/api/healthz", "/status", "/up", "/readyz", "/livez", "/actuator/health", "/ping", "/healthcheck", "/version", "/_health", "/api/status", "/api/version"] as const;

const HEALTH_NAMES: Record<(typeof HEALTH_PATHS)[number], string> = {
  "/health": "Health check",
  "/healthz": "Health check (healthz)",
  "/api/health": "API health",
  "/api/healthz": "API health (healthz)",
  "/status": "Status endpoint",
  "/up": "Health check (up)",
  "/readyz": "Readiness check",
  "/livez": "Liveness check",
  "/actuator/health": "Spring Boot health",
  "/ping": "Ping",
  "/healthcheck": "Health check (healthcheck)",
  "/version": "Version endpoint",
  "/_health": "Health check (_health)",
  "/api/status": "API status",
  "/api/version": "API version",
};

export type HttpSuggestion = {
  kind: "http";
  url: string;
  name: string;
  /** The address itself, rather than a health route on its site. */
  root: boolean;
  ok: boolean;
  status?: number;
  ms?: number;
  /** Why it isn't ticked: what the check found, in its own words. */
  reason?: string;
  /** A monitor of this workspace already checks this exact address. */
  watched?: boolean;
  /** Ticked when the step opens: what answered, except a second health route when one is enough. */
  ticked: boolean;
  /** Assertions on the body the run just read, each passing on it (`health-body.ts`). */
  assertions?: Assertion[];
  /** One of a Supabase project's two checks (`supabase-detect.ts`), on its own host. */
  supabase?: SupabaseService;
  dependency?: DependencyProvider;
  keyword?: string;
  purpose?: string;
  /** A discovered app/website/API address; these carry their full host in the screen. */
  discovered?: boolean;
  expect?: "401" | "404";
};

export type TcpSuggestion = { kind: "tcp"; host: string; port: number; tls: boolean; name: string; ms: number; watched?: boolean };

export type SslSuggestion = {
  kind: "ssl";
  host: string;
  ok: boolean;
  expiresAt?: string;
  daysLeft?: number;
  issuer?: string | null;
  reason?: string;
  /** An SSL monitor of this workspace already watches this host. */
  watched?: boolean;
};

export type Suggestions = {
  address: string;
  /** Anything answered: the address over HTTP, its certificate, or a health route. */
  reached: boolean;
  /** What the address itself did, when it didn't answer at all. */
  unreached?: string;
  http: HttpSuggestion[];
  dns?: DnsSuggestion[];
  tcp?: TcpSuggestion[];
  /** Absent when the host doesn't answer over TLS, or the address can't carry an SSL check. */
  ssl: SslSuggestion | null;
  /** The site's own icon, for the app's logo, when it had none. The browser resizes it as it
   *  resizes any image a builder chooses (`page-asset-prepare.ts`), and the server checks it again. */
  icon: { base64: string } | null;
  /** The site's brand colour, for the accent of the app's next status page (`brand.ts`). */
  accent: string | null;
  /** The Supabase project the page uses, and its publishable key when the page carries it: the
   *  key goes back with the Auth check if it is ticked, and is never shown. */
  supabase: { ref: string; key: string | null } | null;
};

export type Targets = { address: string; origin: string; health: { url: string; name: string }[]; sslHost: string | null };

/** What is tried for an address: the address itself, each health route on its origin, and the
 *  host's certificate when an SSL monitor could watch it. An SSL monitor watches a name on port
 *  443, so an IP address or an address with its own port gets none, as `create_monitor` adds none
 *  for them (004). Null for anything but an http or https address. */
export function suggestionTargets(address: string): Targets | null {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  const named = !/^[0-9.]+$/.test(host) && !host.startsWith("[");
  return {
    address: u.href,
    origin: u.origin,
    health: HEALTH_PATHS.filter((p) => `${u.origin}${p}` !== u.href.replace(/\/$/, "")).map((p) => ({ url: `${u.origin}${p}`, name: HEALTH_NAMES[p] })),
    sslHost: named && u.port === "" ? host : null,
  };
}

export const rootName = (address: string) => defaultName(address);

/** Whether an HTTPS check among `urls` brings the host's SSL monitor with it, free, as adding one
 *  does today (`create_monitor`): https, the same named host, no port of its own. */
export function sslComesWith(urls: readonly string[], sslHost: string | null): boolean {
  if (!sslHost) return false;
  return urls.some((url) => {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && u.port === "" && u.hostname.replace(/\.$/, "").toLowerCase() === sslHost;
    } catch {
      return false;
    }
  });
}

/** What a builder ticked, as `addSuggestedChecks` takes it: the addresses, the SSL check, the
 *  assertions each address carries, and the Supabase key the Auth check sends. */
export type Picks = { urls: string[]; ssl: boolean; assertions?: Record<string, Assertion[]>; supabaseKey?: string;
  dependencies?: { url: string; name: string; keyword: string }[];
  http?: { url: string; name: string; expect?: "401" | "404" }[];
  tcp?: Pick<TcpSuggestion, "host" | "port" | "tls">[];
  dns?: Pick<DnsSuggestion, "record" | "recordName" | "expected" | "name">[];
};
