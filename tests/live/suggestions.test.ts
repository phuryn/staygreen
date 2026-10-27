import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSuggestions } from "@/lib/suggestion-checks";
import { BOT_PROTECTION } from "@/lib/bot-protection";
import type { Suggestions } from "@/lib/suggestions";

/* Suggested checks on real sites, by hand only (`docs/TESTS.md`, outside the gate): each site
   below was chosen from the October scan (`docs/product/research/site-scan-202610.md`) for one
   shape of app the engine has to read, and pins what it must find there. Run it after changing
   anything under `src/lib/suggestion*`, `dependency-*` or `src/checks/http.ts`:

     npm run test:live -- tests/live/suggestions.test.ts
     LIVE_REPORT=Temp/suggestions.json npm run test:live -- tests/live/suggestions.test.ts

   A failure is either the engine or the site changing: the message lists every row the run
   produced, so read it before changing either. It runs as the dashboard does, without the model
   pass, from this machine. Three sites at a time; more makes slow routes and DNS answers time out here. */

type Row = { name?: string | RegExp; url: string | RegExp; ticked?: boolean; ok?: boolean; expect?: string; reason?: RegExp | string };
type Site = { address: string; shape: string; has?: Row[]; lacks?: Row[]; tcp?: string[]; dns?: { name: string; recordName: string }[] };

