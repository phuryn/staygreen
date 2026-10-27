import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PAYLOAD_LIMIT } from "../../ingest/src/handler";
import { fresh, needsConfirmation, step, type Located } from "../../probe/state";
import BotPage from "@/app/(public)/bot/page";
import PrivacyPage from "@/app/(public)/legal/privacy/page";
import TermsPage from "@/app/(public)/legal/terms/page";
import PricingPage from "@/app/(public)/pricing/page";
import { checkDns, RESOLVERS } from "@/checks/dns";
import { MAX_BODY_BYTES, MAX_REDIRECTS } from "@/checks/http";
import { SNIPPET_BYTES } from "@/checks/mask";
import { fail, USER_AGENT } from "@/checks/types";
import { builderOnlyLocations, checkedFromNow, every, list, locationsNow } from "@/components/landing/plan-copy";
import { built, type LaunchArea } from "@/lib/launch";
import { ADDRESS_LINE, COMPANY, DPA, FAILED_CHECKS_KEPT, REFUND_IF_CLOSED } from "@/lib/legal";
import { DNS_INTERVAL_SEC, METHODS, RESERVED_HEADERS, SSL_INTERVAL_SEC } from "@/lib/monitor-input";
import { PAGE_ASSET_LIMIT } from "@/lib/page-assets";
import { limits, locationIds, locations, type Limits, type LocationId } from "@/lib/plans";
import { snapshotDto } from "@/lib/public-page";
import { HEALTH_BODY_BYTES } from "@/lib/health-body";
import { AT_ONCE, ICON_TRIES, MANIFEST_BYTES, PAGE_BYTES, SCRIPT_BYTES, SCRIPTS, STYLESHEET_BYTES, STYLESHEETS } from "@/lib/suggestion-checks";
import { TEST_BUDGET } from "@/lib/budgets";
import { HEALTH_PATHS } from "@/lib/suggestions";
import { MAX_DEPENDENCIES } from "@/lib/dependency-detect";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE } from "@/lib/theme-cookie";
import { CONFIRM_MAX_AGE_SEC } from "@/lib/alerts/links";

/* The terms, the privacy policy and the checker's page (`/legal/terms`, `/legal/privacy`, `/bot`),
   held to the code they describe (`.claude/skills/design/references/screens.md § What a screen
   may claim`: prose is a screen too). The Terms refer plan limits to /pricing without quoting
   them; pricing and the privacy policy's storage numbers stay held to the code that enforces
   them. Where the page can only state an absence
   (no alerts, no analytics, no processor beyond the ones it names), the test fails the day the
   absence ends, so the policy is rewritten in the same change as the code. */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

// The page's own copy is real; vendor cards are verified in the browser suite.
vi.mock("@clerk/nextjs", () => ({ PricingTable: () => null, useOrganization: () => ({ isLoaded: true, organization: null }) }));

/** What a reader sees: markup stripped, the few entities React escapes put back. */
const text = (html: string) =>
  html
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|[‘’]/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

function render(page: () => ReactNode, email: string) {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", email);
  return renderToStaticMarkup(createElement(page));
}

afterEach(() => vi.unstubAllEnvs());

/** Runs with only these locations live, then puts the table back (`locations[id].live`). */
function withLive<T>(ids: readonly LocationId[], fn: () => T): T {
  const before = locationIds.map((id) => [id, locations[id].live] as const);
  for (const id of locationIds) locations[id].live = ids.includes(id);
  try {
    return fn();
  } finally {
    for (const [id, live] of before) locations[id].live = live;
  }
}

/** Renders with launch flags set, then puts them back: every page reads `isBuilt` as it renders,
    so both sides of a sentence that waits on an area are held to the code, not only today's. */
function withBuilt<T>(flags: Partial<Record<LaunchArea, boolean>>, fn: () => T): T {
  const b = built as Record<LaunchArea, boolean>;
  const before = { ...b };
  Object.assign(b, flags);
  try {
    return fn();
  } finally {
    Object.assign(b, before);
  }
}

