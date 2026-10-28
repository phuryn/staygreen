import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentQuery } from "../support/agent-db";
import { demoSlug, FREE, entitlementsFrom } from "@/lib/plans";
import { agentHash, matchesApiToken, newApiToken, parseApiToken } from "@/lib/api-token-crypto";
import { mask } from "@/checks/mask";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), from: vi.fn(), rpc: vi.fn(), applications: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ clerkClient: async () => ({ oauthApplications: { list: mocks.applications } }), verifyToken: mocks.verify }));
vi.mock("@/lib/db", () => ({ db: () => mocks }));
vi.mock("@/lib/env", () => ({ env: () => ({ API_TOKEN_PEPPER: "p".repeat(43), CLERK_SECRET_KEY: "sk_test_fake" }) }));
vi.mock("@/lib/mcp-oauth-metadata", () => ({ mcpOAuthConfig: () => ({ resource: "https://staygreen.test/mcp", issuer: "https://clerk.test" }) }));
vi.mock("@/lib/api-entitlements", () => ({ apiEntitlements: vi.fn() }));
import { authDependencies, createOAuthVerifier, requireAgent, spendAgentBudget } from "@/lib/agent-auth";

const workspace = { id: "ws_" + "a".repeat(24), clerk_org_id: "org_a" };
const identity = { userId: "user_a", orgId: "org_a", clientId: "client_a", scopes: ["user:org:read"] };
const request = (token = "jwt") => new Request("https://staygreen.test/mcp", { headers: { authorization: `Bearer ${token}` } });
const deps = () => ({ verify: vi.fn().mockResolvedValue(identity), membershipRole: vi.fn().mockResolvedValue("org:admin"), clientName: vi.fn().mockResolvedValue("Verified client"), budget: vi.fn().mockResolvedValue(undefined), entitlements: vi.fn().mockResolvedValue(FREE) });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv("SELF_HOSTED_PLAN", undefined); mocks.rpc.mockResolvedValue({ data: workspace, error: null }); });
afterEach(() => vi.unstubAllEnvs());

