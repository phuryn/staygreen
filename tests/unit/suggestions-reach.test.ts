import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runSuggestions } from "@/lib/suggestion-checks";
import { runTest } from "@/lib/monitor-test";
import { parseMonitorDraft } from "@/lib/monitor-input";
import { appLink, namedApi, sameBrand } from "@/lib/suggestion-discovery";
import { BOT_PROTECTION } from "@/lib/bot-protection";
import { cnameVendor } from "@/lib/dependency-checks";
import { detectDependencies } from "@/lib/dependency-detect";
import fixtures from "../fixtures/suggestions/responses.json";
import type { Ask } from "@/checks/dns";

const tcp = vi.hoisted(() => vi.fn(async () => ({ ok: true, ms: 2 })));
vi.mock("@/checks/cert", () => ({ checkCert: vi.fn(async () => ({ ok: true, ms: 1 })) }));
vi.mock("@/checks/tcp", () => ({ checkTcp: tcp }));
type Answer = { status?: number; body?: string; headers?: Record<string, string | string[]> };
const json = (v: unknown, status = 200): Answer => ({ status, body: JSON.stringify(v), headers: { "content-type": "application/json" } });
const html = (body: string): Answer => ({ status: 200, body, headers: { "content-type": "text/html" } });
const root = "https://example.com/";
const routes = new Map<string, Answer>();
let requested: string[] = [];
const noDns = vi.fn(async () => [] as string[]);
function transport(delay = 0) {
  let open = 0, max = 0;
  const request = ((url: URL) => {
    requested.push(url.href); max = Math.max(max, ++open);
    const a = routes.get(url.href) ?? (url.hostname === "api.example.com" && url.pathname.startsWith("/staygreen-") ? routes.get("random") : undefined) ?? { status: 404 };
    const req = new EventEmitter();
    const response = () => { open--; req.emit("response", Object.assign(Readable.from([Buffer.from(a.body ?? "")]), { statusCode: a.status ?? 200, headers: a.headers ?? {} })); };
    return Object.assign(req, { end() { if (delay) setTimeout(response, delay); else response(); }, destroy() { req.emit("error", Error("closed")); } });
  }) as typeof http.request;
  vi.spyOn(http, "request").mockImplementation(request); vi.spyOn(https, "request").mockImplementation(request);
  return () => ({ open, max });
}
const run = (address = root, dns: Ask = noDns) => runSuggestions(address, 25000, false, { dns });
beforeEach(() => { routes.clear(); requested = []; noDns.mockClear(); tcp.mockReset(); tcp.mockResolvedValue({ ok: true, ms: 2 }); routes.set(root, html("<title>Example</title>")); });
afterEach(() => vi.restoreAllMocks());

