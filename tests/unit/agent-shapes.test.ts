import { beforeEach, describe, expect, it, vi } from "vitest";
import { fitted, inOpenAIRanges, initializeShape, keyNames, legalDate, protocolName, requestShape, resetRanges, SHAPE_BYTES, SHAPES_UNTIL, tokenShape, userAgentProducts } from "@/lib/agent-shapes";

const list = { prefixes: [{ ipv4Prefix: "104.210.139.192/28" }, { ipv6Prefix: "2001:db8::/32" }, { ipv4Prefix: "not an address/8" }] };
const loader = () => vi.fn(async () => Response.json(list));
const from = (ip?: string) => new Request("https://staygreen.test/mcp", { headers: ip ? { "x-nf-client-connection-ip": ip } : {} });
beforeEach(() => resetRanges());

describe("a call's shape names what a client sent, never the values (owner, 2026-10-27)", () => {
  it("keeps key names, sorted and bounded, and marks any other text", () => {
    expect(keyNames({ progressToken: 1, "openai/subject": "v1/abc", "openai/userLocation": { country: "PL" } })).toEqual(["openai/subject", "openai/userLocation", "progressToken"]);
    expect(keyNames({ "a b": 1, "<script>": 2 })).toEqual(["?", "?"]);
    // A name a caller could use to carry a value: an address, an id, a key (review shapes1).
    expect(keyNames({ "203.0.113.5": 1, user_2abcdefghijklmnopqrstuv: 1, "sk-abcdefghijklmnopqrstuvwxyz": 1, abcdefghijklmnopqrstuvwxyz0123: 1 })).toEqual(["?", "?", "?", "?"]);
    expect(keyNames({ "550e8400-e29b-41d4-a716-446655440000": 1, "203.0.113.5.": 1, user_ab12cd34ef: 1, client_id: 1, user_agent: 1 })).toEqual(["?", "?", "?", "client_id", "user_agent"]);
    expect(keyNames({ "11111111-2222-4333-a333-555555555555": 1, client_123456789012345678: 1, client_abcdefghij: 1 })).toEqual(["?", "?", "?"]);
    expect(keyNames(Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i])))).toHaveLength(30);
    expect(keyNames(["x"])).toBeUndefined(); expect(keyNames(undefined)).toBeUndefined();
  });
  it("keeps a user agent's product names and drops its comments, which can name a system", () => {
    expect(userAgentProducts("openai-mcp/1.0.0 (Linux x86_64; user@example.com)")).toBe("openai-mcp/1.0.0");
    expect(userAgentProducts("Mozilla/5.0 (Windows NT 10.0) Chrome/130.0 Safari/537.36")).toBe("Mozilla/5.0 Chrome/130.0 Safari/537.36");
    expect(userAgentProducts(null)).toBeUndefined();
    // An unclosed comment is dropped too, and a token that is an address or a key.
    expect(userAgentProducts("client/1.0 (Linux; 203.0.113.5")).toBe("client/1.0");
    expect(userAgentProducts("client/1.0 203.0.113.5 sk-abcdefghijklmnopqrstuvwxyz host/203.0.113.5")).toBe("client/1.0");
  });
  it("records header names, never their values, and a dated protocol version or 'other'", () => {
    const shape = requestShape(new Request("https://staygreen.test/mcp", { headers: { Authorization: "Bearer secret-token", "MCP-Protocol-Version": "2025-06-18", "User-Agent": "openai-mcp/1.0.0" } }));
    expect(shape.headers).toEqual(["authorization", "mcp-protocol-version", "user-agent"]);
    expect(JSON.stringify(shape)).not.toContain("secret-token");
    expect(shape.protocol_header).toBe("2025-06-18");
    expect(protocolName("drop table")).toBe("other"); expect(protocolName(undefined)).toBe("none");
  });
  it("records initialize's declared client, both protocol versions and capability names", () => {
    expect(initializeShape({ protocolVersion: "2025-11-25", capabilities: { elicitation: {}, roots: { listChanged: true } }, clientInfo: { name: "openai-mcp", version: "1.0.0" } }, "2025-11-25"))
      .toEqual({ client: "openai-mcp", version: "1.0.0", requested: "2025-11-25", agreed: "2025-11-25", capabilities: ["elicitation", "roots"] });
    expect(initializeShape({ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Claude Code", version: "2.1.306-beta.1" } }, "2025-06-18")).toMatchObject({ client: "Claude Code", version: "2.1.306-beta.1" });
    // A declared name or version is kept whole or not at all: an email, an address (a trailing dot
    // included), an id, a UUID, a key or a control character makes it "?" (reviews shapes1-2).
    const as = (name: string, version = "1.0.0") => initializeShape({ protocolVersion: "x", capabilities: {}, clientInfo: { name, version } }, "2025-11-25")!;
    for (const name of ["me@example.com", "client 203.0.113.5.", "client 203.0.113.5.6", "user_2abcdefghijklmnopqrstuv", "550e8400-e29b-41d4-a716-446655440000", "sk-abcdefghijklmnopqrstuvwxyz", "openai-mcp\u0000", "a".repeat(70) + " 203.0.113.5.", "x\uD800", "a".repeat(81)])
      expect(as(name).client).toBe("?");
    expect(as("openai-mcp", "203.0.113.5").version).toBe("?");
    expect(as("x", "y").requested).toBe("other");
  });
  it("records a grant's age, lifetime, scope names and the kind of client id, never the id", () => {
    const now = 2_000_000_000_000;
    expect(tokenShape({ issuedAt: now / 1000 - 600, expiresAt: now / 1000 + 3000, scopes: ["user:org:read", "email"], clientId: "https://chatgpt.com/oauth/x.json" }, now))
      .toEqual({ age_s: 600, lifetime_s: 3600, scopes: ["email", "user:org:read"], client_id: "url" });
    expect(tokenShape({ expiresAt: 1, scopes: [], clientId: "oauthapp_abc" }, now)).toMatchObject({ age_s: null, lifetime_s: null, client_id: "opaque" });
  });
  it("answers whether the caller is in OpenAI's published ranges, keeping no address", async () => {
    const load = loader();
    expect(await inOpenAIRanges(from("104.210.139.200"), load)).toBe(true);
    expect(await inOpenAIRanges(from("104.210.139.250"), load)).toBe(false);
    expect(await inOpenAIRanges(from("2001:db8::1"), load)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await inOpenAIRanges(from(), load)).toBeNull();
    expect(await inOpenAIRanges(from("spoofed"), load)).toBeNull();
  });
  it("answers null when the list can't be read, and asks again on the next call", async () => {
    const fail = vi.fn(async () => { throw new Error("offline"); });
    expect(await inOpenAIRanges(from("104.210.139.200"), fail)).toBeNull();
    expect(await inOpenAIRanges(from("104.210.139.200"), loader())).toBe(true);
  });
  it("stops on the date the privacy policy names", () => {
    expect(legalDate(SHAPES_UNTIL)).toBe("10 November 2026");
  });
  it("fits the column's 4,096-byte check, cutting lists before dropping them", () => {
    const names = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}-${"n".repeat(50)}-${i}`);
    const small = { headers: ["accept"], user_agent: "openai-mcp/1.0.0" };
    expect(fitted(small)).toBe(small);
    const cut = fitted({ headers: names(40, "h"), params: names(30, "p"), meta: names(30, "m"), user_agent: "a/1" });
    expect(cut).toMatchObject({ trimmed: true, user_agent: "a/1" }); expect(cut.headers).toHaveLength(10);
    expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(SHAPE_BYTES);
    const huge = fitted({ headers: names(40, "h".repeat(400)), protocol_header: "none" });
    expect(huge).toEqual({ protocol_header: "none", trimmed: true });
  });
});