const SITES: Site[] = [
  { address: "https://postmarkapp.com/", shape: "Log in leads to an app host behind AWS WAF; wildcard DNS with its own smtp. record",
    has: [{ name: "App", url: "https://account.postmarkapp.com/", ok: false, ticked: false, reason: BOT_PROTECTION }, { url: "https://account.postmarkapp.com/healthcheck", ticked: true }],
    tcp: ["smtp.postmarkapp.com:587"] },
  { address: "https://account.postmarkapp.com/", shape: "the app host itself answers an AWS WAF challenge (empty 202)",
    has: [{ url: "https://account.postmarkapp.com/", ok: false, ticked: false, reason: BOT_PROTECTION }, { url: "https://account.postmarkapp.com/healthcheck", ticked: true }],
    tcp: ["smtp.postmarkapp.com:587"] },
  { address: "https://slack.com/", shape: "an API catch-all that echoes the path and says ok:false",
    has: [{ url: "https://slack.com/healthcheck", ticked: true }, { url: "https://api.slack.com/api/health", ticked: false, reason: /health body reported/ }],
    lacks: [{ url: /^https:\/\/slack\.com\/api\// }] },
  { address: "https://zapier.com/", shape: "API host found in DNS, answering the same JSON 401 everywhere",
    has: [{ name: "API reachable", url: "https://api.zapier.com/", expect: "401", ticked: true }] },
  { address: "https://linear.app/", shape: "a GraphQL API host that greets with plain text",
    has: [{ name: "API", url: "https://api.linear.app/", ticked: true }] },
  { address: "https://apify.com/", shape: "Console link to the app host; API /ping",
    has: [{ name: "App", url: "https://console.apify.com/", ticked: true }, { url: "https://api.apify.com/ping", ticked: true }] },
  { address: "https://www.glofox.com/", shape: "health only on the API host",
    has: [{ url: "https://api.glofox.com/ping", ticked: true }] },
  { address: "https://www.tickettailor.com/", shape: "an API that answers JSON 404 at every path",
    has: [{ name: "App", url: "https://app.tickettailor.com/", ticked: true }, { name: "API reachable", url: "https://api.tickettailor.com/", expect: "404", ticked: true }] },
  { address: "https://tally.so/", shape: "Next.js-style /api/health, plus an API host",
    has: [{ url: "https://tally.so/api/health", ticked: true }, { url: "https://api.tally.so/health", ticked: true }] },
  { address: "https://plausible.io/", shape: "Phoenix /api/health",
    has: [{ url: "https://plausible.io/api/health", ticked: true }] },
  { address: "https://elevenlabs.io/", shape: "JSON health on the API host only",
    has: [{ url: "https://api.elevenlabs.io/health", ticked: true }] },
  { address: "https://atlassian.com/", shape: "health only on the final origin after the apex redirects to www",
    has: [{ url: "https://www.atlassian.com/healthz", ticked: true }] },
  { address: "https://github.com/", shape: "Rails; the API's own status route",
    has: [{ url: "https://api.github.com/status", ticked: true }] },
  { address: "https://stripe.com/", shape: "an API whose JSON 404 names the path it was asked",
    has: [{ name: "API reachable", url: "https://api.stripe.com/", expect: "404", ticked: true }],
    lacks: [{ name: "First-party dependency frontend", url: /api\.stripe\.com/ }] },
  { address: "https://resend.com/", shape: "email API: a JSON API root and SMTP",
    has: [{ name: "API", url: "https://api.resend.com/", ticked: true }], tcp: ["smtp.resend.com:587"] },
  { address: "https://loops.so/", shape: "email: SMTP behind a load balancer CNAME",
    tcp: ["smtp.loops.so:587"] },
  { address: "https://learningto.co/", shape: "a Supabase project named by the page",
    has: [{ name: "Supabase Auth", url: /\.supabase\.co\/auth\/v1\/health$/, ticked: true }, { name: "Supabase Storage", url: /\.supabase\.co\/storage\/v1\/status$/, ticked: true }] },
  { address: "https://askone.org/", shape: "Next.js with /health and Clerk on its own domain",
    has: [{ url: "https://askone.org/health", ticked: true }, { name: "Clerk frontend", url: /^https:\/\/clerk\.askone\.org\// }],
    dns: [{ name: "Clerk DNS record", recordName: "clerk.askone.org" }] },
  { address: "https://clerk.com/", shape: "Clerk's own site: Dashboard link and Clerk CNAME",
    has: [{ name: "App", url: "https://dashboard.clerk.com/" }], dns: [{ name: "Clerk DNS record", recordName: "clerk.clerk.com" }] },
  { address: "https://launchpad.37signals.com/", shape: "Rails /up, which answers HTML to a browser and text to */*",
    has: [{ url: "https://launchpad.37signals.com/up", ticked: true }] },
  { address: "https://substack.com/", shape: "/up",
    has: [{ url: "https://substack.com/up", ticked: true }] },
  { address: "https://grafana.com/", shape: "Go /healthz",
    has: [{ url: "https://grafana.com/healthz", ticked: true }] },
  { address: "https://sanity.io/", shape: "/healthz and a JSON API root",
    has: [{ url: "https://sanity.io/healthz", ticked: true }, { name: "API", url: "https://api.sanity.io/" }] },
  { address: "https://webflow.com/", shape: "/status with database JSON",
    has: [{ url: "https://webflow.com/status", ticked: true }] },
  { address: "https://cursor.com/", shape: "Next.js /api/healthz",
    has: [{ url: "https://cursor.com/api/healthz", ticked: true }] },
  { address: "https://vault.bitwarden.com/", shape: ".NET app host: /api/healthz, the API host, and the website from an app host",
    has: [{ url: "https://vault.bitwarden.com/api/healthz", ticked: true }, { url: "https://api.bitwarden.com/healthz", ticked: true }, { name: "Website", url: "https://bitwarden.com/", ticked: false }] },
  { address: "https://app.snyk.io/", shape: "Kubernetes-style probes on an app host, and its website",
    has: [{ name: "Website", url: "https://snyk.io/", ticked: false }, { url: /^https:\/\/app\.snyk\.io\/(readyz|healthcheck)$/, ticked: true }] },
  { address: "https://www.vagaro.com/", shape: "a full page that loads Imperva's script: not a wall",
    has: [{ url: "https://www.vagaro.com/", ok: true, ticked: true }] },
  { address: "https://www.schoology.com/", shape: "Imperva's small challenge shell",
    has: [{ url: "https://www.schoology.com/", ok: false, ticked: false, reason: BOT_PROTECTION }] },
  { address: "https://staygreen.io/", shape: "Next.js /health on a Clerk development instance",
    has: [{ url: "https://staygreen.io/health", ticked: true }] },
];

const fits = (want: string | RegExp | undefined, got: string | undefined) => want === undefined || (typeof want === "string" ? want === got : want.test(got ?? ""));
const matches = (s: Suggestions, r: Row) => s.http.some(h => fits(r.url, h.url) && fits(r.name, h.name) && fits(r.expect, h.expect) && fits(r.reason, h.reason) &&
  (r.ticked === undefined || h.ticked === r.ticked) && (r.ok === undefined || h.ok === r.ok));
const listed = (s: Suggestions) => [
  ...s.http.map(h => `${h.ticked ? "[x]" : "[ ]"} ${h.ok ? "ok" : "failed"} ${h.name}: ${h.url}${h.expect ? ` expect ${h.expect}` : ""}${h.reason ? ` (${h.reason})` : ""}`),
  ...(s.tcp ?? []).map(t => `tcp ${t.name}: ${t.host}:${t.port}`), ...(s.dns ?? []).map(d => `dns ${d.name}: ${d.record} ${d.recordName}`)].join("\n");

const live = process.env.LIVE_SITES === "0" ? describe.skip : describe;
const report: Record<string, unknown> = {};

live("suggested checks on real sites", () => {
  for (const site of SITES) it.concurrent(`${site.address}: ${site.shape}`, async () => {
    const started = Date.now();
    const s = await runSuggestions(site.address, 25_000, false);
    const ms = Date.now() - started;
    if (process.env.LIVE_REPORT) { report[site.address] = { ms, ...s }; writeFileSync(process.env.LIVE_REPORT, JSON.stringify(report, null, 1)); }
    expect(s?.reached, "the address answered").toBe(true);
    if (!s) return;
    const rows = `\n${listed(s)}`;
    // What holds on every site: within the test budget, nothing ticked that failed or that
    // carries a reason, no address twice, no bot wall ticked.
    expect(ms, `took ${ms} ms`).toBeLessThan(27_000);
    expect(s.http.filter(h => h.ticked && (!h.ok || h.reason)), `ticked but failing${rows}`).toEqual([]);
    expect(new Set(s.http.map(h => h.url)).size, `an address twice${rows}`).toBe(s.http.length);
    for (const r of site.has ?? []) expect(matches(s, r), `missing ${JSON.stringify(r)}${rows}`).toBe(true);
    for (const r of site.lacks ?? []) expect(matches(s, r), `unexpected ${JSON.stringify(r, (_, v) => v instanceof RegExp ? String(v) : v)}${rows}`).toBe(false);
    for (const t of site.tcp ?? []) expect((s.tcp ?? []).some(x => `${x.host}:${x.port}` === t), `missing tcp ${t}${rows}`).toBe(true);
    for (const d of site.dns ?? []) expect((s.dns ?? []).some(x => x.name === d.name && x.recordName === d.recordName), `missing dns ${d.name}${rows}`).toBe(true);
  });
});
