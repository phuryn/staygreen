import { beforeEach, describe, expect, it, vi } from "vitest";
import { dnsRecordName, servesOverTls } from "@/lib/page-domain";

const fake = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: fake.request }));

type Outcome = { status: number } | "error" | "timeout";
function answer(outcome: Outcome) {
  fake.request.mockImplementation((_opts: unknown, onResponse: (res: { statusCode: number; resume: () => void }) => void) => {
    const on: Record<string, () => void> = {};
    const req = {
      on: (event: string, fn: () => void) => { on[event] = fn; return req; },
      destroy: vi.fn(() => on.error?.()),
      end: () => queueMicrotask(() => outcome === "error" ? on.error?.() : outcome === "timeout" ? on.timeout?.() : onResponse({ statusCode: outcome.status, resume: () => {} })),
    };
    return req;
  });
}
const target = `${"a".repeat(32)}.domains.staygreen.io`;
beforeEach(() => vi.clearAllMocks());

describe("the DNS record name a provider asks for", () => {
  it.each([
    ["status.askone.org", "status"],
    ["status.example.co.uk", "status"],
    ["status.app.example.com", "status.app"],
    ["status.mysite.eu.org", "status"],
    ["askone.org", "@"],
  ])("%s is entered as %s", (host, name) => expect(dnsRecordName(host)).toBe(name));
});

describe("whether the edge serves a verified domain", () => {
  it("connects to the claim's own target and names the domain only in TLS and Host", async () => {
    answer({ status: 200 });
    expect(await servesOverTls("status.example.com", target)).toBe(true);
    const [opts] = fake.request.mock.calls[0];
    expect(opts).toMatchObject({ host: target, servername: "status.example.com", headers: { host: "status.example.com" }, path: "/badge.svg", agent: false });
    expect(opts.rejectUnauthorized).not.toBe(false);
  });
  it.each<[string, Outcome]>([["another status", { status: 404 }], ["a TLS or connection error", "error"], ["a timeout", "timeout"]])("is not live on %s", async (_, outcome) => {
    answer(outcome);
    expect(await servesOverTls("status.example.com", target)).toBe(false);
  });
});
