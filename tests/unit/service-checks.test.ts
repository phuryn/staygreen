import http from "node:http";
import https from "node:https";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { checkSupabase } from "@/checks/supabase";
import { checkStripe, judgeStripe, type StripeObservation } from "@/checks/stripe";
import { serviceFetch, within, type ServiceAnswer, type ServiceFetch } from "@/checks/service-fetch";
import { parseMonitorDraft } from "@/lib/monitor-input";
import { runTest } from "@/lib/monitor-test";
import { SERVICE_KEY, STRIPE_CRITICAL, type StripeConfig } from "@/lib/service-monitor";
import { fresh, needsConfirmation, step } from "../../probe/state";

const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
const PUB = "sb_publishable_abcdefghijklmnop123456789";
const RK = "rk_test_abcdefghijklmnop123456789";
const appId = `app_${"a".repeat(24)}`;
const sb = { projectUrl: PROJECT, databaseRead: "" };
const st: StripeConfig = { endpoints: ["we_one"], critical: STRIPE_CRITICAL, failureThreshold: 3, windowMin: 30, pendingMin: 30 };
const at = 1800000000;
const json = (body: unknown, status = 200): ServiceAnswer => ({ status, body: JSON.stringify(body) });
const fake = (answers: ServiceAnswer[]) => vi.fn<ServiceFetch>(async () => {
  const a = answers.shift(); if (!a) throw new Error("Unexpected request"); return a;
});
const auth = () => json({ name: "GoTrue", version: "v2.1", description: PUB });
const endpoint = (status = "enabled") => json({ id: "we_one", status, url: `https://private.example/secret?key=${RK}` });
const list = (data: unknown[] = [], has_more = false) => json({ data, has_more });
const event = (id = "evt_one", type = "invoice.paid", pending = 0, age = 60) => ({ id, type, pending_webhooks: pending, created: at - age, data: { object: { email: "private@example.com", secret: RK } } });
const denied = () => json({ error: { type: "invalid_request_error", message: RK } }, 403);

