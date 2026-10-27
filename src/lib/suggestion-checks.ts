import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Assertion } from "@/checks/assertions";
import { checkCert } from "@/checks/cert";
import { checkHttp, type Observed } from "@/checks/http";
import { bodyText, mask } from "@/checks/mask";
import type { AddressGuard, CheckResult } from "@/checks/types";
import { accentCandidates, stylesheetHrefs } from "./brand";
import { dataUrlBytes, iconCandidates, manifestHref, manifestIcons, type ManifestIcon } from "./favicon";
import { healthJson, HEALTH_BODY_BYTES, statusAssertion } from "./health-body";
import { baseOf, inlineCss, resolvedUrl, tagsOf } from "./html-read";
import { dominantColour } from "./icon-colour";
import { monitorDefaults } from "./monitor-defaults";
import { bounded } from "./monitor-test";
import { identifyPageAsset, looksLikeSvg, PAGE_ASSET_LIMIT } from "./page-assets";
import type { SiteModel, SiteModelRun } from "./site-model";
import { applyAnswer, modelQuestion, worthAsking, type HealthBody, type SiteModelAnswer } from "./site-proposals";
import { findSupabase, isPublishableKey, mentionsSupabase, SUPABASE_NAMES, SUPABASE_PATHS, supabaseUrl, type SupabaseService } from "./supabase-detect";
import { HEALTH_PATHS, rootName, suggestionTargets, type HttpSuggestion, type SslSuggestion, type Suggestions } from "./suggestions";
import { cnameHosts, detectDependencies, registrableDomain } from "./dependency-detect";
import { checkDependencies, dependencyDns, dependencyName, type DependencyCheckResult } from "./dependency-checks";
import type { Ask } from "@/checks/dns";
import { requestLimit } from "./request-limit";
import { botProtection, checkedForBot } from "./bot-protection";
import { API_PATHS, appLink, healthFailure, hostDiscovery, jsonAnswer, jsonShape, namedApi, smtpSuggestion, versionPath, websiteSuggestion } from "./suggestion-discovery";

/* An app's address, tried once (`docs/flows.md § Suggested checks`): the address over HTTP, its
   certificate, health routes on its entry and final origins, a linked app, an API, a matching
   website and SMTP, plus its icon, brand colour, sign-in dependencies and Supabase project. The use of the
   test budget is the action's (`suggestChecks`, `actions.ts`); this module runs what that use
   pays for.

   - **The same guard as every check.** Each request goes through `src/checks/`: a private,
     loopback, link-local, CGNAT or reserved address is refused before it connects, after every
     resolution and at every redirect (`lookup.ts`). Everything the page names (its icon, its
     manifest, its stylesheets, its scripts, a Supabase project) is fetched the same way, so a page
     that names an internal address gets nothing back from it. `SuggestNetwork` exists for the
     unit suite, which serves its targets from this machine; the action passes none.
   - **Gentle with the site.** No more than `AT_ONCE` HTTP, certificate, TCP or DNS operations are open at
     a time across all hosts: the address, fifteen health routes per app origin, the manifest, at most two stylesheets, at most four
     scripts and four icons, each read once, with its own short timeout inside what the action has
     left. A health route is never followed through a redirect and reads at most 8 KB; the page
     at most 256 KB; a stylesheet 256 KB, a script 512 KB, an icon `PAGE_ASSET_LIMIT`. Scripts are
     read to find Supabase and the API host, at most four. Up to six
     sign-in dependencies are detected from the page without extra discovery fetches and checked
     once (4 s, 512 KiB). NS and same-domain CNAME baselines require both resolvers to agree.
   - **The model last, and only to choose.** With a key (`site-model.ts`) and time left, one call
     may pick among the colours the page offered and propose assertions on the health bodies;
     what it answers is checked by code (`site-proposals.ts`), and without it the result is the
     same shape, read by code alone.
   - **Nothing is written, and nothing is kept.** Bodies are read here and dropped; what returns
     is statuses, times, a certificate's expiry, reasons, assertions, a colour, a Supabase
     project's address and publishable key, and the icon. */

export type SuggestNetwork = {
  allow?: AddressGuard;
  ca?: string | Buffer;
  now?: () => number;
  certPort?: number;
  /** Where the unit suite serves a Supabase project from: the run asks this origin, at the real
   *  path, and the suggestion keeps the project's own address. */
  supabaseOrigin?: string;
  dns?: Ask;
};

