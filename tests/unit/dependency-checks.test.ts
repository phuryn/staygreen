import { expect, it, vi } from "vitest";
import { checkDependencies, dependencyFinding } from "@/lib/dependency-checks";
import { requestLimit } from "@/lib/request-limit";
import type { DependencyTarget } from "@/lib/dependency-detect";
import { checkDns, type Ask } from "@/checks/dns";
import { systemAsk } from "@/checks/dns";
import { Resolver } from "node:dns/promises";
import type { CheckResult } from "@/checks/types";
const target: DependencyTarget = { provider: "Clerk", host: "clerk.askone.org", url: "https://clerk.askone.org/npm/@clerk/clerk-js@6/dist/clerk.browser.js", keyword: "Clerk", purpose: "Catches a missing script." };
const good: CheckResult = { ok: true, ms: 1, status: 200 };
const ask: Ask = async (_server, _name, record) => record === "NS" ? ["NS2.example.net.", "ns1.example.net"] : ["frontend.clerk.services."];
it("dispatches an NS probe through Node's configured public resolver", async () => {
  const resolve = vi.spyOn(Resolver.prototype, "resolveNs").mockResolvedValue(["ns1.example.net"]);
  try { expect(await systemAsk("1.1.1.1", "askone.org", "NS")).toEqual(["ns1.example.net"]); expect(resolve).toHaveBeenCalledWith("askone.org"); }
  finally { resolve.mockRestore(); }
});
it("offers the current full NS set and same-domain CNAME, never the public key", async () => {
  const result = await checkDependencies([{ ...target, headers: { apikey: "public-key" } }], "https://www.askone.org", async () => good, ask, requestLimit(4), () => 10000);
  expect(result.dns).toMatchObject([{ record: "NS", recordName: "askone.org", expected: "ns1.example.net, ns2.example.net" }, { record: "CNAME", recordName: "clerk.askone.org", expected: "frontend.clerk.services" }]);
  expect(result.checks[0]).toMatchObject({ dns: "ok", tls: "ok", frontend: "ok" });
  expect(JSON.stringify(result)).not.toContain("public-key");
});
it("does not invent a CNAME for a missing/flattened record or accept a disputed nameserver set", async () => {
  const result = await checkDependencies([target], "https://askone.org", async () => good, async (server, _name, record) => record === "CNAME" ? [] : [server === "1.1.1.1" ? "ns1.example.net" : "ns2.example.net"], requestLimit(4), () => 10000);
  expect(result.dns).toEqual([]);
});
it.each([
  ["dns", "issue", "unknown", "issue"], ["private", "issue", "unknown", "issue"],
  ["tls", "ok", "issue", "issue"], ["connect", "ok", "unknown", "issue"], ["timeout", "unknown", "unknown", "unknown"],
] as const)("reports %s evidence without claiming a successful login", (kind, dns, tls, frontend) => {
  expect(dependencyFinding(target, { ok: false, ms: 1, failure: { kind, message: "secret response" } })).toMatchObject({ dns, tls, frontend });
  expect(JSON.stringify(dependencyFinding(target, { ok: false, ms: 1, failure: { kind, message: "secret response" } }))).not.toContain("secret response");
});
it("distinguishes a served but wrong body from DNS/TLS failure, and skips Supabase Auth without a key", async () => {
  expect(dependencyFinding(target, { ok: false, ms: 1, entryAnswered: true, failure: { kind: "dns", message: "A later redirect host did not resolve" } })).toMatchObject({ dns: "ok", tls: "ok", frontend: "issue" });
  expect(dependencyFinding(target, { ok: false, ms: 1, status: 200, failure: { kind: "keyword", message: "wrong body" } })).toMatchObject({ dns: "ok", tls: "ok", frontend: "issue" });
  const get = vi.fn(async () => good);
  const result = await checkDependencies([{ ...target, provider: "Supabase Auth", requiresKey: true }], "https://askone.org", get, ask, requestLimit(4), () => 10000);
  expect(result.checks[0].frontend).toBe("skipped"); expect(get).not.toHaveBeenCalled();
});
it("shares the four-open-work limit across dependency fetches and DNS, and starts no work after the deadline", async () => {
  let open = 0; let most = 0; const queue = requestLimit(4);
  const work = async () => { most = Math.max(most, ++open); await new Promise(r => setTimeout(r, 5)); open--; };
  const targets = Array.from({ length: 6 }, (_, i) => ({ ...target, host: `auth${i}.askone.org` }));
  await checkDependencies(targets, "https://askone.org", () => queue(async () => { await work(); return good; }), async (...args) => { await work(); return ask(...args); }, queue, () => 10000);
  expect(most).toBe(4); expect(open).toBe(0);
  const get = vi.fn(async () => good); const dns = vi.fn(ask);
  const result = await checkDependencies(targets, "https://askone.org", get, dns, queue, () => 0);
  expect(get).not.toHaveBeenCalled(); expect(dns).not.toHaveBeenCalled(); expect(result.checks.every(c => c.frontend === "unknown")).toBe(true);
});
it("NS compares the complete set at each resolver; losing one server or adding one fails", async () => {
  const check = { record: "NS" as const, name: "askone.org", expected: "ns1.example.net, ns2.example.net" };
  expect((await checkDns(check, async () => ["NS2.EXAMPLE.NET.", "ns1.example.net", "ns1.example.net"])).ok).toBe(true);
  for (const names of [["ns1.example.net"], ["ns1.example.net", "ns2.example.net", "ns3.example.net"]]) expect((await checkDns(check, async () => names)).ok).toBe(false);
  expect((await checkDns(check, async server => server === "1.1.1.1" ? ["ns1.example.net"] : ["ns2.example.net", "ns1.example.net"])).ok).toBe(true);
});
