import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_URL, Rdap, type DomainResult, type RdapAnswer } from "../../src/checks/rdap";
import { DOMAIN_FRESH_MS, DOMAIN_RETRY_MS, domainLeader, domainPass, domainWork, type DomainRow, type DomainStore } from "../../probe/domains";
import { certOf } from "../../probe/store";
import { ranked } from "../../probe/schedule";

/* What the probes keep about an SSL monitor's expiries: the certificate an outcome carries to its
   home (`certOf`, `probe/store.ts`), and the leader's daily domain lookups (`probe/domains.ts`),
   over recorded RDAP answers (`tests/fixtures/rdap/`). The SQL side is
   `tests/integration/probe-store.test.ts`. */

const NOW = 1_800_000_000_000;
const recorded = (f: string) => readFileSync(new URL(`../fixtures/rdap/${f}`, import.meta.url), "utf8");
const PIR = "https://rdap.publicinterestregistry.org/rdap/domain/";
const ANSWERS: Record<string, RdapAnswer> = {
  [BOOTSTRAP_URL]: { status: 200, body: recorded("iana-dns-bootstrap.json") },
  [`${PIR}askone.org`]: { status: 200, body: recorded("askone.org.json") },
  [`${PIR}www.askone.org`]: { status: 400, body: recorded("www.askone.org.400.json") },
};

function registry() {
  const asked: string[] = [];
  const rdap = new Rdap(async (url) => {
    asked.push(url);
    return ANSWERS[url] ?? { status: 404, body: "" };
  }, { now: () => NOW, sleep: async () => {} });
  return { asked, rdap };
}

function memoryStore(rows: DomainRow[] = []) {
  const recorded: { host: string; r: DomainResult }[] = [];
  const store: DomainStore = {
    loadDomains: async (hosts) => rows.filter((r) => hosts.includes(r.host)),
    recordDomain: async (host, r) => {
      recorded.push({ host, r });
      return true;
    },
  };
  return { recorded, store };
}

const row = (over: Partial<DomainRow> & Pick<DomainRow, "host">): DomainRow => ({ name: "askone.org", status: "found", error: null, attemptedAt: NOW - 1000, ...over });

describe("which lookups are due", () => {
  it("asks a domain answered a day ago again, once however many hosts share it", () => {
    const old = NOW - DOMAIN_FRESH_MS;
    const { refresh, walk } = domainWork(["askone.org", "www.askone.org"], [row({ host: "askone.org", attemptedAt: old }), row({ host: "www.askone.org", attemptedAt: old })], NOW);
    expect([...refresh]).toEqual([["askone.org", "askone.org"]]);
    expect(walk).toEqual([]);
  });

  it("leaves a domain answered within the day alone", () => {
    expect(domainWork(["askone.org"], [row({ host: "askone.org", attemptedAt: NOW - DOMAIN_FRESH_MS + 1 })], NOW)).toEqual({ refresh: new Map(), walk: [] });
  });

  it("retries a failure after an hour, and walks a host whose domain isn't known", () => {
    const failedRefresh = row({ host: "askone.org", error: "The registry answered 503", attemptedAt: NOW - DOMAIN_RETRY_MS });
    const failedWalk = row({ host: "x.example.org", name: "x.example.org", status: "failed", error: "No answer", attemptedAt: NOW - DOMAIN_RETRY_MS });
    const recent = row({ host: "y.example.org", name: "y.example.org", status: "failed", error: "No answer", attemptedAt: NOW - DOMAIN_RETRY_MS + 1 });
    const { refresh, walk } = domainWork(["askone.org", "x.example.org", "y.example.org", "new.example.com"], [failedRefresh, failedWalk, recent], NOW);
    expect([...refresh.keys()]).toEqual(["askone.org"]);
    expect(walk).toEqual(["x.example.org", "new.example.com"]);
  });

  it("asks a TLD with no RDAP, or a host with no record, again the next day, not sooner", () => {
    const noRdap = row({ host: "staygreen.io", name: "staygreen.io", status: "no_rdap" });
    expect(domainWork(["staygreen.io"], [noRdap], NOW).walk).toEqual([]);
    expect(domainWork(["staygreen.io"], [{ ...noRdap, attemptedAt: NOW - DOMAIN_FRESH_MS }], NOW).walk).toEqual(["staygreen.io"]);
  });
});