export type SuggestOptions = {
  /** The model call, when there is a key; none keeps the run to what code reads. */
  model?: SiteModel | null;
  /** The plan's assertions per monitor; a suggestion carries at most this many, and at most 3. */
  maxAssertions?: number;
  /** Sees the model call's outcome, for the live script (`scripts/site-model-live.ts`). */
  onModel?: (run: SiteModelRun) => void;
};

const ROOT_TIMEOUT_SEC = 10;
const HEALTH_TIMEOUT_SEC = 6;
const CERT_TIMEOUT_SEC = 8;
const READ_TIMEOUT_SEC = 4;
const ICON_TIMEOUT_SEC = 4;
const SUPABASE_TIMEOUT_SEC = 5;
/** How many of the icons a page names are fetched, best first. `/bot` quotes it. */
export const ICON_TRIES = 4;
/** The most HTTP, TLS or DNS operations open at a time, across all hosts. `/bot` quotes it. */
export const AT_ONCE = 4;
/** What each request reads at most. `/bot` quotes those to the app's own site. */
export const PAGE_BYTES = 256 * 1024;
export const MANIFEST_BYTES = 32 * 1024;
export const STYLESHEETS = 2;
export const STYLESHEET_BYTES = 256 * 1024;
export const SCRIPTS = 4;
export const SCRIPT_BYTES = 512 * 1024;
const SUPABASE_BYTES = 4096;
/** Kept back for the model while the page is read, when there is one, so it isn't left with nothing. */
const MODEL_RESERVE_MS = 4_000;
const MODEL_TIMEOUT_MS = 5_000;
const MODEL_MIN_MS = 1_500;
const MAX_ASSERTIONS = 3;

/** The kinds of failure that mean no HTTP answer came back at all. */
const SILENT = new Set(["dns", "private", "connect", "timeout", "tls", "protocol", "redirects"]);

type Read = Pick<Observed, "url" | "status" | "headers" | "body" | "truncated" | "blockedByBot">;

