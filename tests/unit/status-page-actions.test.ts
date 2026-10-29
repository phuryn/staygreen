import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePage, reservePageDomain, verifyPageDomain, checkPageDomain, removePageDomain } from "@/app/(app)/app/actions";
import { demoSlug, entitlementsFrom, FREE } from "@/lib/plans";

const fake = vi.hoisted(() => ({ member: vi.fn(), resolve: vi.fn(), origin: vi.fn(), rpc: vi.fn(), row: vi.fn(), dns: vi.fn(), withdraw: vi.fn(), probe: vi.fn() }));
vi.mock("@/lib/workspace", async original => ({ ...await original<typeof import("@/lib/workspace")>(), memberOrNull: fake.member, resolvePage: fake.resolve }));
vi.mock("@/lib/request", async original => ({ ...await original<typeof import("@/lib/request")>(), assertSameOrigin: fake.origin }));
vi.mock("@/lib/edge-control", () => ({ withdrawAtEdge: fake.withdraw }));
vi.mock("node:dns/promises", () => ({ Resolver: class { resolveCname = fake.dns; } }));
vi.mock("@/lib/page-domain", async original => ({ ...await original<typeof import("@/lib/page-domain")>(), servesOverTls: fake.probe }));
vi.mock("@/lib/db", () => ({ db: () => { const q = { eq: () => q, select: () => q, delete: () => q, maybeSingle: fake.row }; return { rpc: fake.rpc, from: () => q }; } }));
vi.mock("@/lib/env", async () => { const { serverEnvSchema } = await import("@/lib/env-schema"); return { env: () => ({ STATUS_DOMAIN_SUFFIX: serverEnvSchema.shape.STATUS_DOMAIN_SUFFIX.parse(process.env.STATUS_DOMAIN_SUFFIX) }) }; });
afterEach(() => vi.unstubAllEnvs());
const ws = { id: "ws_a", clerk_org_id: "org_a" };
const member = { workspace: ws, caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" }, entitlements: entitlementsFrom((slug) => slug !== demoSlug) };
const target = `${"a".repeat(32)}.domains.staygreen.io`;
const draft = { slug: "harbor", name: "Harbor", logoText: "", homepage: "", accent: "#1F2DE6", theme: "visitor", poweredBy: true, noindex: false, historyDays: 90, components: [], membersOnly: true };
beforeEach(() => {
  vi.clearAllMocks(); fake.member.mockResolvedValue(member); fake.resolve.mockResolvedValue({ id: "page_a", workspace: ws }); fake.origin.mockResolvedValue(undefined);
  fake.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === "begin_private_page" ? { pageId: "page_a", slug: "harbor", version: 7 } : name === "spend_budget" ? { ok: true } : true }));
  fake.withdraw.mockResolvedValue(true); fake.dns.mockResolvedValue([`${target}.`]);
  fake.row.mockResolvedValue({ data: { host: "status.example.com", cname_target: target, created_at: new Date().toISOString(), verified_at: null, monitor_id: null }, error: null });
});
describe("private publication boundary", () => {
  it("passes the demo choice only for scale_demo and ignores forged flags on every other plan", async () => {
    for (const entitlements of [FREE, member.entitlements]) {
      fake.member.mockResolvedValue({ ...member, entitlements });
      expect(await savePage("page_a", { ...draft, membersOnly: false, demo: true })).toEqual({ ok: true });
      expect(fake.rpc).toHaveBeenLastCalledWith("save_demo_page", expect.objectContaining({ p_demo: null }));
    }
    fake.member.mockResolvedValue({ ...member, entitlements: entitlementsFrom(() => true) });
    for (const demo of [true, false]) {
      expect(await savePage("page_a", { ...draft, membersOnly: false, demo })).toEqual({ ok: true });
      expect(fake.rpc).toHaveBeenLastCalledWith("save_demo_page", expect.objectContaining({ p_demo: demo }));
    }
  });
  it("refuses the contradictory demo/private draft before withdrawing the public copy", async () => {
    fake.member.mockResolvedValue({ ...member, entitlements: entitlementsFrom(() => true) });
    expect(await savePage("page_a", { ...draft, demo: true })).toMatchObject({ ok: false, fieldErrors: { demo: expect.any(String) } });
    expect(fake.rpc).not.toHaveBeenCalled(); expect(fake.withdraw).not.toHaveBeenCalled();
  });
  it("passes the reordered component array to the save transaction without sorting or losing bindings", async () => {
    const components = ["Website", "API", "Database"].map((name, i) => ({ name, inApp: i !== 1, monitorIds: [`mon_${String(i).padStart(24, "0")}`] }));
    expect(await savePage("page_a", { ...draft, membersOnly: false, components })).toEqual({ ok: true });
    expect(fake.rpc).toHaveBeenLastCalledWith("save_demo_page", expect.objectContaining({ p_components: components }));
  });
  it("withdraws before saving private content and supplies the matching version", async () => {
    expect(await savePage("page_a", draft)).toEqual({ ok: true });
    expect(fake.withdraw).toHaveBeenCalledWith("page_a", "harbor", 7);
    expect(fake.rpc).toHaveBeenLastCalledWith("save_demo_page", expect.objectContaining({ p_members_only: true, p_withdrawal_version: 7 }));
    expect(fake.withdraw.mock.invocationCallOrder[0]).toBeLessThan(fake.rpc.mock.invocationCallOrder.at(-1)!);
  });
  it("does not save private edits when the renderer or purge cannot acknowledge", async () => {
    fake.withdraw.mockResolvedValue(false);
    expect(await savePage("page_a", draft)).toMatchObject({ ok: false, reason: expect.stringContaining("Private changes were not saved") });
    expect(fake.rpc.mock.calls.map(c => c[0])).not.toContain("save_demo_page");
  });
  it("keeps an already private page editable after downgrade without a public phase", async () => {
    fake.member.mockResolvedValue({ ...member, entitlements: FREE });
    fake.rpc.mockResolvedValue({ data: null, error: null });
    expect(await savePage("page_a", draft)).toEqual({ ok: true });
    expect(fake.withdraw).not.toHaveBeenCalled();
    expect(fake.rpc).toHaveBeenLastCalledWith("save_demo_page", expect.objectContaining({ p_members_only: true, p_private_pages: false }));
  });
});
describe("custom domain actions", () => {
  it.each([undefined, "domains-dev.example.com"])("issues a fresh claim target with the configured suffix %s", async suffix => {
    vi.stubEnv("STATUS_DOMAIN_SUFFIX", suffix);
    expect(await reservePageDomain("page_a", "status.example.com")).toEqual({ ok: true });
    const target = fake.rpc.mock.calls.find(([name]) => name === "reserve_page_domain")![1].p_cname_target;
    expect(target).toMatch(/^[a-f0-9]{32}\./);
    expect(target.slice(33)).toBe(suffix ?? "domains.staygreen.io");
  });
  it("still verifies a stored production-suffix claim after development changes suffix", async () => {
    vi.stubEnv("STATUS_DOMAIN_SUFFIX", "domains-dev.example.com");
    expect(await verifyPageDomain("page_a")).toEqual({ ok: true, verified: true });
    expect(fake.rpc).toHaveBeenLastCalledWith("verify_page_domain", expect.objectContaining({ p_cname_target: target }));
  });
  it("does not resolve DNS or mutate a foreign workspace", async () => {
    fake.resolve.mockResolvedValue({ id: "page_b", workspace: { id: "ws_b", clerk_org_id: "org_b" } });
    expect(await reservePageDomain("page_b", "status.example.com")).toMatchObject({ ok: false });
    expect(await verifyPageDomain("page_b")).toMatchObject({ ok: false });
    expect(fake.dns).not.toHaveBeenCalled(); expect(fake.rpc).not.toHaveBeenCalled();
  });
  it("checks DNS behind the budget and passes the exact claim timestamp and real monitor quotas", async () => {
    expect(await verifyPageDomain("page_a")).toEqual({ ok: true, verified: true });
    expect(fake.rpc).toHaveBeenLastCalledWith("verify_page_domain", expect.objectContaining({ p_host: "status.example.com", p_created_at: expect.any(String), p_cname_target: target, p_max_monitors: member.entitlements.limits.monitors, p_max_per_host: member.entitlements.limits.monitors }));
    fake.rpc.mockResolvedValue({ data: { ok: false, retryAfterSec: 37 }, error: null }); fake.dns.mockClear();
    expect(await verifyPageDomain("page_a")).toMatchObject({ ok: false, retryAfterSec: 37 });
    expect(fake.dns).not.toHaveBeenCalled();
  });
  it("keeps a wrong or missing CNAME pending, and refuses expired claims", async () => {
    fake.dns.mockResolvedValue(["attacker.example.com"]);
    expect(await verifyPageDomain("page_a")).toEqual({ ok: true, verified: false });
    expect(fake.rpc.mock.calls.map(c => c[0])).not.toContain("verify_page_domain");
    fake.row.mockResolvedValue({ data: { host: "status.example.com", created_at: "2000-01-01T00:00:00Z", verified_at: null }, error: null });
    expect(await verifyPageDomain("page_a")).toMatchObject({ ok: false, reason: expect.stringContaining("expired") });
  });
  it("cannot verify another workspace's replacement claim with a dangling CNAME from the old claim", async () => {
    expect(await verifyPageDomain("page_a")).toEqual({ ok: true, verified: true });
    expect(await removePageDomain("page_a")).toEqual({ ok: true });
    const other = { id: "ws_b", clerk_org_id: "org_b" };
    fake.member.mockResolvedValue({ workspace: other, caller: { userId: "user_b", orgId: "org_b", orgRole: "org:admin" }, entitlements: FREE });
    fake.resolve.mockResolvedValue({ id: "page_b", workspace: other });
    expect(await reservePageDomain("page_b", "status.example.com")).toEqual({ ok: true });
    const newTarget = `${"b".repeat(32)}.domains.staygreen.io`;
    const createdAt = new Date().toISOString();
    fake.row.mockResolvedValue({ data: { host: "status.example.com", cname_target: newTarget, created_at: createdAt, verified_at: null, monitor_id: null }, error: null });
    fake.rpc.mockClear();
    // DNS was left untouched when the first owner removed the claim.
    expect(await verifyPageDomain("page_b")).toEqual({ ok: true, verified: false });
    expect(fake.rpc.mock.calls.map(c => c[0])).not.toContain("verify_page_domain");
    fake.dns.mockResolvedValue(["domains.staygreen.io."]);
    expect(await verifyPageDomain("page_b")).toEqual({ ok: true, verified: false });
    expect(fake.rpc.mock.calls.map(c => c[0])).not.toContain("verify_page_domain");
    // Only control of DNS lets the new claimant complete its own proof.
    fake.dns.mockResolvedValue([`${newTarget.toUpperCase()}.`]);
    expect(await verifyPageDomain("page_b")).toEqual({ ok: true, verified: true });
    expect(fake.rpc).toHaveBeenLastCalledWith("verify_page_domain", expect.objectContaining({ p_workspace_id: other.id,
      p_page_id: "page_b", p_host: "status.example.com", p_created_at: createdAt, p_cname_target: newTarget }));
  });
});
describe("custom domain certificate check", () => {
  const verifiedRow = { host: "status.example.com", cname_target: target, verified_at: new Date().toISOString() };
  it("asks the claim's own target behind the budget and reports whether the domain answers", async () => {
    fake.row.mockResolvedValue({ data: verifiedRow, error: null }); fake.probe.mockResolvedValue(true);
    expect(await checkPageDomain("page_a")).toEqual({ ok: true, live: true });
    expect(fake.probe).toHaveBeenCalledWith("status.example.com", target);
    expect(fake.rpc).toHaveBeenCalledWith("spend_budget", expect.objectContaining({ p_action: "domain_check" }));
    fake.probe.mockResolvedValue(false);
    expect(await checkPageDomain("page_a")).toEqual({ ok: true, live: false });
  });
  it("does not probe before DNS is verified, past the budget, or for another workspace", async () => {
    expect(await checkPageDomain("page_a")).toMatchObject({ ok: false });
    fake.row.mockResolvedValue({ data: verifiedRow, error: null });
    fake.rpc.mockResolvedValue({ data: { ok: false, retryAfterSec: 12 }, error: null });
    expect(await checkPageDomain("page_a")).toMatchObject({ ok: false, retryAfterSec: 12 });
    fake.resolve.mockResolvedValue({ id: "page_b", workspace: { id: "ws_b", clerk_org_id: "org_b" } });
    expect(await checkPageDomain("page_b")).toMatchObject({ ok: false });
    expect(fake.probe).not.toHaveBeenCalled();
  });
});
