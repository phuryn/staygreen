import "server-only";
import { clerkClient, verifyToken } from "@clerk/nextjs/server";
import { TokenVerificationErrorReason } from "@clerk/backend/errors";
import { z } from "zod";
import { AgentError, type AgentPrincipal } from "./agent-contract";
import { agentHash, matchesApiToken, parseApiToken } from "./api-token-crypto";
import { apiEntitlements } from "./api-entitlements";
import { hasPermission, requireWorkspaceAccess } from "./authz";
import { db } from "./db";
import { env } from "./env";
import { mcpOAuthConfig } from "./mcp-oauth-metadata";
import { mask } from "@/checks/mask";

export const clientLabel = (v: string) => mask(v).replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, 160) || "Agent";
export type OAuthIdentity = { userId: string; clientId: string; orgId: string | null; scopes: string[]; issuedAt?: number; expiresAt?: number };
const claims = z.object({ sub: z.string().startsWith("user_").max(256), client_id: z.string().min(1).max(2048), iss: z.url(), exp: z.number().int(), iat: z.number().int().optional(), aud: z.union([z.string(), z.array(z.string())]), scope: z.string().optional(), scp: z.array(z.string()).optional(), org_id: z.string().startsWith("org_").max(256).optional() });
const invalidReasons = new Set<string>([
  TokenVerificationErrorReason.TokenExpired, TokenVerificationErrorReason.TokenInvalid,
  TokenVerificationErrorReason.TokenInvalidAlgorithm, TokenVerificationErrorReason.TokenInvalidAuthorizedParties,
  TokenVerificationErrorReason.TokenInvalidSignature, TokenVerificationErrorReason.TokenNotActiveYet,
  TokenVerificationErrorReason.TokenIatInTheFuture, TokenVerificationErrorReason.TokenVerificationFailed,
  TokenVerificationErrorReason.JWKKidMismatch,
]);
const unavailable = () => new AgentError(503, "authorization_unavailable", "Authorization could not be checked. Try again later.");
const invalid = () => new AgentError(401, "invalid_token", "Sign in through your MCP client or supply a valid workspace API token.");
/** The unverified header only gates a bounded key-list read, never identity. Random kids
 * cannot turn every anonymous request into a Clerk Backend API call. */