describe("service transport", () => {
  let server: http.Server;
  let url: string;
  const requests: string[] = [];
  let payloadBytes = 0;
  let eventCount = 11;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.url === "/redirect") return res.writeHead(302, { location: "/secret" }).end();
      if (req.url === "/large") return res.end("x".repeat(65537));
      const path = new URL(req.url!, "http://fixture.test");
      if (path.pathname === "/v1/customers") return res.writeHead(403).end(JSON.stringify({ error: { type: "invalid_request_error" } }));
      if (path.pathname === "/v1/webhook_endpoints/we_one") return res.end(JSON.stringify({ id: "we_one", status: "enabled" }));
      if (path.pathname === "/v1/events") {
        const start = path.searchParams.has("starting_after") ? Number(path.searchParams.get("starting_after")!.slice(4)) + 1 : 0;
        const end = Math.min(eventCount, start + Number(path.searchParams.get("limit")));
        const data = Array.from({ length: end - start }, (_, i) => ({ ...event(`evt_${start + i}`, "invoice.paid", 1), data: { object: "x".repeat(payloadBytes) } }));
        return res.end(JSON.stringify({ data, has_more: end < eventCount }));
      }
      res.end("ok");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  it("refuses private destinations before reaching the server", async () => {
    const before = requests.length;
    expect(await serviceFetch()(url, { apikey: PUB }, 1000)).toEqual({ error: "private", code: undefined });
    expect(requests).toHaveLength(before);
  });
  it("does not follow a redirect with the key and refuses an oversized body", async () => {
    const fetch = serviceFetch({ allow: () => true });
    expect(await fetch(`${url}/redirect`, { apikey: PUB }, 1000)).toEqual({ status: 302, body: "" });
    expect(requests).not.toContain("GET /secret");
    expect(await fetch(`${url}/large`, { apikey: PUB }, 1000)).toEqual({ error: "protocol", code: "BODY_TOO_LARGE" });
    expect(requests.every(r => r.startsWith("GET "))).toBe(true);
  });
  // Replace only the destination socket: the real body reader, Stripe pagination
  // and save preflight all run against streamed fixture bytes.
  const routeStripeHere = () => vi.spyOn(https, "request").mockImplementation(((input: URL, options: http.RequestOptions) =>
    http.request(new URL(`${input.pathname}${input.search}`, url), options)) as typeof https.request);
  it.each([8_000, 80_000, 150_000])("reads full Stripe events with %i-byte resources without an outage or a failed save", async size => {
    payloadBytes = size; eventCount = 11;
    const redirect = routeStripeHere();
    const before = requests.length;
    try {
      const fetch = serviceFetch({ allow: () => true });
      const r = await checkStripe(st, RK, { fetch, now: () => at * 1000 });
      expect(r.ok).toBe(true);
      expect((r.detail?.observation as StripeObservation).events).toHaveLength(11);
      expect(JSON.stringify(r)).not.toContain("xxxxxxxx");
      const parsed = parseMonitorDraft({ ...st, type: "stripe", name: "", appId, key: RK });
      if (!parsed.ok) throw Error("parser");
      expect(await runTest(parsed.row, { [SERVICE_KEY]: RK }, 25000, { serviceFetch: fetch, now: () => at * 1000 }))
        .toMatchObject({ ok: true, service: { saveable: true } });
      const limits = requests.slice(before).filter(r => r.includes("/v1/events")).map(r => new URL(r.slice(4), url).searchParams.get("limit"));
      const perPoll = size === 150_000 ? ["10", ...Array(11).fill("1")] : ["10", "10"];
      expect(limits).toEqual([...perPoll, ...perPoll]);
    } finally { redirect.mockRestore(); }
  });
  it("fails closed when a single Stripe event cannot fit the bounded response", async () => {
    payloadBytes = 1024 * 1024; eventCount = 1;
    const redirect = routeStripeHere();
    const before = requests.length;
    try {
      const r = await checkStripe(st, RK, { fetch: serviceFetch({ allow: () => true }), verifyKey: true });
      expect(r).toMatchObject({ ok: false, failure: { kind: "protocol" } });
      expect(r.detail?.verified).not.toBe(true);
      expect(requests.slice(before).filter(r => r.includes("/v1/events"))).toHaveLength(2);
    } finally { redirect.mockRestore(); }
  });
  it("keeps the smaller ceiling on origins other than https://api.stripe.com", async () => {
    const redirect = routeStripeHere();
    try {
      for (const host of ["api.stripe.com.evil.test", "other.example", "abcdefghijklmnopqrst.supabase.co"]) {
        expect(await serviceFetch({ allow: () => true })(`https://${host}/large`, {}, 1000)).toMatchObject({ error: "protocol" });
      }
    } finally { redirect.mockRestore(); }
  });
});

