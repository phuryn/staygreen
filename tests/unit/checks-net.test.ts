import { readFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import tlsMod from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCert } from "../../src/checks/cert";
import { checkDns, type Ask } from "../../src/checks/dns";
import { checkTcp } from "../../src/checks/tcp";

/* TCP ports, certificates and DNS records (`spec.md § 3.8, § 3.2, § 3.4`). TCP and TLS run against
   sockets on this machine with the test CA; DNS runs against a fake resolver, since the real one
   would make the suite depend on the network. */

const fixture = (f: string) => readFileSync(new URL(`../fixtures/tls/${f}`, import.meta.url));
const ca = fixture("ca.pem");
const allow = () => true;

let tcp: net.Server;
let good: tlsMod.Server;
let wrong: tlsMod.Server;
let tcpPort = 0;
let goodPort = 0;
let wrongPort = 0;

// Dual-stack: localhost may resolve only to ::1; IP-literal checks still use 127.0.0.1.
const listen = (s: net.Server) => new Promise<number>((r) => s.listen({ port: 0, host: "::", ipv6Only: false }, () => r((s.address() as AddressInfo).port)));

beforeAll(async () => {
  tcp = net.createServer((s) => s.end());
  good = tlsMod.createServer({ key: fixture("localhost.key"), cert: fixture("localhost.pem") }, (s) => s.end());
  wrong = tlsMod.createServer({ key: fixture("wrong.key"), cert: fixture("wrong.pem") }, (s) => s.end());
  tcpPort = await listen(tcp);
  goodPort = await listen(good);
  wrongPort = await listen(wrong);
});

afterAll(async () => {
  for (const s of [tcp, good, wrong]) await new Promise((r) => s.close(r));
});

describe("checkTcp", () => {
  it("passes an open port", async () => {
    expect(await checkTcp({ host: "127.0.0.1", port: tcpPort }, { allow })).toMatchObject({ ok: true, address: "127.0.0.1" });
  });

  it("is slow when connecting took longer than the threshold, and says nothing otherwise", async () => {
    expect((await checkTcp({ host: "127.0.0.1", port: tcpPort, slowMs: -1 }, { allow })).slow).toBe(true);
    expect((await checkTcp({ host: "127.0.0.1", port: tcpPort, slowMs: 60_000 }, { allow })).slow).toBeUndefined();
    expect((await checkTcp({ host: "127.0.0.1", port: tcpPort }, { allow })).slow).toBeUndefined();
  });

  it("fails a closed one as refused", async () => {
    expect((await checkTcp({ host: "127.0.0.1", port: 1 }, { allow })).failure).toEqual({ kind: "connect", message: "Connection refused" });
  });

  it("completes the TLS handshake when asked, and fails one it can't trust", async () => {
    expect((await checkTcp({ host: "localhost", port: goodPort, tls: true }, { allow, ca })).ok).toBe(true);
    expect((await checkTcp({ host: "localhost", port: goodPort, tls: true }, { allow })).failure?.kind).toBe("tls");
  });

  it("refuses a private address under the default guard", async () => {
    expect((await checkTcp({ host: "127.0.0.1", port: tcpPort })).failure?.kind).toBe("private");
    expect((await checkTcp({ host: "10.0.0.1", port: 22 })).failure?.kind).toBe("private");
  });
});

