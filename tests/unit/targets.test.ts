import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTarget, setResolver, type Resolve } from "@/lib/targets";

/* The create-time private-range refusal (`AGENTS.md § 2.8`). The resolver is
   the module's own seam (`setResolver`), so no test touches DNS: each one hands
   it the answer a name would resolve to. What is real: the normalisation, the
   literal and local-name refusals, and the question asked of every address. */

const answers = (map: Record<string, string[]>): Resolve =>
  vi.fn(async (host: string) => {
    if (host in map) return map[host];
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  });

const failing = (code: string | undefined): Resolve =>
  vi.fn(async () => {
    throw Object.assign(new Error("dns"), code ? { code } : {});
  });

afterEach(() => {
  setResolver(null);
});

const reasonOf = async (host: string) => {
  const r = await checkTarget(host);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.reason;
};

describe("an address typed as the target", () => {
  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])("admits the public literal %s without a lookup", async (ip) => {
    const resolve = answers({});
    setResolver(resolve);
    expect(await checkTarget(ip)).toEqual({ ok: true });
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["10.0.0.4", "127.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "fd00::1", "::ffff:10.0.0.4"])("refuses the private literal %s, naming it, without a lookup", async (ip) => {
    const resolve = answers({});
    setResolver(resolve);
    expect(await reasonOf(ip)).toContain(ip);
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("a local name", () => {
  it.each(["localhost", "api.localhost", "db.internal", "printer.local", "LOCALHOST", "localhost."])("refuses %s without a lookup", async (host) => {
    const resolve = answers({});
    setResolver(resolve);
    expect(await reasonOf(host)).toContain(host.toLowerCase().replace(/\.$/, ""));
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("a name that resolves", () => {
  it("is admitted when every address is public", async () => {
    setResolver(answers({ "api.example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] }));
    expect(await checkTarget("api.example.com")).toEqual({ ok: true });
  });

  it.each([
    [["10.0.0.4"], "10.0.0.4"],
    [["93.184.216.34", "10.0.0.4"], "10.0.0.4"],
    [["93.184.216.34", "::1"], "::1"],
    [["::ffff:192.168.1.1"], "::ffff:192.168.1.1"],
    [["169.254.169.254"], "169.254.169.254"],
  ])("is refused when one address of %j is private, naming the name and that address", async (addresses, bad) => {
    setResolver(answers({ "api.example.com": addresses }));
    const reason = await reasonOf("api.example.com");
    expect(reason).toContain("api.example.com");
    expect(reason).toContain(bad);
  });

  it("is asked of the resolver lowercased and without the trailing dot", async () => {
    const resolve = answers({ "api.example.com": ["93.184.216.34"] });
    setResolver(resolve);
    expect(await checkTarget("API.Example.COM.")).toEqual({ ok: true });
    expect(resolve).toHaveBeenCalledWith("api.example.com");
  });

  it("gives a private literal and a name pointing at it different reasons", async () => {
    setResolver(answers({ "api.example.com": ["10.0.0.4"] }));
    expect(await reasonOf("api.example.com")).not.toBe(await reasonOf("10.0.0.4"));
  });
});

describe("a name that does not resolve", () => {
  it("is refused the same way whether the answer is ENOTFOUND, ENODATA or empty", async () => {
    setResolver(failing("ENOTFOUND"));
    const notFound = await reasonOf("nope.example.com");
    setResolver(failing("ENODATA"));
    const noData = await reasonOf("nope.example.com");
    setResolver(answers({ "nope.example.com": [] }));
    const empty = await reasonOf("nope.example.com");
    expect(notFound).toContain("nope.example.com");
    expect([noData, empty]).toEqual([notFound, notFound]);
  });

  it.each(["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", undefined])("is refused as worth retrying when the lookup fails with %s", async (code) => {
    setResolver(failing("ENOTFOUND"));
    const missing = await reasonOf("nope.example.com");
    setResolver(failing(code));
    const reason = await reasonOf("nope.example.com");
    expect(reason).toContain("nope.example.com");
    expect(reason).not.toBe(missing);
  });

  it("is refused the same way for every transient failure", async () => {
    const reasons = [];
    for (const code of ["ETIMEOUT", "ESERVFAIL", undefined]) {
      setResolver(failing(code));
      reasons.push(await reasonOf("nope.example.com"));
    }
    expect(new Set(reasons).size).toBe(1);
  });
});
