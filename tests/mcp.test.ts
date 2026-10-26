import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serveMcp } from "../src/mcp";
import { LINE_LIMIT, MCP_INSTRUCTIONS, MCP_TOOLS, MCP_VERSIONS } from "../src/contract";

const token = `sg_${"a".repeat(24)}.${"b".repeat(43)}`;
const request = (method: string, params?: unknown, id: string | number = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const tool = (name = "get_status", args: unknown = {}, id: string | number = 1) => request("tools/call", { name, arguments: args }, id);
const init = (protocolVersion = MCP_VERSIONS[0]) => request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });
async function exchange(messages: unknown[], options: { token?: string; fetcher?: typeof fetch; origin?: string } = {}) {
  let stdout = "";
  const output = new Writable({ write(chunk, _encoding, done) { stdout += chunk.toString(); done(); } });
  await serveMcp({ input: Readable.from(messages.map(message => typeof message === "string" ? message : JSON.stringify(message) + "\n")), output,
    origin: options.origin, env: { STAYGREEN_API_TOKEN: options.token }, fetcher: options.fetcher ?? vi.fn<typeof fetch>().mockRejectedValue(Error("Unexpected network")) });
  const replies = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  for (const reply of replies) expect(reply.jsonrpc).toBe("2.0");
  return { stdout, replies };
}
const error = (reply: { result: { content: { text: string }[] } }) => JSON.parse(reply.result.content[0].text).error;
afterEach(() => { vi.restoreAllMocks(); });