export async function runSuggestions(address: string, withinMs: number, wantIcon: boolean, o: SuggestNetwork = {}, opts: SuggestOptions = {}): Promise<Suggestions | null> {
  const targets = suggestionTargets(address);
  if (!targets) return null;
  const started = Date.now();
  const left = () => withinMs - (Date.now() - started);
  const keep = opts.model ? Math.min(MODEL_RESERVE_MS, withinMs / 2) : 0;
  // A request's seconds: its own, within what is left, less what is kept for the model.
  const cap = (own: number, reserve = keep) => Math.max(0, Math.min(own, (left() - reserve) / 1000));
  const net = { allow: o.allow, ca: o.ca };
  const site = requestLimit(AT_ONCE);
  const ask = o.dns ?? dependencyDns(() => left() - keep);

  /** One GET, through the guard, as an exchange the run can read; null when it didn't answer 2xx. */
  const get = (url: string, own: number, maxBodyBytes: number, extra: { headers?: Record<string, string>; followRedirects?: boolean; keyword?: string } = {}) =>
    site(async (): Promise<{ result: DependencyCheckResult; read: Read | null }> => {
      const sec = cap(own);
      if (sec < 0.1) return { result: { ok: false, ms: 0, failure: { kind: "timeout", message: "Suggestion deadline reached" } }, read: null };
      let seen: Read | null = null;
      let entryAnswered = false;
      let blocked = false;
      const result = await bounded(
        checkHttp(
          { url, method: "GET", expect: "2xx", slowMs: monitorDefaults.slowMs.http, timeoutSec: sec, headers: extra.headers, followRedirects: extra.followRedirects, keyword: extra.keyword },
          { ...net, maxBodyBytes, observe: (x) => { blocked ||= botProtection(x); if (x.url === new URL(url).href) entryAnswered = true; if (!x.redirect) seen = { url: x.url, status: x.status, headers: x.headers, body: x.body, truncated: x.truncated, blockedByBot: x.blockedByBot }; } },
        ),
        sec,
        `No answer within ${sec} s`,
      );
      return { result: { ...checkedForBot(result, blocked), entryAnswered }, read: seen };
    });

  // ── the address itself ──
  const root = get(targets.address, ROOT_TIMEOUT_SEC, PAGE_BYTES);

  // ── health routes ──
  const healthAt = async ({ url, name }: { url: string; name: string }) => {
    const { result, read } = await get(url, HEALTH_TIMEOUT_SEC, HEALTH_BODY_BYTES, { followRedirects: false });
    // Offered only when it answers like a health route: a page in HTML at that path is a site
    // answering every path with itself, which says nothing about the app behind it.
    const type = String(read?.headers["content-type"] ?? "");
    const blocked = read && botProtection(read);
    if (!read || (!result.ok && !blocked) || (/text\/html/i.test(type) && !blocked)) return null;
    const json = healthJson(read.body, read.truncated);
    const reason = blocked ? result.failure?.message : healthFailure(json, read.body);
    const suggestion: HttpSuggestion = { kind: "http", url, name, root: false, ok: !reason, status: result.status, ms: result.ms, ticked: false, ...(reason ? { reason } : {}) };
    // Two paths with the same body are aliases; three or more are a catch-all. A router that
    // echoes the path it was asked (Slack's `"req_method":"health"`) is one too, so the echo is
    // blanked out for that count.
    const { origin, pathname } = new URL(url);
    const hash = (b: string | Buffer) => `${origin} ${createHash("sha256").update(b).digest("hex")}`;
    const segment = pathname.split("/").pop() ?? "";
    const echo = bodyText(read.body).split(pathname).join("{path}");
    return { suggestion, json, type, path: pathname, fingerprint: hash(read.body), echoless: hash(segment.length >= 3 ? echo.split(segment).join("{path}") : echo) };
  };
  type HealthRoute = NonNullable<Awaited<ReturnType<typeof healthAt>>>;
  const healthRequests = new Map<string, ReturnType<typeof healthAt>>();
  const healthOn = (address: string, paths?: readonly string[]) => {
    const all = suggestionTargets(address)?.health ?? [];
    return Promise.all(all.filter(t => t.url !== targets.address && (!paths || paths.includes(new URL(t.url).pathname))).map(t => {
      if (!healthRequests.has(t.url)) healthRequests.set(t.url, healthAt(t));
      return healthRequests.get(t.url)!;
    }));
  };
  const pruneRoutes = (found: (HealthRoute | null)[]) => {
    found = found.filter((h, i, all) => h && all.findIndex(r => r?.suggestion.url === h.suggestion.url) === i);
    const routes: HealthRoute[] = [];
    for (const h of found) {
      if (!h || found.filter(r => r?.fingerprint === h.fingerprint).length >= 3 || found.filter(r => r?.echoless === h.echoless).length >= 3 ||
        routes.some(r => r.fingerprint === h.fingerprint)) continue;
      routes.push(h);
    }
    return routes;
  };

  const cert = targets.sslHost ? site(() => cap(CERT_TIMEOUT_SEC) >= 0.1 ? certSuggestion(targets.sslHost!, cap(CERT_TIMEOUT_SEC), o) : Promise.resolve(null)) : Promise.resolve(null);

  const rootDone = await root;
  const page = rootDone.read;
  const html = page && !botProtection(page) && /html/i.test(String(page.headers["content-type"] ?? "")) ? bodyText(page.body) : "";
  const pageUrl = page?.url ?? targets.address;
  const guessedHost = hostDiscovery(registrableDomain(new URL(targets.address).hostname), ask, site, () => left() - keep);
  const tcp = guessedHost("smtp").then(host => smtpSuggestion(host, site, () => left() - keep, net));
  const apiGuess = guessedHost("api");
  const appAddress = appLink(html, pageUrl);
  const appPage = appAddress ? get(appAddress, READ_TIMEOUT_SEC, PAGE_BYTES) : Promise.resolve(null);
  const website = websiteSuggestion(html, pageUrl, get, targets.address);
  const health = Promise.all([...new Set([targets.origin, new URL(pageUrl).origin])].map(origin => healthOn(origin)));
  const reading = readPage(html, pageUrl, wantIcon, get, left, o.supabaseOrigin);
  const app = await appPage;
  const appHtml = app?.read && !botProtection(app.read) && /html/i.test(String(app.read.headers["content-type"])) ? bodyText(app.read.body) : "";
  const appUrl = app?.read?.url ?? appAddress;
  const appHealth = appAddress ? Promise.all([...new Set([new URL(appAddress).origin, new URL(appUrl!).origin])].map(origin => healthOn(origin))) : Promise.resolve([]);
  const depTargets = [...detectDependencies(html, pageUrl, page?.headers, targets.address), ...(appUrl ? detectDependencies(appHtml, appUrl, app?.read?.headers, targets.address) : [])]
    .filter((t, i, all) => t.provider !== "Supabase Auth" && all.findIndex(x => x.url === t.url) === i).slice(0, 6);
  const read = await reading;
  const apiOrigin = namedApi([targets.address, html, appHtml, ...read.scripts], targets.address, page?.headers) ??
    (app?.read ? namedApi([], targets.address, app.read.headers) : null) ?? (await apiGuess ? `https://${await apiGuess}` : null);
  const dependencies = checkDependencies(depTargets, targets.address,
    async target => (await get(target.url, READ_TIMEOUT_SEC, SCRIPT_BYTES, { keyword: target.keyword, headers: target.headers })).result,
    ask, site, () => left() - keep, cnameHosts([html, appHtml, ...read.scripts, ...Object.values(page?.headers ?? {}).flat(), ...Object.values(app?.read?.headers ?? {}).flat(), apiOrigin ?? ""].join("\n"), targets.address));
  const api = (async (): Promise<{ routes: HealthRoute[]; row: HttpSuggestion | null }> => {
    if (!apiOrigin) return { routes: [], row: null };
    const apiRoot = `${apiOrigin}/`;
    // The entry request already supplied this answer when it stayed at the API root.
    // A redirected entry cannot stand in: API fallback requires the root's own JSON status.
    const rootRead = targets.address === apiRoot && rootDone.read?.url === apiRoot
      ? Promise.resolve(rootDone) : get(apiRoot, READ_TIMEOUT_SEC, HEALTH_BODY_BYTES, { followRedirects: false });
    const [found, root] = await Promise.all([healthOn(apiOrigin, API_PATHS), rootRead]);
    const routes = pruneRoutes(found);
    const healthy = routes.find(r => r.suggestion.ok);
    if (healthy) return { routes: routes.filter(r => r === healthy || !r.suggestion.ok), row: null };
    const json = jsonAnswer(root.read);
    const reason = root.read ? healthFailure(json, root.read.body) : null;
    // A 2xx root that is JSON, or a short line of text rather than a page (Linear's "Hello from
    // the Linear GraphQL API."), is the API answering.
    const text = root.read && !root.read.truncated && root.read.body.length <= 1024 ? bodyText(root.read.body).trim() : "";
    if (root.result.ok && (json !== undefined || (text && !/<[a-z!/]/i.test(text)))) return { routes, row: { kind: "http", url: `${apiOrigin}/`, name: "API", root: false, discovered: true, ok: !reason, ticked: !reason, status: root.result.status, ms: root.result.ms, ...(reason ? { reason } : {}) } };
    if (root.read && !botProtection(root.read) && json !== undefined && [401, 404].includes(root.read.status)) {
      const random = await get(`${apiOrigin}/staygreen-${randomBytes(12).toString("hex")}`, READ_TIMEOUT_SEC, HEALTH_BODY_BYTES, { followRedirects: false });
      // The same status and JSON shape: an error may name the path it was asked (Stripe's
      // "Unrecognized request URL (GET: /…)"), so the wording can differ.
      if (random.read && !botProtection(random.read) && random.read.status === root.read.status && jsonShape(jsonAnswer(random.read)) === jsonShape(json)) {
        return { routes, row: { kind: "http", url: `${apiOrigin}/`, name: "API reachable", root: false, discovered: true, ok: true, ticked: true, expect: String(root.read.status) as "401" | "404", status: root.read.status, ms: root.result.ms, purpose: "Proves the API's gateway answers, not that the backend is healthy." } };
      }
    }
    if (root.read && botProtection(root.read)) return { routes, row: { kind: "http", url: `${apiOrigin}/`, name: "API", root: false, discovered: true, ok: false, ticked: false, reason: root.result.failure?.message, status: root.result.status } };
    return { routes, row: null };
  })();
  const [healthFound, appFound, ssl, dependencyReport, apiFound, websiteRow, tcpRows] = await Promise.all([health, appHealth, cert, dependencies, api, website, tcp]);
  const routes = pruneRoutes([...healthFound.flat(), ...appFound.flat(), ...apiFound.routes]);

  // ── the deterministic proposals, then the model's, checked ──
  const max = Math.max(0, Math.min(MAX_ASSERTIONS, opts.maxAssertions ?? MAX_ASSERTIONS));
  const bodies: HealthBody[] = routes.filter((r) => r.suggestion.ok && !versionPath(r.suggestion.url) && r.json !== undefined).map((r) => ({ url: r.suggestion.url, path: r.path, json: r.json }));
  const deterministic = {
    accent: read.accents[0]?.hex ?? null,
    assertions: new Map(routes.flatMap((r) => {
      const a = max > 0 && r.suggestion.ok && !versionPath(r.suggestion.url) ? statusAssertion(r.json, r.type) : null;
      return a ? [[r.suggestion.url, [a]] as [string, Assertion[]]] : [];
    })),
  };
  const question = modelQuestion(new URL(targets.address).host, read.accents, max > 0 ? bodies : []);
  let answer: SiteModelAnswer | null = null;
  if (opts.model && worthAsking(question) && left() >= MODEL_MIN_MS) {
    const run = await opts.model(question, Math.min(MODEL_TIMEOUT_MS, left() - 500));
    opts.onModel?.(run);
    answer = run.answer;
  }
  const proposals = applyAnswer(deterministic, question, bodies, answer, max);

  // One health route per origin is ticked: its most informative body, else its first answer.
  // Another that answered is offered unticked: a second route on one app is a second alert for
  // one outage, and on Free a fifth of what one host allows.
  const rank = (r: (typeof routes)[number]) => ((proposals.assertions.get(r.suggestion.url)?.length ?? 0) > 0 ? 2 : r.json !== undefined ? 1 : 0);
  const best = new Map<string, HealthRoute>();
  for (const r of routes.filter(r => r.suggestion.ok)) {
    const origin = new URL(r.suggestion.url).origin;
    if (!best.has(origin) || rank(r) > rank(best.get(origin)!)) best.set(origin, r);
  }
  const healthRows = routes.map((r) => {
    const assertions = proposals.assertions.get(r.suggestion.url);
    return { ...r.suggestion, ...(new URL(r.suggestion.url).origin !== targets.origin ? { discovered: true } : {}), ticked: r === best.get(new URL(r.suggestion.url).origin), ...(assertions?.length ? { assertions } : {}) };
  });

  const failedRootHealth = page && HEALTH_PATHS.some(p => new URL(targets.address).pathname === p) ? healthFailure(healthJson(page.body, page.truncated), page.body) : null;
  const rootResult = failedRootHealth && rootDone.result.ok ? { ...rootDone.result, ok: false, failure: { kind: "status" as const, message: failedRootHealth } } : rootDone.result;
  const rootSuggestion: HttpSuggestion = {
    kind: "http",
    url: targets.address,
    name: rootName(targets.address),
    root: true,
    ok: rootResult.ok,
    ...(rootResult.status ? { status: rootResult.status } : {}),
    ms: rootResult.ms,
    ...(rootResult.failure ? { reason: mask(rootResult.failure.message, []) } : {}),
    ticked: rootResult.ok,
  };
  const answered = !!rootResult.status || !!ssl || routes.length > 0 || !!websiteRow || !!apiFound.row || tcpRows.length > 0;
  const appRows: HttpSuggestion[] = app && appAddress && appAddress !== targets.address ? [{
    kind: "http", url: appAddress, name: "App", root: false, discovered: true,
    ok: app.result.ok, ticked: app.result.ok, status: app.result.status, ms: app.result.ms,
    ...(app.result.failure ? { reason: mask(app.result.failure.message, []) } : {}),
  }] : [];
  const httpRows: HttpSuggestion[] = [
    apiFound.row?.url === rootSuggestion.url ? apiFound.row : rootSuggestion,
    ...appRows, ...(websiteRow ? [websiteRow] : []), ...(apiFound.row ? [apiFound.row] : []),
    ...healthRows, ...read.supabaseRows,
    ...dependencyReport.checks.map((c): HttpSuggestion => ({
      kind: "http", url: c.url, name: dependencyName(c.provider), root: false, dependency: c.provider, keyword: c.keyword, purpose: c.purpose,
      ok: c.frontend === "ok", ticked: c.frontend === "ok", status: c.status, ms: c.ms,
      ...(c.frontend !== "ok" ? { reason: c.reason ?? "The sign-in dependency did not pass its HTTP and content check" } : {}),
    })),
  ];
  return {
    address: targets.address,
    reached: answered,
    ...(!answered && rootResult.failure && SILENT.has(rootResult.failure.kind) ? { unreached: mask(rootResult.failure.message, []) } : {}),
    http: httpRows.filter((h, i, all) => all.findIndex(x => x.url === h.url) === i),
    dns: dependencyReport.dns,
    tcp: tcpRows,
    ssl,
    icon: read.icon ? { base64: Buffer.from(read.icon).toString("base64") } : null,
    accent: proposals.accent,
    supabase: read.supabase,
  };
}