describe("Supabase checks", () => {
  it("calls only Auth and Storage with the key, no REST root or guessed relation", async () => {
    const fetch = fake([auth(), json({ status: "ok" })]);
    expect(await checkSupabase(sb, PUB, { fetch })).toMatchObject({ ok: true, detail: { pauseRisk: true } });
    expect(fetch.mock.calls.map(c => c[0])).toEqual([`${PROJECT}/auth/v1/health`, `${PROJECT}/storage/v1/status`]);
    for (const [, h] of fetch.mock.calls) expect(h).toEqual({ apikey: PUB, accept: "application/json" });
  });
  it.each(["staygreen_health", "rpc/health"])("asks the configured %s once and discards its body", async databaseRead => {
    const fetch = fake([auth(), json({}), json([{ private: RK }])]);
    const r = await checkSupabase({ ...sb, databaseRead }, PUB, { fetch });
    expect(r).toMatchObject({ ok: true, detail: { pauseRisk: false, steps: [{ ok: true }, { ok: true }, { name: "Database read", ok: true }] } });
    expect(fetch.mock.calls[2][0]).toBe(`${PROJECT}/rest/v1/${databaseRead}?limit=1`);
    expect(JSON.stringify(r)).not.toContain(RK);
  });
  it.each(["", "sb_secret_abcdefghijklmnop", "sk_live_abcdefghijklmnop"])("sends nothing for non-public key %s", async key => {
    const fetch = fake([]);
    expect((await checkSupabase(sb, key, { fetch })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["/", "../secret", "health?x=1", "rpc/write/extra", "a#b"])("never sends invalid read %s", async databaseRead => {
    const fetch = fake([]);
    expect((await checkSupabase({ ...sb, databaseRead }, PUB, { fetch })).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["http://abcdefghijklmnopqrst.supabase.co", "https://localhost", `${PROJECT}.evil.test`, `${PROJECT}/rest/v1/`])("never sends to %s", async projectUrl => {
    const fetch = fake([]); await checkSupabase({ ...sb, projectUrl }, PUB, { fetch }); expect(fetch).not.toHaveBeenCalled();
  });
  it("distinguishes paused/deleted NXDOMAIN from temporary DNS and network failure", async () => {
    expect(await checkSupabase(sb, PUB, { fetch: fake([{ error: "dns", code: "ENOTFOUND" }]) })).toMatchObject({ ok: false, failure: { kind: "project_paused" }, detail: { dashboardUrl: "https://supabase.com/dashboard/project/abcdefghijklmnopqrst" } });
    for (const error of ["dns", "connect", "timeout", "private", "tls"] as const) {
      expect(await checkSupabase(sb, PUB, { fetch: fake([{ error }]) })).toMatchObject({ ok: false, failure: { kind: error } });
    }
  });
  it.each([401, 403, 404, 400])("reports the real %s status without a persisted refusal", async status => {
    const fetch = fake([auth(), json({}, status)]);
    const r = await checkSupabase(sb, PUB, { fetch });
    expect(r).toMatchObject({ ok: false, status, detail: { steps: [{ name: "Auth health", ok: true }, { name: "Storage status", ok: false, status }] } });
    expect(r.detail).not.toHaveProperty("rejected");
    const retry = fake([auth(), json({})]);
    expect((await checkSupabase(sb, PUB, { fetch: retry })).ok).toBe(true);
    expect(retry).toHaveBeenCalledTimes(2);
  });
  it.each([301, 429, 500, 503])("does not treat %s as a permanent key rejection", async status => {
    const fetch = fake([json({ key: PUB }, status)]);
    const r = await checkSupabase(sb, PUB, { fetch });
    expect(r.ok).toBe(false); expect(r.detail).not.toHaveProperty("rejected");
    expect(JSON.stringify(r)).not.toContain(PUB); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["{}", "[]", "null", "<html>ok</html>"])("refuses bogus Auth health %s", async body => {
    expect(await checkSupabase(sb, PUB, { fetch: fake([{ status: 200, body }]) })).toMatchObject({ ok: false, failure: { kind: "protocol" } });
  });
  it("refuses a database read that returns HTML with 200", async () => {
    expect(await checkSupabase({ ...sb, databaseRead: "health" }, PUB,
      { fetch: fake([auth(), json({}), { status: 200, body: "<html>" }]) })).toMatchObject({ ok: false, failure: { kind: "protocol" } });
  });
});

describe("Stripe checks", () => {
  it.each(["sk_live_abcdefghijklmnop", "sk_test_abcdefghijklmnop", "pk_live_abcdefghijklmnop", ""])("refuses %s before sending anything", async key => {
    const fetch = fake([]); expect((await checkStripe(st, key, { fetch, verifyKey: true })).ok).toBe(false); expect(fetch).not.toHaveBeenCalled();
  });
  it("verifies a forbidden read and both allowed reads without sending a mutation", async () => {
    const fetch = fake([denied(), endpoint(), list()]);
    const r = await checkStripe(st, RK, { fetch, verifyKey: true, now: () => at * 1000 });
    expect(r).toMatchObject({ ok: true, detail: { verified: true, scope: "account" } });
    expect(fetch.mock.calls.map(c => new URL(c[0]).pathname)).toEqual(["/v1/customers", "/v1/webhook_endpoints/we_one", "/v1/events"]);
    expect(fetch.mock.calls[2][0]).toContain("delivery_success=false");
    expect(JSON.stringify(r)).not.toContain(RK);
  });
  it.each([200, 400, 401, 429, 500])("does not accept %s as the forbidden read's permission denial", async status => {
    const fetch = fake([json({ error: { type: "invalid_request_error" } }, status)]);
    expect((await checkStripe(st, RK, { fetch, verifyKey: true })).ok).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not accept a generic intermediary 403", async () => {
    const fetch = fake([json({ error: "forbidden" }, 403)]);
    expect((await checkStripe(st, RK, { fetch, verifyKey: true })).ok).toBe(false);
  });
  it("allows saving a verified account already failing, without returning event payloads", async () => {
    const fetch = fake([denied(), endpoint(), list([event()])]);
    const parsed = parseMonitorDraft({ ...st, type: "stripe", name: "", appId, key: RK });
    if (!parsed.ok) throw Error("parser");
    const r = await runTest(parsed.row, { [SERVICE_KEY]: RK }, 25000, { serviceFetch: fetch, now: () => at * 1000 });
    expect(r).toMatchObject({ ok: false, service: { saveable: true }, failure: { kind: "stripe" } });
    for (const secret of [RK, "private@example.com", "evt_one", "private.example"]) expect(JSON.stringify(r)).not.toContain(secret);
  });
  it("walks pages and preserves event types and creation times, never payloads", async () => {
    const fetch = fake([endpoint(), list([event()], true), list([event("evt_two", "charge.failed")])]);
    const r = await checkStripe(st, RK, { fetch, now: () => at * 1000 });
    expect(fetch.mock.calls[2][0]).toContain("starting_after=evt_one");
    expect(r).toMatchObject({ ok: false, detail: { count: 2, eventTypes: ["charge.failed", "invoice.paid"], oldestEventAt: new Date((at - 60) * 1000).toISOString() } });
    expect(JSON.stringify(r)).not.toContain("private@example.com");
  });
  it("does not mistake pagination that makes no progress for healthy", async () => {
    const fetch = fake([endpoint(), list([event()], true), list([event()], true)]);
    expect(await checkStripe(st, RK, { fetch })).toMatchObject({ ok: false, failure: { kind: "protocol" } });
  });
  it.each([401, 403, 404, 429, 500])("refuses an unreadable endpoint (%s)", async status => {
    const fetch = fake([json({ secret: RK }, status)]);
    expect(await checkStripe(st, RK, { fetch })).toMatchObject({ ok: false, status }); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 500])("never treats an Events API error (%s) as no failures", async status => {
    const fetch = fake([endpoint(), json({ data: [], has_more: false, secret: RK }, status)]);
    const r = await checkStripe(st, RK, { fetch });
    expect(r).toMatchObject({ ok: false, status });
    expect(r.detail?.verified).not.toBe(true);
    expect(JSON.stringify(r)).not.toContain(RK);
  });
  it.each(["timeout", "dns", "tls", "private"] as const)("keeps %s an API failure at either read", async error => {
    for (const answers of [[{ error }], [endpoint(), { error }]]) {
      expect(await checkStripe(st, RK, { fetch: fake(answers) })).toMatchObject({ ok: false, failure: { kind: error } });
    }
  });
  it("fails closed at the pagination cap instead of discarding an unseen backlog", async () => {
    const pages = Array.from({ length: 100 }, (_, page) => list(Array.from({ length: 10 }, (_, i) => event(`evt_${page}x${i}`)), true));
    const fetch = fake([endpoint(), ...pages]);
    expect(await checkStripe(st, RK, { fetch })).toMatchObject({ ok: false, failure: { kind: "protocol", message: expect.stringContaining("backlog exceeds") } });
    expect(fetch).toHaveBeenCalledTimes(101);
  });
  it("retries a truncated later page from its existing cursor without losing prior events", async () => {
    const fetch = fake([endpoint(), list([event("evt_first")], true), { error: "protocol", code: "BODY_TOO_LARGE" },
      list([event("evt_second")], true), list([event("evt_last")])]);
    const r = await checkStripe(st, RK, { fetch, verifyKey: false, now: () => at * 1000 });
    expect((r.detail?.observation as StripeObservation).events.map(e => e.id)).toEqual(["evt_first", "evt_second", "evt_last"]);
    expect(r.failure?.kind).toBe("stripe"); // Real critical failures are still judged after the complete read.
    expect(new URL(fetch.mock.calls[2][0]).searchParams.get("starting_after")).toBe("evt_first");
    expect(new URL(fetch.mock.calls[3][0]).searchParams.get("starting_after")).toBe("evt_first");
    expect(new URL(fetch.mock.calls[3][0]).searchParams.get("limit")).toBe("1");
  });
  it.each([false, true])("bounds one-event fallback at 1,000 events, has_more=%s", async hasMore => {
    const pages = Array.from({ length: 1000 }, (_, i) => list([event(`evt_${i}`, "charge.failed", 1)], i < 999 || hasMore));
    const fetch = fake([endpoint(), { error: "protocol", code: "BODY_TOO_LARGE" }, ...pages]);
    const r = await checkStripe(st, RK, { fetch, now: () => at * 1000 });
    expect(r.ok).toBe(!hasMore);
    if (hasMore) expect(r.failure).toMatchObject({ kind: "protocol", message: expect.stringContaining("backlog exceeds") });
    else expect((r.detail?.observation as StripeObservation).events).toHaveLength(1000);
    expect(fetch).toHaveBeenCalledTimes(1002); // One endpoint, one retry, at most 1,000 event pages.
  });
  it("fails closed when a final partial page crosses the event cap", async () => {
    const pages = Array.from({ length: 100 }, (_, page) => list(Array.from({ length: page === 0 ? 9 : 10 }, (_, i) => event(`evt_${page}x${i}`)), true));
    const fetch = fake([endpoint(), ...pages, list([event("evt_extra1"), event("evt_extra2")])]);
    expect(await checkStripe(st, RK, { fetch })).toMatchObject({ ok: false, failure: { kind: "protocol", message: expect.stringContaining("backlog exceeds") } });
  });
  it("reports a disabled endpoint without inventing who disabled it", async () => {
    const r = await checkStripe(st, RK, { fetch: fake([endpoint("disabled"), list()]) });
    expect(r).toMatchObject({ ok: false, failure: { kind: "stripe", message: expect.stringContaining("does not identify who") } });
    expect(needsConfirmation("stripe", r)).toBe(true);
  });
  it.each([json({}), json({ data: [], has_more: "false" }), list([{ id: "evt_bad", type: RK }]), { status: 200, body: "<html>" }])("fails closed on malformed events %#", async answer => {
    expect(await checkStripe(st, RK, { fetch: fake([endpoint(), answer]) })).toMatchObject({ ok: false, failure: { kind: "protocol" } });
  });
});

describe("Stripe thresholds and recovery", () => {
  const observation = (n: number, type = "charge.failed", pending = 0, age = 60): StripeObservation => ({ at, disabled: [],
    events: Array.from({ length: n }, (_, i) => ({ id: `evt_${i}`, type, pending, created: at - age })) });
  it("requires 3 ordinary events or one exact/wildcard critical event", () => {
    expect(judgeStripe(st, observation(2)).ok).toBe(true);
    expect(judgeStripe(st, observation(3)).ok).toBe(false);
    expect(judgeStripe(st, observation(1, "invoice.paid")).ok).toBe(false);
    expect(judgeStripe(st, observation(1, "customer.subscription.updated")).ok).toBe(false);
    expect(judgeStripe(st, observation(1, "customer.subscriptionish")).ok).toBe(true);
  });
  it("keeps the count, pending and oldest time when many event types overflow the 500-character cap", () => {
    const events = Array.from({ length: 30 }, (_, i) => ({ id: `evt_${i}`, type: `customer.subscription.trial_will_end_${i}`, pending: 1, created: at - 3600 }));
    const r = judgeStripe(st, { at, disabled: [], events });
    expect(r.ok).toBe(false);
    const message = r.failure?.message ?? "";
    expect(message.length).toBeLessThanOrEqual(500);
    expect(message).toContain("30 affected Stripe events across this account. 30 pending.");
    expect(message).toContain(`Oldest affected event: ${new Date((at - 3600) * 1000).toISOString()}.`);
  });
  it("does not page for fresh deliveries still in flight; aged pending and the window have boundaries", () => {
    expect(judgeStripe(st, observation(1, "invoice.paid", 1, 1799)).ok).toBe(true);
    expect(judgeStripe(st, observation(1, "invoice.paid", 1, 1800)).ok).toBe(false);
    expect(judgeStripe(st, observation(3, "charge.failed", 0, 1801)).ok).toBe(true);
  });
  it("uses the same pending age boundary for recovery, even for previously seen ids", () => {
    for (const previous of [{}, { seen: ["evt_0"] }]) {
      expect(judgeStripe(st, observation(1, "invoice.paid", 1, 1799), previous, true).ok).toBe(true);
      expect(judgeStripe(st, observation(1, "invoice.paid", 1, 1800), previous, true).ok).toBe(false);
    }
  });
  it("recovers on two clean polls, even when old terminal failures remain in the list", () => {
    const obs = observation(1, "invoice.paid");
    const failed = judgeStripe(st, obs);
    let s = step("stripe", fresh(), { first: { ...failed, location: "tor1" }, confirm: { ...failed, location: "sfo3" } }).next;
    expect(s.state).toBe("down");
    const passed = judgeStripe(st, obs, { seen: ["evt_0"] }, true);
    expect(passed.ok).toBe(true);
    s = step("stripe", s, { first: { ...passed, location: "tor1" } }).next;
    expect(s.state).toBe("down");
    expect(step("stripe", s, { first: { ...passed, location: "sfo3" } }).next.state).toBe("up");
    expect(judgeStripe(st, obs, { seen: ["evt_0"] }, false).ok).toBe(true);
    expect(judgeStripe(st, observation(1, "invoice.paid", 1, 1800), { seen: ["evt_0"] }, true).ok).toBe(false);
    expect(judgeStripe(st, observation(2), { seen: ["evt_0"] }, true).ok).toBe(false);
  });
  it("still confirms API failures, and confirms Supabase pause before opening an incident", () => {
    const f = { ok: false, ms: 0, failure: { kind: "project_paused" as const, message: "Project paused or deleted." }, location: "tor1" };
    expect(needsConfirmation("supabase", f)).toBe(true);
    expect(step("supabase", fresh(), { first: f }).next.state).toBe(null);
    expect(step("supabase", fresh(), { first: f, confirm: { ...f, location: "sfo3" } }).next.state).toBe("down");
    expect(needsConfirmation("stripe", { ...f, failure: { kind: "timeout", message: "timeout" } })).toBe(true);
  });
  it("bounds a stalled/throwing fake transport without returning its exception", async () => {
    const fetch = within(async () => { throw new Error(RK); }, 10);
    expect(await fetch("https://example.com", {}, 0)).toEqual({ error: "connect" });
    expect(await within(() => new Promise(() => {}), 5)("https://example.com", {}, 0)).toEqual({ error: "timeout" });
  });
});