it.each([fixtures.awsWall, { status: 202, body: "" }, fixtures.impervaWall, { status: 200, headers: { "x-amzn-waf-action": "anything" }, body: "app" }])("offers bot protection unticked, and the add form's Test reports the same reason", async wall => {
  routes.set(root, wall); transport();
  const s = await run();
  expect(s?.http[0]).toMatchObject({ ok: false, ticked: false, reason: BOT_PROTECTION });
  const parsed = parseMonitorDraft({ type: "http", appId: "app_" + "a".repeat(24), name: "Site", url: root, method: "GET", expect: "2xx", keyword: "", slowMs: 5000, assertions: [], headers: [] });
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(await runTest(parsed.row, {}, 25000)).toMatchObject({ ok: false, failure: { message: BOT_PROTECTION } });
});
it("does not mistake Imperva's script on a full page for its tiny shell", async () => {
  routes.set(root, html("<script src='/_Incapsula_Resource'></script>" + "A real app ".repeat(200))); transport();
  expect((await run())?.http[0]).toMatchObject({ ok: true, ticked: true });
});
it("detects a challenge before a response cookie masks its marker", async () => {
  routes.set(root, { ...fixtures.impervaWall, headers: { ...fixtures.impervaWall.headers, "set-cookie": ["marker=_Incapsula_Resource"] } }); transport();
  expect((await run())?.http[0]).toMatchObject({ ok: false, ticked: false, reason: BOT_PROTECTION });
});
it("never ticks a dependency or health route that is a bot wall", async () => {
  routes.set(root, html('<script src="https://auth.example.com/script.js"></script>'));
  routes.set("https://auth.example.com/script.js", fixtures.awsWall);
  routes.set(root + "health", fixtures.impervaWall); transport();
  const s = await run();
  expect(s?.http.filter(h => !h.root)).toHaveLength(2);
  expect(s?.http.filter(h => !h.root).every(h => !h.ok && !h.ticked && h.reason === BOT_PROTECTION)).toBe(true);
});
it("probes the final origin too, deduplicating shared final/app origins and never following health redirects", async () => {
  routes.set(root, { status: 302, headers: { location: "https://www.example.com/" } });
  routes.set("https://www.example.com/", html('<a href="https://app.example.com/login">Log in</a>'));
  routes.set("https://app.example.com/", { status: 302, headers: { location: "https://www.example.com/" } });
  routes.set("https://www.example.com/health", json({ ok: true }));
  routes.set(root + "healthz", { status: 302, headers: { location: "https://unrelated.test/not-health" } }); transport();
  const s = await run();
  expect(s?.http.find(h => h.url === "https://www.example.com/health")).toMatchObject({ ok: true, ticked: true });
  expect(requested.filter(u => u === "https://www.example.com/health")).toHaveLength(1);
  expect(requested).not.toContain("https://unrelated.test/not-health");
});
it("rejects a repeated router body at three paths but keeps two aliases as one", async () => {
  for (const p of ["health", "healthz", "ping"]) routes.set(root + p, json({ ok: true }));
  for (const p of ["status", "_health"]) routes.set(root + p, json({ status: "up" })); transport();
  const s = await run();
  expect(s?.http.filter(h => !h.root).map(h => h.url)).toEqual([root + "status"]);
});
it.each([fixtures.slackHealth, fixtures.frontHealth, ...["error", "fail", "down", "unhealthy"].map(status => json({ status }))])("never ticks a failed health body or asks the model to assert it", async response => {
  routes.set(root + "api/health", response); transport();
  const s = await run();
  expect(s?.http[1]).toMatchObject({ ticked: false, ok: false });
  expect(s?.http[1].reason).toMatch(/health body reported/);
  expect(s?.http[1].assertions).toBeUndefined();
});
it("tries all six added paths and prevents even model assertions on version bodies", async () => {
  routes.set(root + "version", json({ status: "ok", version: "v1" }));
  routes.set(root + "api/version", json({ ok: true, version: "v2" })); transport();
  const model = vi.fn(async () => ({ answer: null, outcome: "skipped" as const, ms: 0 }));
  const s = await runSuggestions(root, 25000, false, { dns: noDns }, { model: model as never });
  for (const path of ["ping", "healthcheck", "version", "_health", "api/status", "api/version"]) expect(requested).toContain(root + path);
  expect(s?.http.filter(h => !h.root).every(h => !h.assertions)).toBe(true); expect(model).not.toHaveBeenCalled();
});
it("discovers an API from CSP punctuation, prefers health, and uses no sign-in label", async () => {
  routes.set(root, { ...html(""), headers: { "content-type": "text/html", "content-security-policy": "connect-src https://api.example.com/v1,;" } });
  routes.set("https://api.example.com/health", json({ ok: true })); routes.set("https://api.example.com/", fixtures.gateway); transport();
  const s = await run();
  expect(s?.http.find(h => h.url === "https://api.example.com/health")).toMatchObject({ ok: true, ticked: true });
  expect(s?.http.some(h => h.dependency === "First-party dependency")).toBe(false);
  expect(requested.some(u => u.includes(",") || u.includes(";"))).toBe(false);
});
it.each([401, 404])("uses a matching JSON %i at root and a random path for API reachable", async status => {
  routes.set(root, html('<script>fetch("https://api.example.com/v1")</script>'));
  routes.set("https://api.example.com/", json({ error: "unauthorized" }, status)); routes.set("random", json({ error: "unauthorized" }, status)); transport();
  const s = await run();
  expect(s?.http.find(h => h.name === "API reachable")).toMatchObject({ expect: String(status), ticked: true, purpose: expect.stringContaining("gateway answers, not") });
});
it("keeps API reachable's expected status when the supplied address is the API itself", async () => {
  routes.set("https://api.example.com/", fixtures.gateway); routes.set("random", fixtures.gateway); transport();
  const dns: Ask = async () => ["93.184.216.34"]; // Explicit API evidence survives wildcard DNS.
  const s = await run("https://api.example.com/", dns);
  expect(s?.http.filter(h => h.url === "https://api.example.com/")).toEqual([expect.objectContaining({ name: "API reachable", expect: "401", ticked: true })]);
  expect(requested.filter(u => u === "https://api.example.com/")).toHaveLength(1);
});
it("does not reintroduce an API health catch-all through its shorter health list", async () => {
  routes.set("https://api.example.com/", json({ version: "1" }));
  for (const path of ["health", "healthcheck", "readyz"]) routes.set(`https://api.example.com/${path}`, json({ ok: true }));
  transport();
  expect((await run("https://api.example.com/"))?.http.some(h => new URL(h.url).pathname === "/health")).toBe(false);
});
it("rejects inconsistent and non-JSON API errors, but offers a 2xx JSON or plain-text root", async () => {
  routes.set(root, html('<script>fetch("https://api.example.com/v1")</script>')); transport();
  // Stripe names the path it was asked, so only the status and the JSON's shape must agree.
  routes.set("https://api.example.com/", json({ error: { message: "Unrecognized request URL (GET: /)" } }, 404)); routes.set("random", json({ error: { message: "Unrecognized request URL (GET: /staygreen-x)" } }, 404));
  expect((await run())?.http.find(h => h.name === "API reachable")).toMatchObject({ expect: "404", ticked: true });
  routes.set("https://api.example.com/", fixtures.gateway); routes.set("random", json({ message: "different" }, 401));
  expect((await run())?.http.some(h => h.name === "API reachable")).toBe(false);
  routes.set("random", json({ error: "unauthorized" }, 404));
  expect((await run())?.http.some(h => h.name === "API reachable")).toBe(false);
  routes.set("https://api.example.com/", { ...fixtures.gateway, headers: { "content-type": "text/html" } }); routes.set("random", fixtures.gateway);
  expect((await run())?.http.some(h => h.name === "API reachable")).toBe(false);
  routes.set("https://api.example.com/", json({ version: "1" }));
  expect((await run())?.http.find(h => h.name === "API")).toMatchObject({ ok: true, ticked: true });
  // Linear's GraphQL host greets with a line of text under text/html; a page is not that.
  routes.set("https://api.example.com/", html("Hello from the Example GraphQL API."));
  expect((await run())?.http.find(h => h.name === "API")).toMatchObject({ ok: true, ticked: true });
  routes.set("https://api.example.com/", html("<html><body>Example</body></html>"));
  expect((await run())?.http.some(h => h.name === "API")).toBe(false);
});
it("reads a health body as sent when the route sets short cookies (review 109)", async () => {
  const cookie = { "set-cookie": ["variant=a", "flag=true"] };
  routes.set("https://example.com/health", { ...json({ status: "fail" }), headers: { "content-type": "application/json", ...cookie } });
  routes.set("https://example.com/healthz", { ...json({ status: "ok" }), headers: { "content-type": "application/json", ...cookie } }); transport();
  const s = await run();
  expect(s?.http.find(h => h.url.endsWith("/health"))).toMatchObject({ ticked: false, reason: expect.stringContaining('"fail"') });
  expect(s?.http.find(h => h.url.endsWith("/healthz"))).toMatchObject({ ticked: true, assertions: [expect.objectContaining({ path: "$.status" })] });
});
it("treats health paths that only echo the path back as a catch-all", async () => {
  // Slack's Web API answers every /api/<method> with the method's name in the body.
  for (const path of ["/api/health", "/api/healthz", "/api/status", "/api/version"]) routes.set(`https://example.com${path}`, json({ ok: false, error: "unknown_method", req_method: path.split("/").pop() }));
  routes.set("https://example.com/healthcheck", { status: 200, body: "" }); transport();
  const s = await run();
  expect(s?.http.filter(h => !h.root).map(h => new URL(h.url).pathname)).toEqual(["/healthcheck"]);
});
it("finds API references in fetched same-origin scripts", async () => {
  routes.set(root, html('<script src="/main.js"></script>')); routes.set(root + "main.js", { body: 'fetch("https://api.example.com/v1,")' }); routes.set("https://api.example.com/ping", json({ ok: true })); transport();
  expect((await run())?.http.some(h => h.url === "https://api.example.com/ping")).toBe(true);
});
it("guesses API and SMTP only after both address families rule out wildcard DNS", async () => {
  const dns = vi.fn(async (_server: string, name: string, record: string) => ["A", "AAAA"].includes(record) && /^(api|smtp)\./.test(name) ? ["93.184.216.34"] : []);
  routes.set("https://api.example.com/", json({ version: "1" })); transport();
  const s = await run(root, dns);
  expect(s?.http.some(h => h.name === "API")).toBe(true);
  expect(s?.tcp).toEqual([{ kind: "tcp", name: "SMTP", host: "smtp.example.com", port: 587, tls: false, ms: 2 }]);
  expect(dns.mock.calls.filter(([, name]) => name.startsWith("staygreen-")).map(([, , record]) => record).sort()).toEqual(["A", "A", "AAAA", "AAAA"]);
});
it("guesses under wildcard DNS only a hostname with addresses of its own", async () => {
  // Postmark's shape: *.postmarkapp.com answers one address, smtp. and api. answer others.
  const dns = vi.fn(async (_server: string, name: string, record: string) => record !== "A" ? [] : name === "smtp.example.com" ? ["52.208.184.61"] : name === "api.example.com" ? ["50.31.156.110", "18.219.117.31"] : ["50.31.156.110"]);
  routes.set("https://api.example.com/", json({ version: "1" })); transport();
  const s = await run(root, dns);
  expect(s?.tcp).toEqual([expect.objectContaining({ name: "SMTP", host: "smtp.example.com" })]);
  expect(requested.some(u => u.includes("api.example.com"))).toBe(false);
});
it.each(["wildcard", "unknown"])("does not guess on %s DNS", async mode => {
  const dns = vi.fn(async () => { if (mode === "unknown") throw Object.assign(Error("timeout"), { code: "ETIMEOUT" }); return ["93.184.216.34"]; }); transport();
  const s = await run(root, dns);
  expect(s?.tcp).toEqual([]); expect(tcp).not.toHaveBeenCalled(); expect(requested.some(u => u.includes("api.example.com"))).toBe(false);
});
it("tries TLS 465 after 587 refuses, and offers no SMTP when both refuse", async () => {
  const dns = vi.fn(async (_server: string, name: string) => name === "smtp.example.com" ? ["93.184.216.34"] : []);
  tcp.mockResolvedValueOnce({ ok: false, ms: 1 }); transport();
  expect((await run(root, dns))?.tcp?.[0]).toMatchObject({ port: 465, tls: true });
  tcp.mockResolvedValue({ ok: false, ms: 1 }); expect((await run(root, dns))?.tcp).toEqual([]);
});
it("scans the same-domain linked app root, health and sign-in dependency, preserving its entry host", async () => {
  routes.set(root, html('<a href="https://app.example.com/login">Log <span>in</span></a>'));
  routes.set("https://app.example.com/", html('<a href="https://nested.example.com">App</a><script src="https://auth.example.com/auth.js"></script>'));
  routes.set("https://app.example.com/health", json({ ok: true })); routes.set("https://auth.example.com/auth.js", { body: "ok" }); transport();
  const s = await run();
  expect(s?.http.find(h => h.name === "App")).toMatchObject({ url: "https://app.example.com/", ticked: true });
  expect(s?.http.some(h => h.url === "https://app.example.com/health" && h.ticked)).toBe(true);
  expect(s?.http.some(h => h.url === "https://auth.example.com/auth.js")).toBe(true);
  expect(requested.some(u => u.includes("nested.example.com"))).toBe(false);
});
it("offers a separate same-brand website unticked and dedupes an apex redirect into the app", async () => {
  routes.set("https://account.example.com/", html("<title>Example – Sign in</title>")); transport();
  expect((await run("https://account.example.com/"))?.http.find(h => h.name === "Website" && !h.root)).toMatchObject({ url: root, ticked: false });
  routes.set(root, { status: 302, headers: { location: "https://account.example.com/" } });
  expect((await run("https://account.example.com/"))?.http.some(h => h.name === "Website" && !h.root)).toBe(false);
});
it("uses the PSL and brand guard instead of mistaking another tenant/vendor for the website", () => {
  expect(appLink('<a href="https://bob.github.io/">Login</a>', "https://alice.github.io/")).toBeNull();
  expect(appLink('<a href="https://app.example.com/">Login</a>', "https://example.com/docs")).toBeNull();
  expect(sameBrand({ html: "<title>Acme – Sign in</title>", url: "https://acme.zendesk.com/" }, { html: "<title>Zendesk – Sign in</title>", url: "https://zendesk.com/" })).toBe(false);
  expect(sameBrand({ html: '<meta name="theme-color" content="#dd4400">', url: "https://app.example.com/" }, { html: '<meta name="theme-color" content="#dd4400">', url: root })).toBe(true);
});
it("tries www when a live apex belongs to a different brand", async () => {
  routes.set("https://account.example.com/", html("<title>Example</title>"));
  routes.set(root, html("<title>Parking</title>")); routes.set("https://www.example.com/", html("<title>Example</title>")); transport();
  expect((await run("https://account.example.com/"))?.http.find(h => h.name === "Website" && !h.root)).toMatchObject({ url: "https://www.example.com/", ticked: false });
});
it("keeps all discovery work within the four-operation queue and starts none past its deadline", async () => {
  transport(2);
  const s = await runSuggestions(root, 0, false, { dns: noDns });
  expect(s?.reached).toBe(false); expect(requested).toEqual([]); expect(noDns).not.toHaveBeenCalled();
  vi.restoreAllMocks(); const stats = transport(3); await run(); expect(stats()).toEqual({ open: 0, max: 4 });
});
it("keeps the private-address guard on discovered redirects", async () => {
  routes.set(root, html('<a href="https://app.example.com">App</a>')); routes.set("https://app.example.com/", { status: 302, headers: { location: "http://127.0.0.1/" } }); transport();
  expect((await run())?.http.find(h => h.name === "App")).toMatchObject({ ok: false, ticked: false }); expect(requested).not.toContain("http://127.0.0.1/");
});
it("strips CSP separators for actual sign-in hosts as well as API hints", () => {
  expect(detectDependencies("", root, { "content-security-policy": "connect-src https://auth.example.com/v1,;" })[0].url).toBe("https://auth.example.com/v1");
  expect(namedApi([], root, { "content-security-policy": "connect-src https://api.example.com/v1,;" })).toBe("https://api.example.com");
});
it.each([["frontend-api.clerk.services", "Clerk"], ["tenant.edge.tenants.auth0.com", "Auth0"], ["circleci-prod-cd-ik9krpxrt3heo3mm.edge.tenants.us.auth0.com", "Auth0"], ["tenant.okta-dnssec.com", "Okta"], ["mongodb.customdomains.okta.com", "Okta"], ["separated-sauroposeidon-7655.customers.stytch.com", "Stytch"], ["project.supabase.co", "Supabase"], ["project.projects.oryapis.com", "Ory"], ["example.authkit.app", "WorkOS"]])("recognizes documented CNAME target %s", (host, vendor) => expect(cnameVendor(host)).toBe(vendor));
it("keeps a documented vendor CNAME on an API-prefixed host without inventing a sign-in HTTP check", async () => {
  routes.set(root, html('<script>fetch("https://api.stytch.example.com/v1")</script>')); transport();
  const dns: Ask = async (_server, host, record) => host === "api.stytch.example.com" && record === "CNAME" ? ["separated-sauroposeidon-7655.customers.stytch.com"] : [];
  const s = await run(root, dns);
  expect(s?.dns).toMatchObject([{ name: "Stytch DNS record", recordName: "api.stytch.example.com" }]);
  expect(s?.http.some(h => h.dependency === "First-party dependency")).toBe(false);
});
it.each(["x.elb.amazonaws.com", "x.cloudfront.net", "x.fastly.net", "x.azurefd.net", "clerk.services.evil.com", "auth0.com", "x.auth0.com"]) ("rejects rotating/undocumented CNAME %s", host => expect(cnameVendor(host)).toBeNull());