describe("stdio MCP", () => {
  it("allows initialize, ping and exact tool discovery without credentials or network", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { replies } = await exchange([init(), request("ping"), request("tools/list"), { jsonrpc: "2.0", method: "notifications/initialized" }], { fetcher });
    expect(replies).toHaveLength(3);
    expect(replies[0].result).toEqual({ protocolVersion: MCP_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: "staygreen", title: "Staygreen", version: "1.0.0" }, instructions: MCP_INSTRUCTIONS });
    expect(replies[1].result).toEqual({}); expect(replies[2].result.tools).toEqual(MCP_TOOLS);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([...MCP_VERSIONS, "unknown", "2024-11-05"])("negotiates protocol %s", async version => {
    const { replies } = await exchange([init(version)]);
    expect(replies[0].result.protocolVersion).toBe(MCP_VERSIONS.includes(version) ? version : MCP_VERSIONS[0]);
  });
  it.each(MCP_TOOLS.filter(t => t.name !== "scan_app").map(t => t.name))("requires an environment token for %s", async name => {
    const fetcher = vi.fn<typeof fetch>(); const { replies } = await exchange([tool(name)], { fetcher });
    expect(replies[0].result.isError).toBe(true); expect(replies[0].result.structuredContent).toBeUndefined();
    expect(error(replies[0])).toMatchObject({ code: "missing_token", message: expect.stringContaining("/app/agents") });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses public scan without a token and authenticated scan with one", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ checked_at: "now" }));
    await exchange([tool("scan_app", { url: "https://example.com" })], { fetcher });
    await exchange([tool("scan_app", { url: "https://example.com" })], { fetcher, token });
    expect(String(fetcher.mock.calls[0][0])).toBe("https://staygreen.io/api/scan");
    expect(fetcher.mock.calls[0][1]?.headers).not.toHaveProperty("Authorization");
    expect(String(fetcher.mock.calls[1][0])).toBe("https://staygreen.io/api/v1/scan_app");
    expect(fetcher.mock.calls[1][1]?.headers).toHaveProperty("Authorization", `Bearer ${token}`);
  });
  it("sends only to the selected origin and returns the hosted success envelope", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ apps: [] }));
    const { replies, stdout } = await exchange([tool()], { token, fetcher, origin: "https://selected.test" });
    expect(String(fetcher.mock.calls[0][0])).toBe("https://selected.test/api/v1/get_status");
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: `Bearer ${token}` }, body: "{}" });
    expect(replies[0].result).toEqual({ content: [{ type: "text", text: '{"apps":[]}' }], structuredContent: { apps: [] }, isError: false });
    expect(stdout).not.toContain(token);
  });
  it("keeps allowed write arguments byte-for-byte, including the retry id", async () => {
    const args = { request_id: "bd395167-822a-4ee7-ae1b-8991ef0c35f8", url: "https://example.com", crons_from: [{ name: "daily", schedule: "0 0 * * *" }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ created: true }));
    await exchange([tool("provision_app", args)], { token, fetcher });
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify(args));
  });
  it.each([
    ["get_status", { app: "wrong" }], ["get_status", { extra: true }], ["list_monitors", { limit: 101 }],
    ["list_monitors", { limit: 1.5 }], ["pause", { request_id: "bad", minutes: 1441 }],
    ["create_monitor", { request_id: "bd395167-822a-4ee7-ae1b-8991ef0c35f8", app: `app_${"a".repeat(24)}`, type: "http", target: "https://example.com", config: { headers: [{ name: "X-Test", value: "v", extra: true }] } }],
    ["provision_app", { request_id: "bd395167-822a-4ee7-ae1b-8991ef0c35f8", url: "not a URL" }],
    ["get_incidents", { since: "yesterday" }], ["scan_app", { url: "https://example.com", crons: [{ name: "n", schedule: "s", heartbeat: "invalid" }] }],
  ])("refuses schema-invalid %s arguments before fetch", async (name, args) => {
    const fetcher = vi.fn<typeof fetch>(); const { replies } = await exchange([tool(name as string, args)], { token, fetcher });
    expect(error(replies[0])).toEqual({ code: "invalid_arguments", message: "Check the documented inputs. Unknown fields are refused." });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves bounded REST error fields, without structuredContent or raw extra fields", async () => {
    const body = { error: { code: "plan_limit", message: "Nothing created.", details: { not_created: ["app"] }, retry_after: 17 }, debug: "private" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status: 409 }));
    const { replies, stdout } = await exchange([tool()], { token, fetcher });
    expect(replies[0].result).toEqual({ content: [{ type: "text", text: JSON.stringify({ error: body.error }) }], isError: true });
    expect(stdout).not.toContain("private");
  });
  it.each(["network", "body", "refusal", "success", "id"])("never emits the token through %s", async scenario => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (scenario === "network") throw Error(`Authorization: Bearer ${token}`);
      if (scenario === "body") return new Response(new ReadableStream({ start(controller) { controller.error(Error(token)); } }));
      if (scenario === "refusal") return Response.json({ error: { code: "invalid_token", message: token, details: { [token]: [token] } }, debug: token }, { status: 401 });
      return Response.json({ apps: [], echo: token, [token]: token });
    });
    const { stdout, replies } = await exchange([tool("get_status", {}, scenario === "id" ? token : 1)], { token, fetcher });
    expect(stdout).not.toContain(token); expect(JSON.stringify(replies)).not.toContain(token);
    expect(stderr).not.toHaveBeenCalled();
    if (["network", "body", "refusal"].includes(scenario)) expect(replies[0].result.isError).toBe(true);
  });
  it.each(["constructor", "__proto__", "delete_monitor", "//other.test"])("refuses unknown tool %s", async name => {
    const { replies } = await exchange([tool(name)]); expect(replies[0].error).toEqual({ code: -32602, message: "Unknown tool" });
  });
  it("returns hosted RPC errors and recovers at the next newline", async () => {
    const { replies } = await exchange(["{\n", request("unknown"), [], { jsonrpc: "2.0", method: "ping" }, request("initialize"), request("tools/call", { name: 7 }), request("ping")]);
    expect(replies.map(r => r.error?.code ?? 0)).toEqual([-32700, -32601, -32600, -32600, -32602, -32602, 0]);
    expect(replies[0].id).toBeNull();
  });
  it("bounds a chunked unterminated line and discards only that line", async () => {
    const { replies } = await exchange(["x".repeat(LINE_LIMIT - 1), "é".repeat(LINE_LIMIT), "tail\n", request("ping")]);
    expect(replies).toHaveLength(2); expect(replies[0].error).toEqual({ code: -32600, message: "Invalid Request" }); expect(replies[1].result).toEqual({});
  });
  it("counts bytes, decodes split UTF-8 and accepts CRLF and a final line", async () => {
    const encoded = Buffer.from(JSON.stringify(request("ping", undefined, "zażółć")) + "\r\n");
    let stdout = "";
    await serveMcp({ input: Readable.from([...encoded].map(b => Buffer.from([b]))), output: new Writable({ write(c, _, done) { stdout += c; done(); } }), env: {} });
    expect(JSON.parse(stdout).id).toBe("zażółć");
    expect((await exchange([JSON.stringify(request("ping"))])).replies[0].result).toEqual({});
  });
  it("cancels an in-flight fetch by its typed id and keeps the connection usable", async () => {
    const input = new PassThrough(); const output = new PassThrough(); let stdout = "";
    output.on("data", chunk => { stdout += chunk; });
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      signal = options?.signal as AbortSignal;
      signal.addEventListener("abort", () => reject(Error(token)), { once: true });
    }));
    const running = serveMcp({ input, output, env: { STAYGREEN_API_TOKEN: token }, fetcher });
    input.write(JSON.stringify(tool("get_status", {}, "pending")) + "\n");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "pending", reason: token } }) + "\n");
    input.end(JSON.stringify(request("ping", undefined, 2)) + "\n"); await running;
    expect(signal?.aborted).toBe(true); expect(stdout.trim().split("\n").map(l => JSON.parse(l))).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);
  });
  it("turns an oversized streamed response into a tool error", async () => {
    const cancelled = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(100_000)); }, cancel: cancelled })));
    const { replies } = await exchange([tool()], { token, fetcher });
    expect(error(replies[0]).code).toBe("response_too_large"); expect(cancelled).toHaveBeenCalled();
  });
  it.each([null, [], "unexpected"])("refuses a non-object success %j instead of invalid structuredContent", async data => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(data));
    const { replies } = await exchange([tool()], { token, fetcher });
    expect(error(replies[0]).code).toBe("invalid_response"); expect(replies[0].result.structuredContent).toBeUndefined();
  });
  it("handles a broken output stream without an unhandled stream error", async () => {
    const output = new Writable({ write(_chunk, _encoding, done) { done(Error("closed pipe")); } });
    await expect(serveMcp({ input: Readable.from([JSON.stringify(request("ping")) + "\n"]), output, env: {} })).rejects.toThrow("closed pipe");
  });
});