type Get = (url: string, own: number, maxBodyBytes: number, extra?: { headers?: Record<string, string>; followRedirects?: boolean }) => Promise<{ result: CheckResult; read: Read | null }>;

/** The page's own parts, read for what they say about the app. Best effort throughout: nothing
 *  here can fail the run, and a page that says nothing leaves each part empty. */
async function readPage(html: string, pageUrl: string, wantIcon: boolean, get: Get, left: () => number, supabaseOrigin?: string) {
  const base = baseOf(html, pageUrl);
  const text = async (url: string, own: number, max: number) => {
    const { result, read } = await get(url, own, max);
    return result.ok && read ? bodyText(read.body) : null;
  };

  const manifestUrl = html ? manifestHref(html, pageUrl) : null;
  const manifest = manifestUrl
    ? text(manifestUrl, READ_TIMEOUT_SEC, MANIFEST_BYTES).then((t) => {
        try {
          const j: unknown = t ? JSON.parse(t) : null;
          return j && typeof j === "object" ? (j as { theme_color?: unknown; icons?: unknown }) : null;
        } catch {
          return null;
        }
      })
    : Promise.resolve(null);
  const sheets = Promise.all(stylesheetHrefs(html, pageUrl, base).slice(0, STYLESHEETS).map((u) => text(u, READ_TIMEOUT_SEC, STYLESHEET_BYTES)));
  const scripts: string[] = [];
  const supabase = findProject(html, pageUrl, base, text, scripts).then((p) => (p ? probeSupabase(p, get, supabaseOrigin) : null));

  const m = await manifest;
  const icons = m && Array.isArray(m.icons) && manifestUrl ? manifestIcons(m.icons as ManifestIcon[], manifestUrl) : [];
  const iconBytes = wantIcon ? findIcon(html, pageUrl, icons, get, left) : Promise.resolve(null);
  const [css, project, icon] = await Promise.all([sheets, supabase, iconBytes]);

  const accents = accentCandidates({
    html,
    css: [inlineCss(html), ...css.filter((c): c is string => c !== null)],
    manifestThemeColour: typeof m?.theme_color === "string" ? m.theme_color : null,
    iconColour: icon ? dominantColour(icon) : null,
  });
  return { accents, icon, scripts, supabase: project?.project ?? null, supabaseRows: project?.rows ?? [] };
}

