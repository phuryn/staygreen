import { beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_BUDGET } from "@/lib/budgets";
import { TEST_DEADLINE_MS } from "@/lib/monitor-test";
import { FREE, limits } from "@/lib/plans";
import type { Suggestions } from "@/lib/suggestions";
import { addSuggestedChecks, suggestChecks, updateApp } from "@/app/(app)/app/actions";

/* `suggestChecks` and `addSuggestedChecks` (`docs/flows.md § Suggested checks`): the real actions,
   permission check, parser and limits; a fake identity, database, target check, run, model and
   sealing. The run itself is `suggestion-checks.test.ts`, against servers on this machine. */

const fake = vi.hoisted(() => ({
  member: vi.fn(),
  app: vi.fn(),
  origin: vi.fn(),
  appRow: vi.fn(),
  logo: vi.fn(),
  monitors: vi.fn(),
  rpc: vi.fn(),
  run: vi.fn(),
  target: vi.fn(),
  model: vi.fn(),
  update: vi.fn(),
  testService: vi.fn(),
  readFilter: vi.fn(),
}));
vi.mock("@/lib/monitor-test", async original => ({ ...(await original<typeof import("@/lib/monitor-test")>()), runTest: fake.testService }));
vi.mock("@/lib/workspace", async (original) => ({ ...(await original<typeof import("@/lib/workspace")>()), memberOrNull: fake.member, resolveApp: fake.app }));
vi.mock("@/lib/request", async (original) => ({ ...(await original<typeof import("@/lib/request")>()), assertSameOrigin: fake.origin }));
vi.mock("@/lib/suggestion-checks", () => ({ runSuggestions: fake.run }));
vi.mock("@/lib/targets", async (original) => ({ ...(await original<typeof import("@/lib/targets")>()), checkTarget: fake.target }));
vi.mock("@/lib/site-model", () => ({ siteModelFromEnv: fake.model }));
// What is sealed is named by its context, so a test sees which header was sealed and never its value.
vi.mock("@/lib/credentials", () => ({ seal: (_value: string, context: string) => `sealed:${context}`, open: vi.fn() }));
vi.mock("@/lib/db", () => {
  // Every read these actions make ends in `maybeSingle()` or `in()`; an update is awaited after its filters.
  const chain = (table: string, end: () => unknown) => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = (...f: unknown[]) => (fake.readFilter(table, ...f), c);
    c.in = end;
    c.maybeSingle = end;
    c.update = (row: unknown) => {
      const filters: unknown[][] = [];
      const u: Record<string, unknown> = {
        eq: (...f: unknown[]) => (filters.push(f), u),
        select: () => u,
        then: (resolve: (v: unknown) => void) => resolve(fake.update(table, row, filters)),
      };
      return u;
    };
    return c;
  };
  return {
    db: () => ({
      from: (table: string) => chain(table, table === "apps" ? fake.appRow : table === "app_logos" ? fake.logo : fake.monitors),
      rpc: fake.rpc,
    }),
  };
});