describe("self-hosted machine workspaces", () => {
  it.each(["oauth", "api_token"])("stores Builder for %s without a dashboard visit, scoped to the credential's workspace", async mode => {
    vi.stubEnv("SELF_HOSTED_PLAN", "builder");
    const token = newApiToken(workspace.id, "p".repeat(43));
    const d = deps();
    d.entitlements.mockResolvedValue(entitlementsFrom(slug => slug !== demoSlug));
    const owner = agentQuery({ ...workspace, plan: "free" });
    const monitors = agentQuery(null);
    mocks.rpc.mockResolvedValue({ data: { ...workspace, plan: "free" }, error: null });
    mocks.from.mockImplementation(table => table === "workspaces" ? owner : table === "monitors" ? monitors : agentQuery({
      id: "tok_a", workspace_id: workspace.id, hash: token.hash, scope: "read", name: "CI", revoked_at: null,
    }));
    const principal = await requireAgent(request(mode === "oauth" ? "jwt" : token.plaintext), mode === "oauth", undefined, d);
    expect(principal.entitlements.plan).toBe("builder");
    expect(owner.update).toHaveBeenCalledExactlyOnceWith({ plan: "builder" });
    expect(owner.eq).toHaveBeenCalledWith("id", workspace.id);
    expect(owner.eq).toHaveBeenCalledWith("plan", "free");
    expect(monitors.update).toHaveBeenCalledTimes(1); // HTTP, TCP and Supabase together; Stripe and MCP stay (`workspace-plan.ts`)
    expect(monitors.eq).toHaveBeenCalledWith("workspace_id", workspace.id);
    expect(d.budget).toHaveBeenLastCalledWith(agentHash("workspace", workspace.id, "p".repeat(43)), 120);
  });

  it("does not write a plan or grant allowances to an unauthenticated caller", async () => {
    vi.stubEnv("SELF_HOSTED_PLAN", "builder");
    const d = deps();
    await expect(requireAgent(new Request("https://staygreen.test/mcp"), true, undefined, d)).rejects.toMatchObject({ status: 401 });
    expect(d.entitlements).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("leaves hosted plan synchronization to the existing member path", async () => {
    await requireAgent(request(), true, undefined, deps());
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("workspace credentials", () => {
  it("attributes OAuth writes to the registered name matched by client id, never a submitted name", async () => {
    mocks.applications.mockResolvedValue({ data: [{ clientId: "other", name: "client_a" }, { clientId: "client_a", name: "Claude Code" }] });
    expect(await authDependencies.clientName("client_a")).toBe("Claude Code (client_a)");
    expect(mocks.applications).toHaveBeenCalledWith({ nameQuery: "client_a", limit: 100 });
  });
  it("stores an owner-bound HMAC, parses strictly and masks the issued secret", () => {
    const token = newApiToken(workspace.id, "pepper");
    const parsed = parseApiToken(`Bearer ${token.plaintext}`)!;
    expect(token.hash).not.toContain(parsed.secret);
    expect(matchesApiToken(workspace.id, parsed.secret, token.hash, "pepper")).toBe(true);
    expect(matchesApiToken("other", parsed.secret, token.hash, "pepper")).toBe(false);
    expect(matchesApiToken(workspace.id, parsed.secret, token.hash, "other pepper")).toBe(false);
    expect(matchesApiToken(workspace.id, parsed.secret, "", "pepper")).toBe(false);
    expect(mask(token.plaintext)).not.toContain(parsed.secret);
    for (const bad of [token.plaintext, `Bearer ${token.plaintext} extra`, `Bearer ${token.plaintext.slice(0,-1)}`]) expect(parseApiToken(bad)).toBeNull();
    expect(agentHash("token", "a", "p")).not.toBe(agentHash("request", "a", "p"));
  });
  it("creates a first OAuth workspace only after admission and current admin membership", async () => {
    const d = deps(); const events: string[] = [];
    d.budget.mockImplementation(async () => { events.push("budget"); });
    d.membershipRole.mockImplementation(async () => { events.push("membership"); return "org:admin"; });
    mocks.rpc.mockImplementation(async () => { events.push("ensure"); return { data: workspace }; });
    const p = await requireAgent(request(), true, undefined, d);
    expect(events).toEqual(["budget", "membership", "ensure", "budget"]);
    expect(p).toMatchObject({ workspace, scope: "write", auth: "oauth", client: "Verified client" });
    expect(mocks.rpc).toHaveBeenCalledWith("ensure_workspace", { p_clerk_org_id: "org_a" });
    expect(d.budget.mock.calls.map(c => c[1])).toEqual([120, 30]);
    expect(d.entitlements).toHaveBeenCalledWith("org_a");
  });
  it.each([null, "org:member"])("refuses removed or demoted members (%s) before workspace creation", async role => {
    const d = deps(); d.membershipRole.mockResolvedValue(role);
    await expect(requireAgent(request(), true, undefined, d)).rejects.toMatchObject({ status: 403 });
    expect(d.budget).toHaveBeenCalledTimes(1); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("counts denied calls before membership, with no reset from client or organization changes", async () => {
    const d = deps(); d.budget.mockRejectedValue({ status: 429 });
    await expect(requireAgent(request(), true, undefined, d)).rejects.toMatchObject({ status: 429 });
    expect(d.membershipRole).not.toHaveBeenCalled();
    expect(d.budget).toHaveBeenCalledWith(agentHash("admission-oauth", identity.userId, "p".repeat(43)), 120);
  });
  it.each([{ ...identity, orgId: null }, { ...identity, scopes: [] }])("requires organization selection and its scope", async value => {
    const d = deps(); d.verify.mockResolvedValue(value);
    await expect(requireAgent(request(), true, undefined, d)).rejects.toMatchObject({ status: 403 });
    expect(d.membershipRole).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("does not accept OAuth on REST or cookies as a bearer credential", async () => {
    const d = deps();
    await expect(requireAgent(request(), false, undefined, d)).rejects.toMatchObject({ status: 401 });
    await expect(requireAgent(new Request("https://staygreen.test/mcp", { headers: { cookie: "__session=fake" } }), true, undefined, d)).rejects.toMatchObject({ status: 401 });
    expect(d.verify).not.toHaveBeenCalled();
  });
  it("preserves token scope, uses its owner and shares the workspace's Builder budget", async () => {
    const token = newApiToken(workspace.id, "p".repeat(43)); const d = deps();
    d.entitlements.mockResolvedValue(entitlementsFrom((slug) => slug !== demoSlug));
    mocks.from.mockImplementation(table => agentQuery(table === "workspaces" ? workspace : { id: "tok_a", workspace_id: workspace.id, hash: token.hash, scope: "read", name: "CI", revoked_at: null }));
    const p = await requireAgent(request(token.plaintext), false, undefined, d);
    expect(p.scope).toBe("read"); expect(p.client).toBe("CI"); expect(d.membershipRole).not.toHaveBeenCalled();
    expect(d.budget).toHaveBeenLastCalledWith(agentHash("workspace", workspace.id, "p".repeat(43)), 120);
  });
  it.each(["revoked", "wrong secret", "unknown"])("refuses a %s token", async reason => {
    const token = newApiToken(workspace.id, "p".repeat(43)); const d = deps();
    mocks.from.mockReturnValue(agentQuery(reason === "unknown" ? null : { workspace_id: workspace.id, hash: reason === "wrong secret" ? "0".repeat(64) : token.hash, revoked_at: reason === "revoked" ? "today" : null }));
    await expect(requireAgent(request(token.plaintext), true, undefined, d)).rejects.toMatchObject({ status: 401 });
    expect(d.budget).not.toHaveBeenCalled();
  });
  it("propagates Retry-After and treats a budget outage as unavailable", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: 17 }).mockResolvedValueOnce({ error: { message: "private database failure" } });
    await expect(spendAgentBudget("k", 30)).rejects.toMatchObject({ status: 429, retryAfter: 17 });
    await expect(spendAgentBudget("k", 30)).rejects.toMatchObject({ status: 503 });
  });
});

describe("verified OAuth JWTs", () => {
  const now = 2_000_000_000_000;
  const token = (kid = "known") => Buffer.from(JSON.stringify({ kid })).toString("base64url") + ".payload.signature";
  const payload = { sub: "user_a", org_id: "org_a", client_id: "client_a", iss: "https://clerk.test", aud: "https://staygreen.test/mcp", exp: now/1000+100, scope: "openid user:org:read" };
  it("verifies signature, at+jwt type, audience and issuer before producing identity", async () => {
    mocks.verify.mockResolvedValue(payload);
    const verify = createOAuthVerifier(async () => ["known"], () => now);
    expect(await verify(token())).toEqual({ ...identity, scopes: ["openid", "user:org:read"], expiresAt: payload.exp });
    // Issue and expiry times feed the call log's grant age and lifetime (`agent-shapes.ts`).
    mocks.verify.mockResolvedValue({ ...payload, iat: now / 1000 - 60 });
    expect(await verify(token())).toMatchObject({ issuedAt: now / 1000 - 60, expiresAt: payload.exp });
    expect(mocks.verify).toHaveBeenCalledWith(token(), expect.objectContaining({ audience: payload.aud, headerType: ["at+jwt", "application/at+jwt"] }));
  });
  it.each([{ iss: "https://other.test" }, { aud: "https://other.test/mcp" }, { exp: now/1000-1 }, { client_id: undefined }, { sub: "org_a" }])("refuses mismatched or incomplete verified claims %j", async changes => {
    mocks.verify.mockResolvedValue({ ...payload, ...changes });
    expect(await createOAuthVerifier(async () => ["known"], () => now)(token())).toBeNull();
  });
  it("bounds concurrent and random kid refreshes to one per minute", async () => {
    let clock = now; const keys = vi.fn(async () => ["known"]); const verify = createOAuthVerifier(keys, () => clock);
    await Promise.all(Array.from({ length: 20 }, (_, i) => verify(token(String(i)))));
    expect(keys).toHaveBeenCalledTimes(1); expect(mocks.verify).not.toHaveBeenCalled();
    clock += 60001; await verify(token("next")); expect(keys).toHaveBeenCalledTimes(2);
  });
  it("separates invalid signatures from a JWKS/network outage", async () => {
    mocks.verify.mockRejectedValueOnce({ reason: "token-invalid-signature" });
    expect(await createOAuthVerifier(async () => ["known"], () => now)(token())).toBeNull();
    mocks.verify.mockRejectedValueOnce(new Error("network"));
    await expect(createOAuthVerifier(async () => ["known"], () => now)(token())).rejects.toMatchObject({ status: 503 });
    const keys = vi.fn().mockRejectedValue(new Error("offline")); const verify = createOAuthVerifier(keys, () => now);
    await expect(verify(token())).rejects.toMatchObject({ status: 503 });
    await expect(verify(token("next"))).rejects.toMatchObject({ status: 503 }); expect(keys).toHaveBeenCalledTimes(1);
  });
});