describe("checkCert", () => {
  const now = () => Date.parse("2026-10-22T00:00:00Z");

  it("passes a valid certificate and says when it expires", async () => {
    const r = await checkCert({ host: "localhost", port: goodPort }, { allow, ca, now });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatchObject({ subject: "localhost" });
    expect(r.detail?.daysLeft).toBeGreaterThan(7000);
    expect(String(r.detail?.expiresAt)).toMatch(/^2046-/);
  });

  it("fails an expired certificate, saying when", async () => {
    const r = await checkCert({ host: "localhost", port: goodPort }, { allow, ca, now: () => Date.parse("2050-01-01T00:00:00Z") });
    expect(r.failure?.kind).toBe("cert");
    expect(r.failure?.message).toMatch(/^The certificate expired on 2046-/);
  });

  it("fails a chain nobody vouches for", async () => {
    const r = await checkCert({ host: "localhost", port: goodPort }, { allow, now });
    expect(r.failure?.kind).toBe("cert");
    expect(r.failure?.message).toMatch(/isn't trusted/);
  });

  it("fails a certificate for another name", async () => {
    const r = await checkCert({ host: "localhost", port: wrongPort }, { allow, ca, now });
    expect(r.failure).toEqual({ kind: "cert", message: "The certificate isn't for localhost" });
  });

  it("calls a closed port a connection failure, which the state machine confirms", async () => {
    expect((await checkCert({ host: "127.0.0.1", port: 1 }, { allow, now })).failure?.kind).toBe("connect");
  });

  it("calls a connection closed before the handshake finished a connection failure, not a certificate verdict", async () => {
    // Node words this "...before secure TLS connection was established", which once read as a
    // TLS failure and took an SSL monitor down from one location.
    const hangUp = net.createServer((s) => s.destroy());
    const port = await listen(hangUp);
    const r = await checkCert({ host: "127.0.0.1", port }, { allow, ca, now });
    await new Promise((done) => hangUp.close(done));
    expect(r.failure?.kind).toBe("connect");
  });

  it("refuses a private address under the default guard", async () => {
    expect((await checkCert({ host: "127.0.0.1", port: goodPort })).failure?.kind).toBe("private");
  });
});

describe("checkDns", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  const answers =
    (cf: string[] | string, google: string[] | string): Ask =>
    async (server) => {
      const a = server === "1.1.1.1" ? cf : google;
      if (typeof a === "string") throw err(a);
      return a;
    };

  it("passes when a resolver has the expected value, ignoring case and a trailing dot", async () => {
    const r = await checkDns({ record: "CNAME", name: "www.example.com", expected: "Target.Netlify.app." }, answers(["target.netlify.app"], ["other.example"]));
    expect(r.ok).toBe(true);
  });

  it("passes when only one resolver answers, so one resolver's hiccup isn't an alert", async () => {
    expect((await checkDns({ record: "A", name: "example.com", expected: "93.184.216.34" }, answers("ETIMEOUT", ["93.184.216.34"]))).ok).toBe(true);
  });

  it("matches TXT by containment", async () => {
    const ask = answers(["v=spf1 include:_spf.google.com ~all"], ["v=spf1 include:_spf.google.com ~all"]);
    expect((await checkDns({ record: "TXT", name: "example.com", expected: "include:_spf.google.com" }, ask)).ok).toBe(true);
  });

  it("fails a mismatch, saying what was there", async () => {
    const r = await checkDns({ record: "A", name: "example.com", expected: "1.2.3.4" }, answers(["5.6.7.8"], ["5.6.7.8"]));
    expect(r.failure).toEqual({ kind: "mismatch", message: "example.com A is 5.6.7.8, expected 1.2.3.4" });
  });

  it("fails a record missing at both as dns, and silence at both as a timeout", async () => {
    expect((await checkDns({ record: "MX", name: "example.com", expected: "10 mx.example.com" }, answers("ENOTFOUND", "ENODATA"))).failure?.kind).toBe("dns");
    expect((await checkDns({ record: "MX", name: "example.com", expected: "10 mx.example.com" }, answers("ETIMEOUT", "ECONNREFUSED"))).failure?.kind).toBe("timeout");
  });

  it("keeps each resolver's answer for the evidence", async () => {
    const r = await checkDns({ record: "A", name: "example.com", expected: "1.2.3.4" }, answers(["5.6.7.8"], "ENOTFOUND"));
    expect(r.detail).toEqual({
      resolvers: [
        { resolver: "cloudflare", answers: ["5.6.7.8"], matches: false },
        { resolver: "google", error: "ENOTFOUND", matches: false },
      ],
    });
  });
});
