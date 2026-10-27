import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => mock }));
vi.mock("@/lib/env", () => ({ env: () => ({ APP_URL: "https://staygreen.test", API_TOKEN_PEPPER: "test-pepper" }) }));
import { publicScan } from "@/lib/scan-route";
import { admitScan, scanActor, scanIp } from "@/lib/scan-admission";
import { AgentError } from "@/lib/agent-contract";
const request = (body = JSON.stringify({ url: "https://example.com" }), headers = {}) => new Request("https://staygreen.test/api/scan", { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });
const deps = () => ({ admit: vi.fn(async () => {}), ip: () => "203.0.113.1", scan: vi.fn(async () => ({ checked_at: "now" }) as never) });
beforeEach(() => vi.clearAllMocks());
it("admits before network, sets no-store, and never reads credentials or cookies for public authority", async () => {
  const d = deps(); const order: string[] = []; d.admit.mockImplementation(async () => { order.push("admit"); }); d.scan.mockImplementation(async () => { order.push("scan"); return {} as never; });
  const r = await publicScan(request(undefined, { Cookie: "__session=foreign" }), d);
  expect(r.status).toBe(200); expect(order).toEqual(["admit", "scan"]); expect(r.headers.get("Cache-Control")).toBe("no-store");
});
it("fails closed on unavailable and spent budgets before outbound work", async () => {
  for (const error of [new AgentError(429, "rate_limited", "Wait", 45), Error("database secret")]) {
    const d = deps(); d.admit.mockRejectedValue(error); const r = await publicScan(request(), d);
    expect(r.status).toBe(error instanceof AgentError ? 429 : 503); expect(d.scan).not.toHaveBeenCalled();
    expect(await r.text()).not.toContain("database secret"); if (r.status === 429) expect(r.headers.get("Retry-After")).toBe("45");
  }
});
it.each([["{}", { "sec-fetch-site": "cross-site" }, 403], ["{}", { Origin: "null" }, 403], ["broken", {}, 400], ["{}", { "Content-Type": "text/plain" }, 415], ['"' + "x".repeat(65536) + '"', {}, 413], [JSON.stringify({ url: "http://127.0.0.1" }), {}, 400]])("refuses malformed, oversized or cross-origin input", async (body, headers, status) => {
  const d = deps(); const r = await publicScan(request(body as string, headers), d); expect(r.status).toBe(status); expect(d.admit).not.toHaveBeenCalled(); expect(d.scan).not.toHaveBeenCalled();
});
it("trusts only the platform client address and hashes it before database admission", async () => {
  expect(() => scanIp(request(undefined, { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "1.2.3.4" }), true)).toThrow();
  expect(scanIp(request(undefined, { "x-nf-client-connection-ip": "2001:4860:0000::1" }), true)).toBe("[2001:4860::1]");
  expect(scanActor("ip", "1.2.3.4", "pepper")).toMatch(/^ip:[a-f0-9]{64}$/);
  mock.rpc.mockResolvedValue({ data: 0 }); await admitScan("ip", "1.2.3.4"); expect(JSON.stringify(mock.rpc.mock.calls)).not.toContain("1.2.3.4");
  mock.rpc.mockResolvedValue({ data: 40 }); await expect(admitScan("ip", "1.2.3.4")).rejects.toMatchObject({ status: 429, retryAfter: 40 });
  mock.rpc.mockResolvedValue({ error: { message: "secret" } }); await expect(admitScan("ip", "1.2.3.4")).rejects.toMatchObject({ status: 503 });
});
