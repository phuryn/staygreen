import { beforeEach, describe, expect, it, vi } from "vitest";
import { runScan, scanDependencies, statusLink } from "@/lib/scan";
import { scanInput } from "@/lib/scan-contract";
import { checkStripe } from "@/checks/stripe";
import type { CheckResult } from "@/checks/types";
import type { ServiceFetch } from "@/checks/service-fetch";

const good: CheckResult = { ok: true, ms: 1 };
const dependencies = () => ({ ...scanDependencies, cert: vi.fn(async () => ({ ...good, detail: { expiresAt: "2027-01-01T00:00:00Z" } })),
  http: vi.fn(async () => good), rdapFetch: vi.fn(async () => ({ error: "No answer" })),
  supabase: vi.fn(async () => good), stripe: vi.fn(async () => good), serviceFetch: vi.fn<ServiceFetch>() });
describe("one-time scan", () => {
  it.each(["http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://metadata.internal", "http://localhost", "https://example.com:22", "https://user:pass@example.com", "https://example.com?key=secret", "file:///etc/passwd"])("refuses %s before any outbound request", async url => {
    const deps = dependencies(); await expect(runScan({ url }, deps)).rejects.toThrow();
    expect(deps.http).not.toHaveBeenCalled(); expect(deps.cert).not.toHaveBeenCalled(); expect(deps.rdapFetch).not.toHaveBeenCalled();
  });
  it("reports unknown and skipped instead of inventing data, without credentials or arbitrary failure text", async () => {
    const deps = dependencies(); const key = "rk_test_" + "a".repeat(24);
    deps.stripe.mockRejectedValue(Error(key));
    const r = await runScan({ url: "https://example.com", stripe_key: key, crons: [{ name: key, schedule: "0 0 * * *", heartbeat: "unknown" }] }, deps);
    expect(r.certificate).toMatchObject({ state: "ok", expires_at: "2027-01-01T00:00:00.000Z" });
    expect(r.domain.state).toBe("unknown"); expect(r.stripe.state).toBe("unknown"); expect(r.supabase.state).toBe("skipped");
    expect(JSON.stringify(r)).not.toContain(key); expect(r.mcp).toBe("Coming soon");
    expect(deps.cert).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: 10 }));
    expect(deps.http).toHaveBeenCalledWith(expect.objectContaining({ timeoutSec: 8 }), expect.objectContaining({ maxBodyBytes: 65536 }));
  });
  it("uses the real Stripe check for a complete 30-day account-wide count and does not expose event objects", async () => {
    const deps = dependencies(); const key = "rk_test_" + "b".repeat(24); const calls: string[] = [];
    const fetch: ServiceFetch = async (url, headers) => {
      calls.push(url); expect(headers.Authorization).toBe(`Bearer ${key}`);
      return url.includes("/customers") ? { status: 403, body: '{"error":{"type":"invalid_request_error"}}' } : { status: 200, body: JSON.stringify({ has_more: false, data: [{ id: "evt_one", type: "invoice.paid", created: Math.floor(Date.now()/1000)-100, pending_webhooks: 0, secret: key }] }) };
    };
    const r = await runScan({ url: "https://example.com", stripe_key: key }, { ...deps, stripe: checkStripe, serviceFetch: fetch });
    expect(r.stripe).toMatchObject({ state: "issue", failed_events: 1, pending_events: 0 });
    expect(calls[1]).toContain("delivery_success=false"); expect(JSON.stringify(r)).not.toMatch(/evt_one|rk_test_/);
  });
  it("caps Stripe pagination independently of the time limit and reports incomplete data as unknown", async () => {
    let calls = 0;
    const fetch: ServiceFetch = async url => { calls++; return url.includes("/customers") ? { status: 403, body: '{"error":{"type":"invalid_request_error"}}' } : { status: 200, body: JSON.stringify({ has_more: true, data: [{ id: `evt_${calls}`, type: "invoice.paid", created: 1, pending_webhooks: 0 }] }) }; };
    const r = await runScan({ url: "https://example.com", stripe_key: "rk_test_" + "b".repeat(24) }, { ...dependencies(), stripe: checkStripe, serviceFetch: fetch });
    expect(calls).toBe(24); expect(r.stripe).toMatchObject({ state: "unknown", failed_events: null });
  });
  it("never treats an incomplete Supabase configuration or privileged key as admissible", () => {
    expect(scanInput.safeParse({ url: "https://example.com", supabase_url: "https://" + "a".repeat(20) + ".supabase.co" }).success).toBe(false);
    expect(scanInput.safeParse({ url: "https://example.com", stripe_key: "sk_live_" + "a".repeat(30) }).success).toBe(false);
  });
  it("discovers links without fetching them and excludes query credentials and executable URLs", () => {
    expect(statusLink('<a href="/status">Status</a>', "https://app.example/")).toBe("https://app.example/status");
    expect(statusLink('<a href="javascript:alert(1)" rel="status">Status</a><a href="https://status.example/?token=secret">x</a>', "https://app.example/")).toBeNull();
  });
});