const migrations = () => {
  const dir = join(ROOT, "supabase/migrations");
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).map((f) => readFileSync(join(dir, f), "utf8"));
};

describe("the legal pages", () => {
  for (const [name, page] of [["terms", TermsPage], ["privacy", PrivacyPage]] as const) {
    it(`${name}: names the controller as registered, and links the mailbox only when one is configured`, () => {
      const withMail = render(page, "privacy@example.com");
      expect(withMail).toContain('href="mailto:privacy@example.com"');
      const without = render(page, "");
      expect(without).not.toContain("mailto:");
      for (const html of [withMail, without]) {
        const t = text(html);
        expect(t).toContain(COMPANY.name);
        expect(t).toContain(ADDRESS_LINE);
        expect(t).toContain(`KRS ${COMPANY.krs}`);
      }
    });
  }

  // Copy names a location by its city and country, never its provider (`AGENTS.md § 2.3`): so no
  // provider's name on any of them, and no IP address but the public resolvers a DNS check asks.
  it("name no infrastructure provider and list no server address, /bot included", () => {
    const providers = [...new Set(locationIds.map((id) => locations[id].provider))];
    const resolvers = new Set<string>(RESOLVERS.map((r) => r.server));
    for (const page of [TermsPage, PrivacyPage, BotPage]) {
      const t = text(render(page, ""));
      for (const p of providers) expect(t).not.toContain(p);
      for (const ip of t.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) expect(resolvers.has(ip), ip).toBe(true);
    }
  });

  it("are linked from the public footer", () => {
    const frame = read("src/components/landing/SiteFrame.tsx");
    expect(frame).toContain('href="/legal/terms"');
    expect(frame).toContain('href="/legal/privacy"');
  });

  // A location is named where a probe checks monitors today (`locations[id].live`, read by
  // `locationsNow()`), never because of a plan or a launch flag.
  it("name exactly the locations a probe checks from, /bot included, whatever billing says", () => {
    const named = (page: () => ReactNode) => {
      const t = text(render(page, ""));
      expect(t).toContain(checkedFromNow());
      return locationIds.filter((id) => t.includes(locations[id].city));
    };
    const pages = [TermsPage, PrivacyPage, BotPage];
    for (const billing of [false, true]) {
      withBuilt({ billing }, () => {
        for (const page of pages) expect(named(page)).toEqual(locationsNow());
      });
    }
    expect(locationsNow()).toEqual(locationIds.filter((id) => locations[id].live));
    withLive(["tor1"], () => {
      for (const page of pages) expect(named(page)).toEqual(["tor1"]);
    });
    withLive(locationIds, () => {
      for (const page of pages) expect(named(page)).toEqual(locationIds);
      for (const id of builderOnlyLocations) expect(checkedFromNow()).toContain(`and from ${locations[id].city} (${locations[id].country}) on Builder`);
    });
  });

  // A Builder-only probe is handed Builder monitors alone (`eligible`); a store that reads no plan
  // loads every monitor as a Free one, so a probe there would check nothing.
  it("call no Builder-only location live while no probe there could be handed a monitor", () => {
    expect(builderOnlyLocations.length).toBeGreaterThan(0);
    expect(read("probe/schedule.ts")).toContain("return builder ? [...probes] : probes.filter((p) => !p.builderOnly);");
    if (!read("probe/store.ts").includes("builder: builders.has(r.workspace_id)")) {
      for (const id of builderOnlyLocations) expect(locations[id].live, `${id} is live, but probe/store.ts loads no Builder monitor`).toBe(false);
    }
  });

  // The heartbeat receiver ships with the checks: the monitor's page says nothing receives pings
  // while `built.probes` is false (`HeartbeatUrl.tsx`), and these pages read the same flag, so
  // what a job sends, and Cloudflare, which runs the receiver, appear the day it answers.
  it("describe what a job sends, and Cloudflare, only once something receives pings, as the monitor's page does", () => {
    expect(read("src/components/HeartbeatUrl.tsx")).toMatch(/\{!isBuilt\("probes"\) && \(\s*<p className="callout callout-warn">[\s\S]*?Nothing receives pings yet/);
    for (const probes of [false, true]) {
      withBuilt({ probes }, () => {
        const p = text(render(PrivacyPage, ""));
        const terms = text(render(TermsPage, ""));
        expect(p.includes(`cut to ${PAYLOAD_LIMIT.toLocaleString("en-US")} bytes`)).toBe(probes);
        expect(p.includes("Cloudflare: runs the address your scheduled jobs ping")).toBe(probes);
        expect(p.includes("A heartbeat's fields: the newest of each kind")).toBe(probes);
        expect(p.includes("and the heartbeat receiver connect")).toBe(probes);
        expect(p.includes("Nothing receives heartbeat pings yet, so nothing a job sends reaches Staygreen.")).toBe(!probes);
        expect(terms.includes("nothing receives heartbeat pings yet, so no heartbeat opens an incident")).toBe(!probes);
      });
    }
  });

  // A stored header is sent as stored (`checks-http.test.ts` proves it on the wire): only these
  // four are refused, and the builder's headers are spread over the check's own.
  it("say stored headers win and response cookies live only in one redirect chain", () => {
    expect([...RESERVED_HEADERS].sort()).toEqual(["connection", "content-length", "host", "transfer-encoding"]);
    expect(read("src/checks/http.ts")).toContain('accept: "*/*", ...headers,');
    const p = text(render(PrivacyPage, ""));
    expect(p).toContain("identify themselves as StaygreenBot/1.0, unless you set a User-Agent header of your own, which replaces it.");
    expect(p).toContain("Cookies set by a response are used only within that check's redirect chain");
    const bot = text(render(BotPage, ""));
    expect(bot).toContain(`carry the user agent ${USER_AGENT}, unless the user who added the address set a User-Agent header of their own, which replaces it.`);
    expect(bot).toContain("A stored header replaces StaygreenBot's own of the same name, its user agent included.");
    expect(bot).toContain("Cookies a response sets are sent back within that redirect chain only, respecting Domain, Path and Secure.");
    expect(bot).not.toContain("keeps none it is sent");
  });
});

describe("the terms", () => {
  const t = text(render(TermsPage, ""));

  it("make the refund promise in the pricing page's words", () => {
    expect(t).toContain(REFUND_IF_CLOSED);
    const promise = "You get a refund for the unused part of your plan.";
    expect(read("src/app/(public)/pricing/page.tsx")).toContain(promise);
    expect(REFUND_IF_CLOSED.toLowerCase()).toContain(promise.toLowerCase());
  });

  it("refer the customer's plan limits to /pricing without quoting any plan number", () => {
    const html = render(TermsPage, "");
    expect(t).toContain("The limits for your plan are the ones listed on the pricing page.");
    expect(html).toMatch(/The limits for your plan are the ones listed on the <a[^>]*href="\/pricing"[^>]*>pricing page<\/a>/);

    // Dates, section numbers, the registered address/identifiers, minimum age and liability
    // period aren't plan limits. Remove only those so a new capacity anywhere else fails.
    let prose = text(html.replace(/(<h2>)\d+\. /g, "$1").replace(/<p class="t-meta">[\s\S]*?<\/p>/g, ""));
    for (const fact of [ADDRESS_LINE, COMPANY.krs, COMPANY.nip, COMPANY.regon, "at least 16", "twelve-month period"]) {
      prose = prose.replaceAll(fact, "");
    }
    expect(prose).not.toMatch(/\d/);
    expect(prose).not.toMatch(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|fifty|hundred|thousand|million)[ -]+(?:apps?|monitors?|status pages?|checks?|locations?|assertions?|heartbeats?|accounts?|subscribers?|calls?|requests?|minutes?|hours?|days?|weeks?|months?|years?)\b/i);
  });

  it("keep the plan capacities on the rendered pricing page, in each plan's column", () => {
    const rows = [...render(PricingPage, "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((row) => [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/g)].map((cell) => text(cell[1]).trim()));
    const plans = [limits.free, limits.builder];
    const heartbeatRow = ["Heartbeats for crons and jobs", `${limits.free.heartbeats}, ${limits.free.heartbeatAssertions === 1 ? "one assertion" : `${limits.free.heartbeatAssertions} assertions`} each`, `${limits.builder.heartbeats}, up to ${limits.builder.heartbeatAssertions} each`];
    const monitorRows = {
      monitors: ["Monitors", ...plans.map((p) => String(p.monitors))],
      perHost: ["Monitors per host (SSL excluded)", ...plans.map((p) => String(p.perHost))],
      httpIntervalMin: ["HTTP and TCP checks", ...plans.map((p) => `every ${p.httpIntervalMin} min`)],
      assertions: ["JSON and keyword assertions per HTTP monitor", ...plans.map((p) => String(p.assertions))],
      heartbeats: heartbeatRow,
      heartbeatAssertions: heartbeatRow,
    } satisfies Partial<Record<keyof Limits, string[]>>;
    const expected = [
      ["Apps, each with its own status page", ...plans.map((p) => String(p.apps))],
      ...Object.values(monitorRows),
      ["Status pages", ...plans.map((p) => String(p.statusPages))],
      ["MCP server and REST API for your coding agent", ...plans.map((p) => `${p.apiPerMin} calls a minute`)],
      ["History", limits.free.historyLabel, limits.builder.historyLabel],
    ];
    for (const row of expected) expect(rows, row[0]).toContainEqual(row);
    const actions = read("src/app/(app)/app/actions.ts");
    const calls = [...actions.matchAll(/\.rpc\("(create_monitor|update_monitor)", \{([\s\S]*?)\n  \}\)/g)];
    expect(calls.map((c) => c[1])).toEqual(["create_monitor", "update_monitor"]);
    // Every monitor allowance sent to SQL must have its rendered cells asserted above. Follow
    // the local interval calculation too, so converting minutes to seconds can't hide it.
    const used = new Set<string>();
    for (const [, , args] of calls) {
      const interval = /const minInterval = ([^;]+);/.exec(actions)?.[1];
      expect(interval).toBeTruthy();
      for (const [, key] of args.replaceAll("minInterval", interval!).matchAll(/\bL\.(\w+)/g)) used.add(key);
    }
    expect([...used].sort()).toEqual(Object.keys(monitorRows).sort());
  });

  it("say nothing takes payment while billing isn't built, and say how it works either way", () => {
    for (const billing of [false, true]) {
      withBuilt({ billing }, () => {
        const terms = text(render(TermsPage, ""));
        const privacy = text(render(PrivacyPage, ""));
        expect(terms).toContain("billed by Clerk through Stripe");
        expect(terms.includes("It isn't on sale yet, and nothing takes payment.")).toBe(!billing);
        expect(privacy.includes("and subscription billing")).toBe(billing);
        expect(privacy.includes("once Builder is on sale")).toBe(!billing);
      });
    }
  });

  it("say what isn't running yet, read from the launch list", () => {
    expect(t.includes("Scheduled checks haven't started")).toBe(!built.probes);
    expect(t.includes("doesn't send alerts yet")).toBe(!built.alerts);
  });
});

describe("the privacy policy", () => {
  const t = text(render(PrivacyPage, ""));

  it("quotes the numbers the code enforces", () => {
    expect(t).toContain(`for an HTTP check, the status and at most ${SNIPPET_BYTES.toLocaleString("en-US")} bytes of the response, masked`);
    expect(t).toContain(`the last ${FAILED_CHECKS_KEPT} failed checks`);
    expect(t).toContain(`lasts ${THEME_COOKIE_MAX_AGE / 86_400} days`);
    expect(t).toContain(THEME_COOKIE);
    expect(t).toContain(USER_AGENT.split(" ")[0]);
    expect(t).toContain(DPA.name);
  });

  // The snippet is the HTTP check's alone, masked and capped (`mask.ts`, the column's own check).
  // A failed DNS check keeps every resolver's answers, unmasked, in `detail` and in its message,
  // which the probe stores whole (`probe/store.ts`); a certificate's keeps its expiry, issuer and
  // name. The policy says each, so a check that starts keeping something else changes it.
  it("says what a failed check keeps, kind by kind, as the checks produce it", async () => {
    const checks = readdirSync(join(ROOT, "src/checks")).filter((f) => f.endsWith(".ts") && f !== "types.ts" && f !== "mask.ts");
    expect(checks.filter((f) => /\bsnippet: /.test(read(`src/checks/${f}`)))).toEqual(["http.ts"]);
    expect(read("src/checks/cert.ts")).toMatch(/const detail = \{ daysLeft, expiresAt: [^;]*, issuer: [^;]*, subject: [^;]* \};/);
    expect(read("probe/store.ts")).toMatch(/snippet: r\.snippet \?\? null, detail: r\.detail \?\? null/);

    const answer = "v=DMARC1; p=none; rua=mailto:dmarc@example.com";
    const r = await checkDns({ record: "TXT", name: "_dmarc.example.com", expected: "p=reject" }, async () => [answer]);
    expect(r.ok).toBe(false);
    expect(r.detail).toEqual({ resolvers: RESOLVERS.map((x) => ({ resolver: x.id, answers: [answer], matches: false })) });
    expect(r.failure?.message).toContain(answer);
    expect(r.snippet).toBeUndefined();
    expect(t).toContain("for a certificate, its expiry, issuer and name; for a DNS record, every answer each resolver returned, in full and not masked, since those are public DNS records.");
    expect(t).toContain("why it failed (for a DNS record, with the answers a resolver returned)");
    expect(t).toContain("DNS answers aren't masked.");
  });

  // The public view is an allowlist (`public-page.ts`): these keys reach a visitor and no others.
  // The one address on it is the homepage, which a new page takes from its app.
  it("says what a status page shows: the homepage link a new page takes from its app, and no monitor's settings", () => {
    expect(read("src/app/(app)/app/actions.ts")).toMatch(/p_homepage: app\.url,/);
    expect(read("src/components/status/StatusPageView.tsx")).toContain("href={page.homepage}");
    expect(Object.keys(snapshotDto.shape.page.shape).sort()).toEqual(["accent", "faviconUrl", "historyDays", "homepage", "logoText", "logoUrl", "name", "noindex", "poweredBy", "slug", "theme"]);
    expect(Object.keys(snapshotDto.shape.components.element.shape).sort()).toEqual(["daily", "inApp", "key", "name", "states"]);
    expect(Object.keys(snapshotDto.shape.incidents.element.shape).sort()).toEqual(["components", "id", "notes", "openedAt", "resolvedAt", "severity", "title"]);
    expect(t).toContain("The page shows its name and logo, a link to the homepage the builder sets, its components with their state and daily uptime");
    expect(t).toContain("A new page starts with its app's address as that homepage, which is often an address one of its monitors checks. Otherwise it shows no monitor's address, settings or headers, and no unpublished update.");
    expect(t).toContain("a homepage link (at first, the app's address)");
    expect(text(render(TermsPage, ""))).toContain("its name and logo, a link to the homepage you set (at first, your app's address), the components");
  });

  it("keeps the same number of failed checks the database prunes to", () => {
    const prunes = migrations()
      .flatMap((sql) => [...sql.matchAll(/from public\.check_failures where monitor_id = p_id order by at desc, id desc limit (\d+)/g)].map((m) => Number(m[1])));
    expect(prunes.length).toBeGreaterThan(0);
    for (const n of prunes) expect(n).toBe(FAILED_CHECKS_KEPT);
  });

  it("names the cookie the code sets, and the code sets it under the shared name", () => {
    expect(read("src/components/theme.ts")).toContain("${THEME_COOKIE}=");
    expect(read("src/app/layout.tsx")).toContain(".get(THEME_COOKIE)");
    for (const path of ["src/components/theme.ts", "src/app/layout.tsx"]) expect(read(path), path).not.toContain('"sg-theme"');
  });

  it("says scheduled checks haven't started exactly while the probes aren't built", () => {
    expect(t.includes("Scheduled checks haven't started")).toBe(!built.probes);
  });

  // The policy says these hold no data because they don't exist: no subscribers, no API tokens
  // or activity log, no scan, no widget, no custom domains, no Stripe or Supabase keys. The day
  // one ships, its data needs a paragraph here, the processors list may grow, and this test is
  // updated with the policy. Alerts left this list with stage 2.3, described below.
  it("describes no area as running that isn't built", () => {
    const undescribed: LaunchArea[] = ["subscribers", "mcp"];
    for (const area of undescribed) {
      expect(built[area], `${area} is built: describe what it stores and who processes it in /legal/privacy (and /legal/terms), then update this test`).toBe(false);
    }
    expect(t).toContain("Custom domains");
    expect(t).toContain("certificate transparency logs");
    expect(t).toContain("Staygreen doesn't keep subscriber lists yet");
    expect(t).toContain("Stripe and Supabase monitors store your supplied key encrypted");
    expect(t).toContain("discards their customer data");
    expect(built.agentMcp).toBe(true);
    expect(t).toContain("store no OAuth access or refresh tokens");
    expect(t).toContain("Revocation leaves a tombstone");
    expect(t).toContain("including refused calls");
  });

  // Alerts are built (stage 2.3): who gets them, what is stored about them and who carries them.
  it("describes alerts as they run: recipients, what is kept, the confirmation, and both carriers", () => {
    expect(built.alerts).toBe(true);
    expect(t).not.toContain("doesn't send alerts");
    expect(t).toContain("Alert recipients");
    expect(t).toContain("never their address");
    expect(t).toContain(`not confirmed within ${CONFIRM_MAX_AGE_SEC / 86_400} days`);
    expect(t).toContain("Postmark: sends alert email");
    expect(t).toContain("Open and link tracking are off");
    expect(t).toContain("Telegram: delivers alerts");
    expect(t).toContain("/stop");
    // The tracking claim is the sender's own setting.
    const postmark = read("src/lib/alerts/postmark.ts");
    expect(postmark).toContain("TrackOpens: false");
    expect(postmark).toContain('TrackLinks: "None"');
  });

  // A third party reached from the code is a processor the policy must name: Postmark and Telegram
  // carry alerts (stage 2.3); Staygreen loads no analytics.
  it("names every third party the code talks to", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const path = `${dir}/${name}`;
        if (name === "node_modules" || name === "dist") continue;
        if (statSync(join(ROOT, path)).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs|js)$/.test(name)) files.push(path);
      }
    };
    for (const dir of ["src", "probe", "ingest/src"]) walk(dir);
    const third = [
      { name: "Anthropic", uses: /@anthropic-ai\/|api\.anthropic\.com|ANTHROPIC_API_KEY/ },
      { name: "OpenAI", uses: /from ["']openai["']|api\.openai\.com|openrouter\.ai/ },
      { name: "Resend", uses: /from ["']resend["']|api\.resend\.com/ },
      { name: "Postmark", uses: /postmark/i },
      { name: "Microsoft Clarity", uses: /clarity\.ms|window\.clarity/ },
      { name: "Sentry", uses: /from ["']@sentry\// },
      { name: "Telegram", uses: /api\.telegram\.org/ },
      { name: "Slack", uses: /hooks\.slack\.com|slack\.com\/api/ },
    ];
    expect(files.length).toBeGreaterThan(50);
    const sources = files.map(path => ({ path, text: read(path) }));
    for (const { name, uses } of third) {
      const using = sources.filter(f => uses.test(f.text)).map(f => f.path);
      if (using.length) expect(t, `${using.join(", ")} reach ${name}; name it in /legal/privacy`).toContain(name);
    }
    expect(t).toContain("Staygreen runs no analytics");
  });
});

describe("the kit's long-document modifier", () => {
  const kit = read("design/kit.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string) => kit.split("}").find((b) => b.split("{")[0].trim() === selector)?.split("{")[1] ?? "";

  it("puts back the bullets the reset takes, as the dashboard's bullet list does", () => {
    expect(rule(".prose-doc ul")).toMatch(/list-style:\s*disc/);
    const pad = /padding-left:\s*([^;]+);/;
    expect(rule(".prose-doc ul").match(pad)?.[1]).toBe(read("src/styles/pages-b.css").match(/\.pb-bullets \{[^}]*padding-left:\s*([^;]+);/)?.[1]);
  });

  it("underlines links at rest, because cobalt alone isn't told from body text", () => {
    expect(rule(".prose-doc a")).toMatch(/text-decoration:\s*underline/);
  });
});

describe("the StaygreenBot page", () => {
  const t = text(render(BotPage, ""));

  it("is where the checks' user agent points", () => {
    const url = /\(\+(https:\/\/[^)\s]+)\)/.exec(USER_AGENT)?.[1];
    expect(url, USER_AGENT).toBeTruthy();
    const { hostname, pathname } = new URL(url!);
    expect(hostname).toBe("staygreen.io");
    // Every page.tsx under src/app, as the path it serves: a route group `(…)` adds no segment.
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const path = `${dir}/${name}`;
        if (statSync(join(ROOT, path)).isDirectory()) walk(path);
        else if (name === "page.tsx") routes.push("/" + dir.split("/").slice(2).filter((s) => !/^\(.*\)$/.test(s)).join("/"));
      }
    };
    walk("src/app");
    expect(routes).toContain("/legal/privacy");
    expect(routes, `${pathname} is in USER_AGENT and no page serves it`).toContain(pathname);
    expect(t).toContain(USER_AGENT);
    expect(read("src/checks/http.ts")).toContain('"user-agent": USER_AGENT');
  });

  it("says what a check sends, from the checks' own limits", () => {
    expect(t).toContain(`the method they chose (${list(METHODS)})`);
    expect(t).toContain(`follows at most ${MAX_REDIRECTS} redirects`);
    expect(t).toContain(`reads at most the first ${MAX_BODY_BYTES / 1024} KB of a response`);
    for (const r of RESOLVERS) expect(t).toContain(`(${r.server})`);
    expect(t).toContain(list(HEALTH_PATHS));
    expect(t).toContain(`the address, following at most ${MAX_REDIRECTS} redirects and reading at most ${PAGE_BYTES / 1024} KB`);
    expect(t).toContain(`without following redirects, reading at most ${HEALTH_BODY_BYTES / 1024} KB of each`);
    expect(t).toContain(`the web app manifest its page names (at most ${MANIFEST_BYTES / 1024} KB), at most ${STYLESHEETS} of its stylesheets on the same site (${STYLESHEET_BYTES / 1024} KB each) and at most ${SCRIPTS} of its scripts on the same origin (${SCRIPT_BYTES / 1024} KB each)`);
    expect(t).toContain(`at most ${ICON_TRIES} of the icons its page or manifest names (or /favicon.ico), which may be on another host, reading at most ${PAGE_ASSET_LIMIT / 1024} KB of each`);
    expect(t).toContain(`At most ${AT_ONCE} of these are open to the app's site at a time`);
    expect(t).toContain(`It also checks up to ${MAX_DEPENDENCIES} sign-in frontends named by the page (4 s and ${SCRIPT_BYTES / 1024} KB each)`);
    expect(t).toContain("the app domain's nameservers and first-party sign-in CNAMEs");
    expect(t).toContain("The same limit covers all hosts and DNS reads");
    expect(t).toContain(`at most ${TEST_BUDGET.member.limit} times in ${TEST_BUDGET.member.windowSec / 60} minutes for one user and ${TEST_BUDGET.workspace.limit} an hour for a workspace`);
    // Every read the suggestions make names one of the limits above (Supabase's own two answers
    // aside, which aren't the app's site), so a new read can't go unsaid.
    const reads = [...read("src/lib/suggestion-checks.ts").matchAll(/(?<![w.])(?:get|text)\([^,()]+,\s*\w+,\s*(\w+)/g)].map((m) => m[1]);
    expect([...new Set(reads)].sort()).toEqual(["HEALTH_BODY_BYTES", "MANIFEST_BYTES", "PAGE_ASSET_LIMIT", "PAGE_BYTES", "SCRIPT_BYTES", "STYLESHEET_BYTES", "SUPABASE_BYTES", "max"]);
  });

  // What a failure takes before it counts is the probe's (`needsConfirmation`, `step`, and the
  // pause before a probe with no live peer looks again itself, in `probe/runtime.ts`).
  it("says what a failed check takes before it counts, as the probe decides", () => {
    const failed = (kind: Parameters<typeof fail>[1]): Located => ({ ...fail(1, kind, "x"), location: "tor1" });
    expect(needsConfirmation("http", failed("status"))).toBe(true);
    expect(needsConfirmation("tcp", failed("connect"))).toBe(true);
    expect(needsConfirmation("ssl", failed("timeout"))).toBe(true);
    expect(needsConfirmation("ssl", failed("cert"))).toBe(false);
    expect(needsConfirmation("dns", failed("mismatch"))).toBe(false);
    expect(step("ssl", fresh("up"), { first: failed("cert") }).next.state).toBe("down");
    let s = fresh("up");
    let dnsChecks = 0;
    while (s.state !== "down" && dnsChecks < 10) {
      s = step("dns", s, { first: failed("mismatch") }).next;
      dnsChecks++;
    }
    expect(s.state).toBe("down");
    const recheck = /recheckAfterSec \?\? (\d+)\) \* 1000/.exec(read("probe/runtime.ts"))?.[1];
    expect(recheck).toBeTruthy();
    expect(t).toContain(`An HTTP or TCP check that fails, or a certificate that can't be reached, is made again at once from another of them, or about ${recheck} seconds later from the same server when no other is running, and only a second failure counts.`);
    expect(t).toContain(`A certificate that is invalid counts at once, and a DNS record counts once ${dnsChecks} checks in a row fail`);
    expect(t).toContain("A failed HTTP or TCP check, or a certificate that couldn't be reached, adds one more.");
    expect(t).not.toContain("second location");
  });

  it("says where checks come from and how often, from the plan module", () => {
    expect(t).toContain(`Scheduled checks come from servers in ${checkedFromNow()}.`);
    expect(t).toContain(`HTTP and TCP ${every(limits.free.httpIntervalMin)} on the Free plan and ${every(limits.builder.httpIntervalMin)} on Builder`);
    expect(t).toContain(`certificates every ${SSL_INTERVAL_SEC / 3600} hours`);
    expect(t).toContain(`DNS records every ${DNS_INTERVAL_SEC / 60} minutes`);
    expect(t).toContain(`at most ${limits.free.perHost} monitors on one host`);
    expect(t.includes("Scheduled checks haven't started")).toBe(!built.probes);
  });

  it("quotes the schedules the database holds certificates and DNS records to", () => {
    const sql = migrations().join("\n");
    const ssl = [...sql.matchAll(/type = 'ssl' and p_interval_sec <> (\d+)/g)].map((m) => Number(m[1]));
    const dns = [...sql.matchAll(/type = 'dns' and p_interval_sec < (\d+)/g)].map((m) => Number(m[1]));
    expect(ssl.length).toBeGreaterThan(0);
    expect(dns.length).toBeGreaterThan(0);
    for (const n of ssl) expect(n).toBe(SSL_INTERVAL_SEC);
    for (const n of dns) expect(n).toBe(DNS_INTERVAL_SEC);
  });

  it("asks someone who didn't want the checks to write in, at the mailbox or the registered address", () => {
    expect(t).toContain(`write to ${COMPANY.name}, ${ADDRESS_LINE} with the address, and the checks against it are stopped.`);
    expect(t).not.toContain("mailto:");
    const withMail = render(BotPage, "privacy@example.com");
    expect(withMail).toContain('href="mailto:privacy@example.com"');
    expect(text(withMail)).toContain("write to privacy@example.com with the address, and the checks against it are stopped.");
  });
});
