import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentError, type AgentPrincipal } from "@/lib/agent-contract";
import { FREE } from "@/lib/plans";
const mocks = vi.hoisted(() => {
  // A call log is one insert, awaited after the reply.
  const insert = vi.fn((_row: unknown) => Promise.resolve({ error: null }));
  return { authenticate: vi.fn(), execute: vi.fn(), after: vi.fn(), insert };
});
vi.mock("@/lib/agent-auth", () => ({ requireAgent: mocks.authenticate }));
vi.mock("@/lib/agent-service", () => ({ executeAgentTool: mocks.execute }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/db", () => ({ db: () => ({ from: () => ({ insert: mocks.insert }) }) }));
vi.mock("@/lib/env", () => ({ env: () => ({ APP_URL: "https://staygreen.test", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_" + Buffer.from("clerk.test$").toString("base64") }) }));
import { BODY_LIMIT, mcpRequest, restRequest } from "@/lib/agent-transport";
import * as route from "@/app/mcp/route";
import { mcpResourceMetadata, mcpAuthorizationMetadata } from "@/lib/mcp-oauth-metadata";
const p: AgentPrincipal = { workspace: { id: "ws_a", clerk_org_id: "org_a" }, actor: "actor", client: "CI", scope: "read", auth: "api_token", entitlements: FREE };
const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const request = (body: unknown, extra: Record<string,string> = {}) => new Request("https://staygreen.test/mcp", { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_status", arguments: {} } };
beforeEach(() => { vi.clearAllMocks(); mocks.authenticate.mockResolvedValue(p); mocks.execute.mockResolvedValue({ apps: [] }); });

describe("authenticated transports", () => {
  it.each(["POST", "GET", "HEAD", "OPTIONS", "DELETE", "PATCH", "PUT"])("authenticates MCP %s before parsing or dispatch", async method => {
    mocks.authenticate.mockRejectedValue(new AgentError(401, "invalid_token", "Sign in"));
    const r = await mcpRequest(new Request("https://staygreen.test/mcp", { method }));
    expect(r.status).toBe(401); expect(r.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://staygreen.test/.well-known/oauth-protected-resource/mcp"');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not mistake Next's route context for a dependency override", async () => {
    const post = route.POST as (r: Request, context: unknown) => Promise<Response>;
    const r = await post(request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "Untrusted", version: "1" }, capabilities: {} } }), { params: Promise.resolve({}) });
    expect(r.status).toBe(200); expect((await r.json()).result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "staygreen" } });
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), true, expect.any(Function));
  });
  it("returns identical text and structured success; errors have only text", async () => {
    const success = await (await mcpRequest(request(call))).json();
    expect(JSON.parse(success.result.content[0].text)).toEqual(success.result.structuredContent);
    mocks.execute.mockRejectedValueOnce(new AgentError(409, "plan_limit", "Nothing created", undefined, { not_created: ["app"] }));
    const error = await (await mcpRequest(request(call))).json();
    expect(error.result.isError).toBe(true); expect(error.result).not.toHaveProperty("structuredContent");
    expect(JSON.parse(error.result.content[0].text).error).toMatchObject({ code: "plan_limit", details: { not_created: ["app"] } });
  });
  it("accepts params._meta, as ChatGPT and progress tokens send it, and passes none of it on", async () => {
    const _meta = { progressToken: 7, "openai/subject": "v1/abc", "openai/session": "s1", "openai/userLocation": { country: "PL" } };
    const r = await (await mcpRequest(request({ ...call, params: { ...call.params, _meta } }))).json();
    expect(r.result.isError).toBe(false);
    expect(mocks.execute).toHaveBeenCalledWith(p, "get_status", {});
    // Any other key beside name and arguments is still refused.
    const extra = await (await mcpRequest(request({ ...call, params: { ...call.params, cursor: "x" } }))).json();
    expect(extra.error).toMatchObject({ code: -32602, message: "Invalid params" });
  });
  it("refuses capabilities outside the ten tools, including prototype names", async () => {
    for (const name of ["delete_monitor", "publish_note", "create_token", "constructor", "__proto__"]) {
      const r = await (await mcpRequest(request({ ...call, params: { name } }))).json();
      expect(r.error.code).toBe(-32602);
      expect((await restRequest(request({}), name)).status).toBe(404);
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("applies the origin check with fetch metadata taking precedence", async () => {
    expect((await mcpRequest(request(call, { "sec-fetch-site": "cross-site", origin: "https://staygreen.test" }))).status).toBe(403);
    expect((await mcpRequest(request(call, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await mcpRequest(request(call, { origin: "null" }))).status).toBe(403);
    expect((await mcpRequest(request(call, { "sec-fetch-site": "same-origin", origin: "null" }))).status).toBe(200);
    expect((await mcpRequest(request(call))).status).toBe(200);
  });
  it("caps streamed bodies even with absent or understated Content-Length", async () => {
    for (const length of [undefined, "1"]) {
      const r = request({ pad: "x".repeat(BODY_LIMIT) }, length ? { "content-length": length } : {});
      expect((await restRequest(r, "get_status")).status).toBe(413);
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("returns 415 for non-JSON and 400 for malformed JSON and protocol headers", async () => {
    expect((await restRequest(request({}, { "content-type": "text/plain" }), "get_status")).status).toBe(415);
    expect((await mcpRequest(new Request("https://staygreen.test/mcp", { method: "POST", headers, body: "{" }))).status).toBe(400);
    expect((await mcpRequest(request(call, { "mcp-protocol-version": "wrong" }))).status).toBe(400);
    expect((await mcpRequest(request(call, { accept: "text/html" }))).status).toBe(406);
  });
  it("returns 429 with Retry-After before dispatch when the workspace budget is spent", async () => {
    mocks.authenticate.mockRejectedValue(new AgentError(429, "rate_limited", "Wait", 42));
    for (const run of [() => mcpRequest(request(call)), () => restRequest(request({}), "get_status")]) {
      const r = await run(); expect(r.status).toBe(429); expect(r.headers.get("retry-after")).toBe("42");
    }
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("uses token-only authentication for REST, including unknown paths and verbs", async () => {
    expect((await restRequest(new Request("https://staygreen.test/api/v1/get_status"), "get_status")).status).toBe(405);
    expect((await restRequest(request({}), "missing")).status).toBe(404);
    expect(mocks.authenticate.mock.calls.every(c => c[1] === false)).toBe(true);
  });
  it("never reflects unexpected provider exceptions", async () => {
    mocks.execute.mockRejectedValue(new Error("secret private-host credential"));
    const r = await restRequest(request({}), "get_status"); expect(r.status).toBe(503);
    expect(await r.text()).not.toMatch(/private-host|credential/);
  });
});

describe("call logs", () => {
  const rows = async () => { for (const [task] of mocks.after.mock.calls) await task(); return mocks.insert.mock.calls.map(([row]) => row as Record<string, unknown>); };
  // Call shapes were recorded until 2026-11-10 and their column is dropped (migration 20261117150000):
  // a log is one plain row, and nothing a client sends in params._meta reaches it.
  it("writes one plain row per call, MCP and REST, with no shape and no _meta value", async () => {
    const _meta = { progressToken: 7, "openai/subject": "subject-value", "openai/session": "session-value" };
    await mcpRequest(request({ ...call, params: { ...call.params, _meta } }));
    await restRequest(new Request("https://staygreen.test/api/v1/get_status", { method: "POST", headers, body: "{}" }), "get_status");
    const logged = await rows();
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({ source: "mcp", method: "tools/call", tool: "get_status", status: 200, outcome: "ok" });
    expect(logged[1]).toMatchObject({ source: "rest", tool: "get_status", status: 200 });
    for (const row of logged) expect(row).not.toHaveProperty("shape");
    expect(JSON.stringify(logged)).not.toMatch(/subject-value|session-value|openai\//);
  });
});

describe("OAuth discovery", () => {
  it("publishes the exact resource audience, organization scope and Clerk issuer", async () => {
    expect(await mcpResourceMetadata().json()).toMatchObject({ resource: "https://staygreen.test/mcp", authorization_servers: ["https://clerk.test"], scopes_supported: expect.arrayContaining(["user:org:read"]) });
  });
  it("does not cache an upstream failure or trust a different discovery issuer", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ issuer: "https://evil.test" }));
    const r = await mcpAuthorizationMetadata(); expect(r.status).toBe(503); expect(r.headers.get("cache-control")).toBe("no-store"); fetch.mockRestore();
  });
});
