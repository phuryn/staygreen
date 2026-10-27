import "server-only";
import { env } from "./env";

export const MCP_OAUTH_SCOPES = ["openid", "profile", "email", "user:org:read"];
export function mcpOAuthConfig() {
  const e = env();
  // A Clerk publishable key encodes the Frontend API hostname followed by '$'.
  const host = Buffer.from(e.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.replace(/^pk_(test|live)_/, ""), "base64").toString().replace(/\$$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw new Error("Invalid Clerk frontend hostname");
  return { issuer: `https://${host}`, resource: new URL("/mcp", e.APP_URL).href, resourceMetadata: new URL("/.well-known/oauth-protected-resource/mcp", e.APP_URL).href };
}
const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" };
export function mcpResourceMetadata() {
  const { resource, issuer } = mcpOAuthConfig();
  return Response.json({ resource, resource_name: "Staygreen", authorization_servers: [issuer], scopes_supported: MCP_OAUTH_SCOPES, bearer_methods_supported: ["header"] }, { headers });
}
export async function mcpAuthorizationMetadata() {
  try {
    const { issuer } = mcpOAuthConfig();
    const r = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store" });
    if (!r.ok) throw new Error("discovery unavailable");
    const data: unknown = await r.json();
    if (!data || typeof data !== "object" || !("issuer" in data) || data.issuer !== issuer) throw new Error("unexpected issuer");
    return Response.json(data, { headers });
  } catch { return Response.json({ error: "authorization_unavailable" }, { status: 503, headers: { ...headers, "Cache-Control": "no-store" } }); }
}
export function mcpMetadataOptions() { return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS" } }); }
export function mcpBearerChallenge(request: Request) {
  return `Bearer resource_metadata="${mcpOAuthConfig().resourceMetadata}"${request.headers.has("authorization") ? ', error="invalid_token"' : ""}`;
}