/** The scripts a page loads from its own origin, the app's own code first: Next.js's layout,
 *  page and app chunks and a Vite entry before shared chunks, and none of a framework's runtime. */
function scriptHrefs(html: string, pageUrl: string, base: string): string[] {
  const origin = new URL(pageUrl).origin;
  const out: string[] = [];
  const add = (href: string | undefined) => {
    const url = href ? resolvedUrl(href, base) : null;
    if (url && new URL(url).origin === origin && !out.includes(url) && !/\/(?:webpack|framework|polyfills|turbopack|react-refresh)[-.][^/]*$/.test(new URL(url).pathname)) out.push(url);
  };
  for (const a of tagsOf(html, "script")) add(a.get("src"));
  for (const a of tagsOf(html, "link")) {
    const rel = (a.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("modulepreload") || (rel.includes("preload") && a.get("as") === "script")) add(a.get("href"));
  }
  const own = (u: string) => /app\/(?:layout|page)|pages\/_app|main-app|\/index-[\w-]+\.js|\/(?:app|main|entry)[-.]/.test(u);
  return [...out.filter(own), ...out.filter((u) => !own(u))];
}

/** The Supabase project the page names, with its publishable key: in the page, else in its own
 *  scripts, two at a time in the order above. Read all four at most: a later script can
 *  name the API even when the page already named its Supabase project and key. */