describe("a pass", () => {
  it("walks a new host to its domain once, and records it under the name the registry answered for", async () => {
    const { asked, rdap } = registry();
    const { recorded, store } = memoryStore();
    const counts = await domainPass(store, rdap, ["www.askone.org", "app.askone.org", "askone.org"], NOW);
    // One walk found askone.org; the other two hosts on it ask nothing.
    expect(asked).toEqual([BOOTSTRAP_URL, `${PIR}www.askone.org`, `${PIR}askone.org`]);
    expect(recorded).toEqual([{ host: "www.askone.org", r: { status: "found", domain: "askone.org", expiresAt: Date.parse("2027-08-30T12:25:15.206Z"), registrar: "GoDaddy.com, LLC" } }]);
    expect(counts).toEqual({ looked: 1, recorded: 1, errors: 0, deferred: new Set() });
  });

  it("asks a known domain directly, and nothing at all within the day", async () => {
    const { asked, rdap } = registry();
    const { store } = memoryStore([row({ host: "www.askone.org", attemptedAt: NOW - DOMAIN_FRESH_MS })]);
    await domainPass(store, rdap, ["www.askone.org"], NOW);
    expect(asked).toEqual([BOOTSTRAP_URL, `${PIR}askone.org`]);
    const quiet = registry();
    await domainPass(memoryStore([row({ host: "www.askone.org" })]).store, quiet.rdap, ["www.askone.org"], NOW);
    expect(quiet.asked).toEqual([]);
  });

  it("records a TLD with no RDAP service as that, and skips a host that isn't a domain name", async () => {
    const { asked, rdap } = registry();
    const { recorded, store } = memoryStore();
    await domainPass(store, rdap, ["staygreen.io", "localhost", "203.0.113.9"], NOW);
    expect(recorded).toEqual([{ host: "staygreen.io", r: { status: "no_rdap", domain: "staygreen.io" } }]);
    expect(asked).toEqual([BOOTSTRAP_URL]);
  });

  it("stops between lookups when the probe is stopping, leaving the rest for the next pass", async () => {
    const { rdap } = registry();
    const { recorded, store } = memoryStore();
    const counts = await domainPass(store, rdap, ["askone.org", "staygreen.io"], NOW, () => true);
    expect(recorded).toEqual([]);
    expect(counts.deferred).toEqual(new Set(["askone.org", "staygreen.io"]));
  });

  it("makes at most so many lookups a pass, and leaves the rest for the next", async () => {
    const { asked, rdap } = registry();
    const { recorded, store } = memoryStore();
    const counts = await domainPass(store, rdap, ["askone.org", "a.example.org", "b.example.org"], NOW, () => false, 2);
    expect(recorded.map((r) => r.host)).toEqual(["askone.org", "a.example.org"]);
    expect(counts).toMatchObject({ looked: 2, deferred: new Set(["b.example.org"]) });
    expect(asked.some((u) => u.includes("b.example.org"))).toBe(false);
  });

  it("records nothing behind a registry's 429, asks it nothing more in the pass, and goes on with the others", async () => {
    const asked: string[] = [];
    const rdap = new Rdap(async (url) => {
      asked.push(url);
      if (url === BOOTSTRAP_URL) return ANSWERS[BOOTSTRAP_URL];
      if (url.startsWith(PIR)) return { status: 429, body: "" };
      return { status: 200, body: readFileSync(new URL("../fixtures/rdap/vercel.com.json", import.meta.url), "utf8") };
    }, { now: () => NOW, sleep: async () => {} });
    const { recorded, store } = memoryStore();
    const counts = await domainPass(store, rdap, ["askone.org", "www.askone.org", "vercel.com"], NOW);
    expect(recorded.map((r) => [r.host, r.r.status])).toEqual([["vercel.com", "found"]]);
    expect(counts).toMatchObject({ looked: 1, errors: 0, deferred: new Set(["askone.org", "www.askone.org"]) });
    expect(asked.filter((u) => u.startsWith(PIR))).toHaveLength(1);
  });
});

describe("the leader", () => {
  it("is one probe of the live set, the same on every probe, and moves when it leaves", () => {
    const fleet = [{ id: "tor1-a", location: "tor1", builderOnly: false }, { id: "sfo3-a", location: "sfo3", builderOnly: false }];
    const leader = domainLeader(fleet)!;
    expect(domainLeader([...fleet].reverse())).toEqual(leader);
    expect(leader).toEqual(ranked("domain-registrations", fleet)[0]);
    const rest = fleet.filter((p) => p.id !== leader.id);
    expect(domainLeader(rest)).toEqual(rest[0]);
    expect(domainLeader([])).toBeUndefined();
  });
});

describe("certOf, the certificate an SSL outcome carries", () => {
  const detail = { daysLeft: 63, expiresAt: "2026-12-24T10:00:00.000Z", issuer: "Let's Encrypt", subject: "askone.org" };

  it("reads the expiry and issuer from the check that reached a handshake", () => {
    expect(certOf({ first: { ok: true, ms: 80, location: "tor1", detail } })).toEqual({
      expiresAt: "2026-12-24T10:00:00.000Z", expiresAtSec: Date.parse("2026-12-24T10:00:00.000Z") / 1000, issuer: "Let's Encrypt",
    });
    // A first look that broke off before the handshake, and a second look that read it.
    expect(certOf({ first: { ok: false, ms: 15_000, location: "tor1", failure: { kind: "timeout", message: "x" } }, confirm: { ok: true, ms: 90, location: "sfo3", detail } }))
      .toMatchObject({ issuer: "Let's Encrypt" });
  });

  it("has none when no check got that far, or the detail isn't a date", () => {
    expect(certOf({ first: { ok: false, ms: 15_000, location: "tor1", failure: { kind: "timeout", message: "x" } } })).toBeNull();
    expect(certOf({ first: { ok: true, ms: 1, location: "tor1", detail: { expiresAt: "soon" } } })).toBeNull();
  });

  it("keeps an issuer within the database's 200 characters, and an empty one as none", () => {
    expect(certOf({ first: { ok: true, ms: 1, location: "tor1", detail: { ...detail, issuer: "x".repeat(300) } } })!.issuer).toHaveLength(200);
    expect(certOf({ first: { ok: true, ms: 1, location: "tor1", detail: { ...detail, issuer: " " } } })!.issuer).toBeNull();
  });
});