const APP = `app_${"c".repeat(24)}`;
const ws = { id: "ws_a", clerk_org_id: "org_a" };
const admin = { caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" }, workspace: ws, entitlements: FREE };
const NOT_FOUND = { ok: false, reason: "That isn't here any more. Reload the page." };
const ADDRESS = "https://afkpilot.com/";

const found: Suggestions = {
  address: ADDRESS,
  reached: true,
  http: [
    { kind: "http", url: ADDRESS, name: "Website", root: true, ok: true, status: 200, ms: 182, ticked: true },
    { kind: "http", url: "https://afkpilot.com/health", name: "Health check", root: false, ok: true, status: 200, ms: 40, ticked: true },
  ],
  ssl: { kind: "ssl", host: "afkpilot.com", ok: true, expiresAt: "2027-01-12T00:00:00.000Z", daysLeft: 82, issuer: "R11" },
  icon: null,
  accent: null,
  supabase: null,
};
const creates = () => fake.rpc.mock.calls.filter(([name]) => name === "create_monitor").map(([, args]) => args);

// A Supabase project and its keys, made here: none is a real key.
const REF = "abcdefghij0123456789";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.${"s".repeat(43)}`;
const PUBLISHABLE = `sb_publishable_${"p".repeat(24)}`;
const AUTH = `https://${REF}.supabase.co/auth/v1/health`;
const STORAGE = `https://${REF}.supabase.co/storage/v1/status`;
const MODEL = vi.fn();

it("saves a discovered API gateway's expected status and SMTP through the normal guarded quota path", async () => {
  const url = "https://api.afkpilot.com/";
  const result = await addSuggestedChecks(APP, { urls: [url], ssl: false, http: [{ url, name: "API reachable", expect: "401" }], tcp: [{ host: "smtp.afkpilot.com", port: 465, tls: true }] });
  expect(result).toEqual({ ok: true, added: 2 });
  expect(creates()).toMatchObject([{ p_type: "http", p_name: "API reachable", p_config: { expect: "401" } }, { p_type: "tcp", p_name: "SMTP", p_config: { host: "smtp.afkpilot.com", port: 465, tls: true } }]);
  expect(fake.target).toHaveBeenCalledTimes(2);
});
it.each([
  { host: "smtp.other.com", port: 587, tls: false }, { host: "127.0.0.1", port: 587, tls: false },
  { host: "smtp.afkpilot.com", port: 25, tls: false }, { host: "smtp.afkpilot.com", port: 465, tls: false },
  { host: "api.afkpilot.com", port: 587, tls: false },
])("refuses a forged SMTP pick before creating anything: %j", async tcp => {
  expect((await addSuggestedChecks(APP, { urls: [], ssl: false, tcp: [tcp] })).ok).toBe(false);
  expect(creates()).toEqual([]); expect(fake.target).not.toHaveBeenCalled();
});
it("marks SMTP covered across the workspace, and deduplicates its save", async () => {
  const smtp = { kind: "tcp" as const, host: "smtp.afkpilot.com", port: 587, tls: false, name: "SMTP", ms: 1 };
  fake.run.mockResolvedValue({ ...found, tcp: [smtp] });
  fake.monitors.mockResolvedValue({ data: [{ type: "tcp", target: "smtp.afkpilot.com:587", target_host: "smtp.afkpilot.com" }], error: null });
  expect(await suggestChecks(APP)).toMatchObject({ ok: true, suggestions: { tcp: [{ ...smtp, watched: true }] } });
  expect(await addSuggestedChecks(APP, { urls: [], ssl: false, tcp: [{ host: smtp.host, port: smtp.port, tls: false }] })).toEqual({ ok: true, added: 0 });
});

beforeEach(() => {
  vi.clearAllMocks();
  fake.origin.mockResolvedValue(undefined);
  fake.member.mockResolvedValue(admin);
  fake.app.mockResolvedValue({ id: APP, workspace: ws });
  fake.appRow.mockResolvedValue({ data: { url: ADDRESS }, error: null });
  fake.logo.mockResolvedValue({ data: null, error: null });
  fake.monitors.mockResolvedValue({ data: [], error: null });
  fake.rpc.mockImplementation(async (name: string) => (name === "spend_budget" ? { data: { ok: true }, error: null } : { data: null, error: null }));
  fake.run.mockResolvedValue(found);
  fake.target.mockResolvedValue({ ok: true });
  fake.model.mockReturnValue(null);
  fake.testService.mockResolvedValue({ ok: true, service: { saveable: true } });
  fake.update.mockReturnValue({ data: [{ id: APP }], error: null });
});

describe("suggestChecks", () => {
  it("rescans the current stored address each visit and charges the same test budget each time", async () => {
    await suggestChecks(APP);
    fake.appRow.mockResolvedValue({ data: { url: "https://new.afkpilot.com/" }, error: null });
    await suggestChecks(APP);
    expect(fake.run.mock.calls.map(([url]) => url)).toEqual([ADDRESS, "https://new.afkpilot.com/"]);
    expect(fake.rpc.mock.calls.filter(([name]) => name === "spend_budget")).toHaveLength(2);
    expect(fake.readFilter).toHaveBeenCalledWith("apps", "id", APP);
    expect(fake.readFilter).toHaveBeenCalledWith("apps", "workspace_id", ws.id);
    expect(fake.readFilter).toHaveBeenCalledWith("monitors", "workspace_id", ws.id);
    expect(fake.readFilter.mock.calls.some(([table, field]) => table === "monitors" && field === "app_id")).toBe(false);
  });

  it("refuses a member without write permission before a scan, save or add", async () => {
    fake.member.mockResolvedValue({ ...admin, caller: { ...admin.caller, orgRole: "org:member" } });
    expect(await suggestChecks(APP)).toEqual(NOT_FOUND);
    expect(await updateApp(APP, { name: "App", url: ADDRESS })).toEqual(NOT_FOUND);
    expect(await addSuggestedChecks(APP, { urls: [ADDRESS], ssl: false })).toEqual(NOT_FOUND);
    expect(fake.appRow).not.toHaveBeenCalled();
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("saves a missing address with Settings' validation and tenant boundary before scanning", async () => {
    expect(await updateApp(APP, { name: "My app", url: ` ${ADDRESS} ` })).toEqual({ ok: true });
    expect(fake.update).toHaveBeenCalledWith("apps", { name: "My app", url: ADDRESS }, [["id", APP], ["workspace_id", ws.id]]);
    expect(fake.run).not.toHaveBeenCalled();
    fake.update.mockClear();
    expect(await updateApp(APP, { name: "My app", url: "https://user:password@example.com/" })).toMatchObject({ ok: false, fieldErrors: { url: expect.any(String) } });
    fake.app.mockResolvedValue({ id: APP, workspace: { id: "ws_b", clerk_org_id: "org_b" } });
    expect(await updateApp(APP, { name: "My app", url: ADDRESS })).toEqual(NOT_FOUND);
    expect(await addSuggestedChecks(APP, { urls: [ADDRESS], ssl: false })).toEqual(NOT_FOUND);
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });

  it("marks covered dependency and DNS checks across the workspace, then offers a deleted check again", async () => {
    const dependency = { ...found.http[0], root: false, url: "https://clerk.afkpilot.com/script.js", dependency: "Clerk" as const };
    const dns = { kind: "dns" as const, record: "NS" as const, recordName: "afkpilot.com", expected: "ns1.example.net", name: "Nameservers", purpose: "Catches a DNS move." };
    fake.run.mockResolvedValue({ ...found, http: [dependency], dns: [dns] });
    fake.monitors.mockResolvedValue({ data: [{ type: "http", target: dependency.url }, { type: "dns", target: "NS afkpilot.com" }], error: null });
    const covered = await suggestChecks(APP);
    expect(covered).toMatchObject({ ok: true, suggestions: { http: [{ watched: true }], dns: [{ watched: true }] } });
    fake.monitors.mockResolvedValue({ data: [], error: null });
    const missing = await suggestChecks(APP);
    expect(missing.ok && missing.suggestions.http[0].watched).toBeUndefined();
    expect(missing.ok && missing.suggestions.dns?.[0].watched).toBeUndefined();
  });
  it("spends one use of the test budget and tries the app's own address once, inside the test's deadline", async () => {
    expect(await suggestChecks(APP)).toEqual({ ok: true, suggestions: found });
    expect(fake.rpc).toHaveBeenCalledTimes(1);
    expect(fake.rpc).toHaveBeenCalledWith("spend_budget", expect.objectContaining({ p_workspace_id: "ws_a", p_action: "test_check", p_user_id: "user_a", p_member_limit: TEST_BUDGET.member.limit }));
    expect(fake.run).toHaveBeenCalledTimes(1);
    const [address, withinMs, wantIcon] = fake.run.mock.calls[0];
    expect(address).toBe(ADDRESS);
    expect(withinMs).toBeGreaterThan(TEST_DEADLINE_MS - 2_000);
    expect(withinMs).toBeLessThanOrEqual(TEST_DEADLINE_MS);
    expect(wantIcon).toBe(true);
  });

  it("hands the run the model call, when there is a key, and the plan's assertions per monitor", async () => {
    await suggestChecks(APP);
    expect(fake.run.mock.calls[0][4]).toEqual({ model: null, maxAssertions: FREE.limits.assertions });
    fake.model.mockReturnValue(MODEL);
    await suggestChecks(APP);
    expect(fake.run.mock.calls[1][4]).toEqual({ model: MODEL, maxAssertions: FREE.limits.assertions });
    // Still one use of the test budget a run: the model's call is inside it.
    expect(fake.rpc.mock.calls.filter(([name]) => name === "spend_budget")).toHaveLength(2);
  });

  it("keeps the brand colour it found on the app, for its next status page, and a run that finds none leaves the last one", async () => {
    fake.run.mockResolvedValue({ ...found, accent: "#635bff" });
    const r = await suggestChecks(APP);
    expect(r).toMatchObject({ ok: true, suggestions: { accent: "#635bff" } });
    expect(fake.update).toHaveBeenCalledWith("apps", { accent: "#635bff" }, [["id", APP], ["workspace_id", "ws_a"]]);
    fake.update.mockClear();
    fake.run.mockResolvedValue(found);
    await suggestChecks(APP);
    expect(fake.update).not.toHaveBeenCalled();
  });

  it("looks for no icon when the app has a logo", async () => {
    fake.logo.mockResolvedValue({ data: { app_id: APP }, error: null });
    await suggestChecks(APP);
    expect(fake.run.mock.calls[0][2]).toBe(false);
  });

  it("marks what a monitor of the workspace already watches", async () => {
    fake.monitors.mockResolvedValue({ data: [{ type: "http", target: ADDRESS, target_host: "afkpilot.com" }, { type: "ssl", target: "afkpilot.com", target_host: "afkpilot.com" }], error: null });
    const r = await suggestChecks(APP);
    if (!r.ok) throw new Error(r.reason);
    expect(r.suggestions.http.map((h) => !!h.watched)).toEqual([true, false]);
    expect(r.suggestions.ssl?.watched).toBe(true);
  });

  it("offers the dedicated Supabase type even beside old HTTP checks, but never duplicates an existing project monitor", async () => {
    fake.run.mockResolvedValue({ ...found, supabase: { ref: REF, key: PUBLISHABLE }, http: [
      { kind: "http", url: AUTH, name: "Auth", root: false, supabase: "auth", ok: true, ticked: true },
      { kind: "http", url: STORAGE, name: "Storage", root: false, supabase: "storage", ok: true, ticked: true },
    ] });
    fake.monitors.mockResolvedValue({ data: [{ type: "http", target: AUTH }], error: null });
    const offered = await suggestChecks(APP);
    expect(offered.ok && offered.suggestions.http.every(h => !h.watched)).toBe(true);
    fake.monitors.mockResolvedValue({ data: [{ type: "supabase", target: `https://${REF}.supabase.co` }], error: null });
    const watched = await suggestChecks(APP);
    expect(watched.ok && watched.suggestions.http.every(h => h.watched)).toBe(true);
    expect(await addSuggestedChecks(APP, { urls: [AUTH, STORAGE], ssl: false, supabaseKey: PUBLISHABLE })).toEqual({ ok: true, added: 0 });
    expect(fake.testService).not.toHaveBeenCalled();
  });

  it("spends nothing for an app without an address, or with a private one", async () => {
    fake.appRow.mockResolvedValue({ data: { url: null }, error: null });
    expect(await suggestChecks(APP)).toEqual({ ok: false, reason: "Add the app's address first, and Staygreen will suggest its checks." });
    fake.appRow.mockResolvedValue({ data: { url: "http://10.0.0.1/" }, error: null });
    const r = await suggestChecks(APP);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toMatch(/10\.0\.0\.1 is a private address/);
    expect(fake.rpc).not.toHaveBeenCalled();
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("runs nothing once the budget is spent, and says when it comes back", async () => {
    fake.rpc.mockResolvedValue({ data: { ok: false, scope: "member", retryAfterSec: 120 }, error: null });
    const r = await suggestChecks(APP);
    expect(r).toMatchObject({ ok: false, retryAfterSec: 120 });
    expect(fake.run).not.toHaveBeenCalled();
  });

  it("is not found outside the member's workspace, before anything is read or spent", async () => {
    fake.app.mockResolvedValue({ id: APP, workspace: { id: "ws_b", clerk_org_id: "org_b" } });
    expect(await suggestChecks(APP)).toEqual(NOT_FOUND);
    expect(fake.appRow).not.toHaveBeenCalled();
    expect(fake.rpc).not.toHaveBeenCalled();
  });
});

describe("addSuggestedChecks", () => {
  it("saves dependency keywords and current CNAME/NS baselines through the usual scoped transaction", async () => {
    const url = "https://clerk.afkpilot.com/npm/@clerk/clerk-js@6/dist/clerk.browser.js";
    const result = await addSuggestedChecks(APP, { urls: [url], ssl: false, dependencies: [{ url, name: "Clerk frontend", keyword: "Clerk" }], dns: [
      { record: "NS", recordName: "afkpilot.com", expected: "NS2.EXAMPLE.NET. ns1.example.net", name: "Domain nameservers" },
      { record: "CNAME", recordName: "clerk.afkpilot.com", expected: "frontend.clerk.services", name: "Sign-in DNS alias" },
    ] });
    expect(result).toEqual({ ok: true, added: 3 });
    expect(creates()).toEqual([
      expect.objectContaining({ p_type: "http", p_target: url, p_config: expect.objectContaining({ keyword: "Clerk", expect: "2xx" }) }),
      expect.objectContaining({ p_type: "dns", p_target: "NS afkpilot.com", p_config: { record: "NS", name: "afkpilot.com", expected: "ns1.example.net, ns2.example.net" } }),
      expect.objectContaining({ p_type: "dns", p_target: "CNAME clerk.afkpilot.com" }),
    ]);
    for (const row of creates()) expect(row).toMatchObject({ p_workspace_id: ws.id, p_app_id: APP, p_max_monitors: FREE.limits.monitors });
  });
  it("refuses foreign DNS baselines, malformed NS sets and private dependency endpoints", async () => {
    for (const d of [{ record: "NS", recordName: "example.com", expected: "ns1.example.net" }, { record: "CNAME", recordName: "auth.attacker.com", expected: "frontend.clerk.services" }, { record: "NS", recordName: "afkpilot.com", expected: "http://ns1.example.net" }]) {
      expect(await addSuggestedChecks(APP, { urls: [], ssl: false, dns: [{ ...d, name: "DNS" }] })).toMatchObject({ ok: false });
    }
    const url = "https://127.0.0.1/script.js";
    expect(await addSuggestedChecks(APP, { urls: [url], ssl: false, dependencies: [{ url, name: "Frontend", keyword: "Clerk" }] })).toMatchObject({ ok: false });
    expect(creates()).toHaveLength(0);
  });
  it("skips already watched and repeated DNS selections", async () => {
    const ns = { record: "NS", recordName: "afkpilot.com", expected: "ns1.example.net", name: "Nameservers" };
    expect(await addSuggestedChecks(APP, { urls: [], ssl: false, dns: [ns, ns] })).toEqual({ ok: true, added: 1 });
    fake.monitors.mockResolvedValue({ data: [{ type: "dns", target: "NS afkpilot.com" }], error: null });
    expect(await addSuggestedChecks(APP, { urls: [], ssl: false, dns: [ns] })).toEqual({ ok: true, added: 0 });
  });
  it("adds each ticked HTTP check as the add form would, and lets the SSL check come with the HTTPS one", async () => {
    expect(await addSuggestedChecks(APP, { urls: [ADDRESS, "https://afkpilot.com/health"], ssl: true })).toEqual({ ok: true, added: 3 });
    const made = creates();
    expect(made).toHaveLength(2);
    expect(made[0]).toMatchObject({ p_workspace_id: "ws_a", p_app_id: APP, p_type: "http", p_name: "Website", p_target: ADDRESS, p_target_host: "afkpilot.com", p_max_monitors: FREE.limits.monitors });
    expect(made[1]).toMatchObject({ p_type: "http", p_name: "Health check", p_target: "https://afkpilot.com/health" });
    // The SSL check is `create_monitor`'s own, with the first HTTPS check on its host.
    expect(made.some((m) => m.p_type === "ssl")).toBe(false);
    expect(fake.rpc).not.toHaveBeenCalledWith("spend_budget", expect.anything());
  });

  it("adds the SSL check as a monitor of its own when no HTTPS check on its host is ticked", async () => {
    expect(await addSuggestedChecks(APP, { urls: [], ssl: true })).toEqual({ ok: true, added: 1 });
    expect(creates()).toEqual([expect.objectContaining({ p_type: "ssl", p_target: "afkpilot.com", p_target_host: "afkpilot.com" })]);
  });

  it("takes only the addresses the app's own address gives, whatever the browser sends", async () => {
    expect(await addSuggestedChecks(APP, { urls: ["https://evil.example/"], ssl: false })).toEqual({ ok: false, reason: "These checks are for another address. Reload the page." });
    expect(await addSuggestedChecks(APP, { urls: [], ssl: false })).toEqual({ ok: false, reason: "Tick at least one check to add." });
    expect(await addSuggestedChecks(APP, { urls: "all", ssl: true })).toEqual({ ok: false, reason: "Tick the checks to add." });
    expect(creates()).toHaveLength(0);
  });

  it("never adds a check twice", async () => {
    fake.monitors.mockResolvedValue({ data: [{ type: "http", target: ADDRESS, target_host: "afkpilot.com" }, { type: "ssl", target: "afkpilot.com", target_host: "afkpilot.com" }], error: null });
    expect(await addSuggestedChecks(APP, { urls: [ADDRESS, "https://afkpilot.com/health"], ssl: true })).toEqual({ ok: true, added: 1 });
    expect(creates().map((m) => m.p_target)).toEqual(["https://afkpilot.com/health"]);
  });

  it("keeps what was added when a limit stops the rest, and says what stopped it", async () => {
    let n = 0;
    fake.rpc.mockImplementation(async (name: string) =>
      name === "create_monitor" && n++ > 0 ? { data: null, error: { code: "P0001", message: "monitor_limit" } } : { data: null, error: null },
    );
    expect(await addSuggestedChecks(APP, { urls: [ADDRESS, "https://afkpilot.com/health"], ssl: true })).toEqual({
      ok: true,
      added: 1,
      stopped: `Your plan allows ${FREE.limits.monitors} monitors. Builder allows ${limits.builder.monitors}.`,
    });
  });

  it("adds a health route with the assertions it was offered, parsed as the add form's are", async () => {
    const assertions = { "https://afkpilot.com/health": [{ path: "$.status", op: "==", value: "ok" }, { path: "$.checks.db", op: "exists", value: "x" }] };
    expect(await addSuggestedChecks(APP, { urls: ["https://afkpilot.com/health"], ssl: false, assertions })).toEqual({ ok: true, added: 1 });
    expect(creates()[0].p_config).toMatchObject({ assertions: [{ path: "$.status", op: "==", value: "ok" }, { path: "$.checks.db", op: "exists", value: "" }] });
    expect(creates()[0].p_max_assertions).toBe(FREE.limits.assertions);
    // One the parser refuses is refused, as the add form's would be.
    expect(await addSuggestedChecks(APP, { urls: ["https://afkpilot.com/health"], ssl: false, assertions: { "https://afkpilot.com/health": [{ path: "$.a", op: "matches", value: "x" }] } })).toMatchObject({ ok: false });
  });

  it("adds one verified Supabase monitor for either or both service suggestions", async () => {
    for (const urls of [[AUTH, STORAGE], [AUTH], [STORAGE]]) {
      fake.rpc.mockClear();
      expect(await addSuggestedChecks(APP, { urls, ssl: false, supabaseKey: PUBLISHABLE })).toEqual({ ok: true, added: 1 });
      const calls = fake.rpc.mock.calls.filter(([name]) => name === "save_service_monitor");
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toMatchObject({ p_type: "supabase", p_target: `https://${REF}.supabase.co`, p_config: { databaseRead: "" } });
      expect(calls[0][1].p_sealed).toMatch(/^sealed:.*service-key/);
      expect(JSON.stringify(calls)).not.toContain(PUBLISHABLE);
      expect(creates()).toHaveLength(0);
    }
  });

  it("never takes a key for Supabase Auth that isn't provably the project's publishable one", async () => {
    const refused = { ok: false, reason: "This Supabase check needs the project's publishable key. Reload the page." };
    for (const supabaseKey of [
      undefined,
      `sb_secret_${"s".repeat(32)}`,
      jwt({ iss: "supabase", ref: REF, role: "service_role" }),
      jwt({ iss: "supabase", ref: "zzzzzzzzzzzzzzzzzzzz", role: "anon" }),
      "not a key",
    ]) {
      expect(await addSuggestedChecks(APP, { urls: [AUTH], ssl: false, supabaseKey })).toEqual(refused);
    }
    expect(creates()).toHaveLength(0);
  });

  it("takes only a Supabase project's two checks, and one project at a time", async () => {
    const other = "These checks are for another address. Reload the page.";
    expect(await addSuggestedChecks(APP, { urls: [`https://${REF}.supabase.co/rest/v1/`], ssl: false })).toEqual({ ok: false, reason: other });
    expect(await addSuggestedChecks(APP, { urls: [STORAGE, "https://zzzzzzzzzzzzzzzzzzzz.supabase.co/storage/v1/status"], ssl: false })).toEqual({ ok: false, reason: other });
    expect(await addSuggestedChecks(APP, { urls: [`http://${REF}.supabase.co/storage/v1/status`], ssl: false })).toEqual({ ok: false, reason: other });
    expect(creates()).toHaveLength(0);
  });

  it("refuses, adding nothing, when the first check is refused", async () => {
    fake.target.mockResolvedValue({ ok: false, reason: "afkpilot.com resolves to a private address." });
    expect(await addSuggestedChecks(APP, { urls: [ADDRESS], ssl: false })).toMatchObject({ ok: false, reason: "afkpilot.com resolves to a private address." });
    expect(creates()).toHaveLength(0);
  });
});