async function findProject(html: string, pageUrl: string, base: string, text: (url: string, own: number, max: number) => Promise<string | null>, scriptText: string[]) {
  if (!html) return null;
  const texts = [html];
  let found = findSupabase(texts);
  const scripts = scriptHrefs(html, pageUrl, base).slice(0, SCRIPTS);
  for (let i = 0; i < scripts.length; i += 2) {
    for (const t of await Promise.all(scripts.slice(i, i + 2).map((url) => text(url, READ_TIMEOUT_SEC, SCRIPT_BYTES)))) {
      if (t) scriptText.push(t);
      if (t && mentionsSupabase(t)) texts.push(t);
    }
    found = findSupabase(texts);
  }
  return found;
}

/** The two checks a Supabase project gets, tried once: Auth health only with the publishable key,
 *  because without it the project answers 401 and writes an error into the builder's logs
 *  (`spec.md § 3.6`), and Storage status, which needs none. */
async function probeSupabase(p: { ref: string; key: string | null }, get: Get, origin?: string) {
  const key = p.key && isPublishableKey(p.key, p.ref) ? p.key : null;
  const services: SupabaseService[] = key ? ["auth", "storage"] : ["storage"];
  const rows = await Promise.all(
    services.map(async (service): Promise<HttpSuggestion> => {
      const url = supabaseUrl(p.ref, service);
      const at = origin ? `${origin}${SUPABASE_PATHS[service]}` : url;
      const { result } = await get(at, SUPABASE_TIMEOUT_SEC, SUPABASE_BYTES, service === "auth" && key ? { headers: { apikey: key } } : {});
      return {
        kind: "http",
        url,
        name: SUPABASE_NAMES[service],
        root: false,
        ok: result.ok,
        ...(result.status ? { status: result.status } : {}),
        ms: result.ms,
        // The key is masked out of anything the check says, as a monitor's own header is.
        ...(result.failure ? { reason: mask(result.failure.message, key ? [key] : []) } : {}),
        ticked: result.ok,
        supabase: service,
      };
    }),
  );
  return { project: { ref: p.ref, key }, rows };
}