export function createOAuthVerifier(loadKeys = async () => ((await (await clerkClient()).jwks.getJwks()).keys ?? []).map(k => k.kid), now = Date.now) {
  let keys = new Set<string>(); let refreshed = -Infinity; let failed = false; let loading: Promise<void> | null = null;
  return async (token: string): Promise<OAuthIdentity | null> => {
    if (token.length > 16384 || token.split(".").length !== 3) return null;
    let kid: unknown;
    try { kid = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()).kid; } catch { return null; }
    if (typeof kid !== "string" || !kid || kid.length > 256) return null;
    if (!keys.has(kid)) {
      if (now() - refreshed >= 60000) {
        loading ??= loadKeys().then(ids => { keys = new Set(ids); failed = false; }, () => { failed = true; }).finally(() => { refreshed = now(); loading = null; });
        await loading;
      } else if (loading) await loading;
      if (failed) throw unavailable();
      if (!keys.has(kid)) return null;
    }
    const { resource, issuer } = mcpOAuthConfig();
    let payload: unknown;
    try { payload = await verifyToken(token, { secretKey: env().CLERK_SECRET_KEY, audience: resource, headerType: ["at+jwt", "application/at+jwt"], clockSkewInMs: 5000 }); }
    catch (e) {
      if (e && typeof e === "object" && "reason" in e && invalidReasons.has(String(e.reason))) return null;
      throw unavailable();
    }
    const p = claims.safeParse(payload);
    if (!p.success || p.data.iss !== issuer || ![p.data.aud].flat().includes(resource) || p.data.exp <= Math.floor(now() / 1000)) return null;
    return { userId: p.data.sub, clientId: p.data.client_id, orgId: p.data.org_id ?? null, scopes: p.data.scp ?? p.data.scope?.split(/\s+/) ?? [], issuedAt: p.data.iat, expiresAt: p.data.exp };
  };
}
export async function spendAgentBudget(key: string, limit: number) {
  const { data, error } = await db().rpc("agent_budget", { p_key: key, p_limit: limit });
  if (error) throw new AgentError(503, "temporarily_unavailable", "The request budget could not be checked. Try again later.");
  if (data > 0) throw new AgentError(429, "rate_limited", "Too many calls. Try again after the indicated delay.", data);
}
export const authDependencies = {
  verify: createOAuthVerifier(),
  async membershipRole(orgId: string, userId: string) {
    try {
      const r = await (await clerkClient()).organizations.getOrganizationMembershipList({ organizationId: orgId, userId: [userId], limit: 1 });
      return r.data.find(x => x.organization.id === orgId && x.publicUserData?.userId === userId)?.role ?? null;
    } catch (e) { if (e && typeof e === "object" && "status" in e && e.status === 404) return null; throw unavailable(); }
  },
  async clientName(clientId: string) {
    // OAuth's verified client id is always kept beside the display name. A client cannot
    // impersonate another grant by supplying initialize/clientInfo or an HTTP header.
    try {
      // client_id is not Clerk's oauthapp_ id. Lookup by exact client id and check it
      // again because nameQuery can also match another application's display name.
      const applications = await (await clerkClient()).oauthApplications.list({ nameQuery: clientId, limit: 100 });
      const app = applications.data.find(a => a.clientId === clientId);
      return app ? `${clientLabel(app.name)} (${clientLabel(clientId)})` : clientLabel(clientId);
    }
    catch { return clientLabel(clientId); }
  },
  entitlements: apiEntitlements,
  budget: spendAgentBudget,
};
export type SeenAgent = (principal: Pick<AgentPrincipal, "actor" | "auth" | "client"> & { workspace?: AgentPrincipal["workspace"]; grant?: Pick<OAuthIdentity, "clientId" | "scopes" | "issuedAt" | "expiresAt"> }) => void;
export async function requireAgent(request: Request, oauth: boolean, seen?: SeenAgent, deps = authDependencies): Promise<AgentPrincipal> {
  const header = request.headers.get("authorization");
  const pepper = env().API_TOKEN_PEPPER;
  let principal: Omit<AgentPrincipal, "entitlements">;
  if (/^Bearer\s+sg_/i.test(header ?? "")) {
    const token = parseApiToken(header);
    if (!token) throw invalid();
    const { data, error } = await db().from("api_tokens").select("id,workspace_id,hash,scope,name,revoked_at").eq("kid", token.kid).maybeSingle();
    if (error) throw unavailable();
    const matches = matchesApiToken(data?.workspace_id ?? "", token.secret, data?.hash ?? "", pepper);
    if (!data || !matches || data.revoked_at !== null) throw invalid();
    const owner = await db().from("workspaces").select("id,clerk_org_id").eq("id", data.workspace_id).single();
    if (owner.error) throw unavailable();
    principal = { workspace: owner.data, actor: data.id, client: clientLabel(data.name), scope: data.scope, auth: "api_token" };
    seen?.(principal);
    await deps.budget(agentHash("admission-token", data.workspace_id, pepper), 120);
    const touched = await db().from("api_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).is("revoked_at", null).or(`last_used_at.is.null,last_used_at.lt.${new Date(Date.now() - 60000).toISOString()}`);
    if (touched.error) throw unavailable();
  } else {
    if (!oauth) throw new AgentError(401, "invalid_token", "REST requires a workspace API token. OAuth access tokens are accepted only at /mcp.");
    const bearer = /^Bearer ([^\s]+)$/i.exec(header ?? "");
    const identity = bearer ? await deps.verify(bearer[1]) : null;
    if (!identity) throw invalid();
    const actor = agentHash("oauth-actor", [identity.orgId, identity.userId, identity.clientId], pepper);
    seen?.({ actor, auth: "oauth", client: clientLabel(identity.clientId), grant: identity });
    // Before live membership, and before ensure_workspace: refused members and brand new
    // users count too. Client registration and token refresh cannot reset this user bucket.
    await deps.budget(agentHash("admission-oauth", identity.userId, pepper), 120);
    if (!identity.orgId) throw new AgentError(403, "organization_required", "Select a workspace when granting access. Reconnect with user:org:read.");
    if (!identity.scopes.includes("user:org:read")) throw new AgentError(403, "insufficient_scope", "Reconnect with user:org:read and select a workspace.");
    const caller = { userId: identity.userId, orgId: identity.orgId, orgRole: await deps.membershipRole(identity.orgId, identity.userId) };
    const ref = { id: "", clerk_org_id: identity.orgId };
    if (!hasPermission(ref, caller, "monitors:read")) throw new AgentError(403, "admin_required", "Your current membership does not allow access to this workspace.");
    const { data, error } = await db().rpc("ensure_workspace", { p_clerk_org_id: identity.orgId });
    if (error || !data) throw unavailable();
    const workspace = { id: data.id, clerk_org_id: data.clerk_org_id };
    requireWorkspaceAccess(workspace, caller, "monitors:read");
    principal = { workspace, actor, scope: "write", auth: "oauth", client: clientLabel(await deps.clientName(identity.clientId)) };
  }
  seen?.(principal);
  const entitlements = await deps.entitlements(principal.workspace.clerk_org_id);
  await deps.budget(agentHash("workspace", principal.workspace.id, pepper), entitlements.limits.apiPerMin);
  return { ...principal, entitlements };
}