/** Offered when the host answers over TLS at all: a certificate that is expired, untrusted or for
 *  another name is offered unticked with what is wrong, because watching it is how that gets
 *  noticed. A host with no TLS on 443 is offered nothing. */
async function certSuggestion(host: string, sec: number, o: SuggestNetwork): Promise<SslSuggestion | null> {
  let handshake = false;
  const r: CheckResult = await bounded(
    checkCert({ host, port: o.certPort, timeoutSec: sec }, { allow: o.allow, ca: o.ca, now: o.now, observe: () => (handshake = true) }),
    sec,
    `No TLS handshake within ${sec} s`,
  );
  if (!handshake) return null;
  const d = r.detail ?? {};
  return {
    kind: "ssl",
    host,
    ok: r.ok,
    ...(typeof d.expiresAt === "string" ? { expiresAt: d.expiresAt } : {}),
    ...(typeof d.daysLeft === "number" ? { daysLeft: d.daysLeft } : {}),
    issuer: typeof d.issuer === "string" ? d.issuer : null,
    ...(r.failure ? { reason: mask(r.failure.message, []) } : {}),
  };
}

/** The best icon the page and its manifest name, else `/favicon.ico`, fetched through the guard,
 *  at most `ICON_TRIES` of them. Only what an image's own bytes say it is comes back: a PNG,
 *  JPEG, WebP, ICO or SVG no larger than the stored image's ceiling. Best effort: nothing here
 *  can fail the run, and a page that names nothing usable leaves the app without a logo. */
async function findIcon(html: string, pageUrl: string, fromManifest: { url: string; score: number }[], get: Get, left: () => number): Promise<Uint8Array | null> {
  const candidates = iconCandidates(html, pageUrl, fromManifest).slice(0, ICON_TRIES);
  for (const url of candidates) {
    if (left() < 1500) return null;
    let bytes: Uint8Array | null = null;
    if (url.startsWith("data:")) bytes = dataUrlBytes(url, PAGE_ASSET_LIMIT);
    else {
      const { result, read } = await get(url, ICON_TIMEOUT_SEC, PAGE_ASSET_LIMIT);
      // Cut at the ceiling means larger than any image the app could store, so it isn't one.
      if (result.ok && read && !read.truncated && read.body.length) bytes = new Uint8Array(read.body);
    }
    if (bytes && (identifyPageAsset(bytes) || looksLikeSvg(bytes))) return bytes;
  }
  return null;
}
