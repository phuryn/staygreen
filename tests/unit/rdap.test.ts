import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOOTSTRAP_URL, GAP_MS, Rdap, asciiHost, candidates, guardedFetch, parseBootstrap, parseDomain, retryAfterMs, type RdapAnswer } from "../../src/checks/rdap";

/* Domain registration through RDAP (`src/checks/rdap.ts`), against answers recorded from the real
   services on 2026-10-22 (`tests/fixtures/rdap/`, trimmed of their terms-of-service text and the
   registrars' abuse contacts): IANA's bootstrap file, Public Interest Registry for `askone.org`
   (which answers 400, not 404, for `www.askone.org`), and Verisign for `vercel.com` (404 for
   `www.vercel.com`). The guarded fetch runs against a server on this machine; nothing here reaches
   the network. The live run is `rdap-live.test.ts`, skipped unless asked for. */

const recorded = (f: string) => readFileSync(new URL(`../fixtures/rdap/${f}`, import.meta.url), "utf8");
const tls = (f: string) => readFileSync(new URL(`../fixtures/tls/${f}`, import.meta.url));

const PIR = "https://rdap.publicinterestregistry.org/rdap/domain/";
const VERISIGN = "https://rdap.verisign.com/com/v1/domain/";

/** A fetch that answers from a table of recorded responses and records what it was asked. */
function served(table: Record<string, RdapAnswer>) {
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    return table[url] ?? { status: 404, body: "" };
  };
  return { asked, fetch };
}

/** An Rdap on a clock of its own: its pacing moves the clock instead of waiting, and each request
 *  is noted with the time it went out. An answer can be a function, to change between calls. */
function paced(table: Record<string, RdapAnswer | (() => RdapAnswer)>) {
  const clock = { now: 1_800_000_000_000 };
  const at: [string, number][] = [];
  const rdap = new Rdap(async (url) => {
    at.push([url, clock.now]);
    const a = table[url] ?? { status: 404, body: "" };
    return typeof a === "function" ? a() : a;
  }, { now: () => clock.now, sleep: async (ms) => void (clock.now += ms) });
  const asked = (prefix: string) => at.filter(([u]) => u.startsWith(prefix)).length;
  return { clock, at, asked, rdap };
}

const BOOT: RdapAnswer = { status: 200, body: recorded("iana-dns-bootstrap.json") };
/** No real waiting between requests. */
const rdapOf = (fetch: (url: string, max: number) => Promise<RdapAnswer>, now: () => number = Date.now) => new Rdap(fetch, { now, sleep: async () => {} });
const ASKONE: RdapAnswer = { status: 200, body: recorded("askone.org.json") };
const VERCEL: RdapAnswer = { status: 200, body: recorded("vercel.com.json") };
const WWW_ASKONE: RdapAnswer = { status: 400, body: recorded("www.askone.org.400.json") };

describe("the names asked about", () => {
  it("walks from the host up one label at a time, and never asks about a bare TLD", () => {
    expect(candidates("app.askone.org")).toEqual(["app.askone.org", "askone.org"]);
    expect(candidates("askone.org")).toEqual(["askone.org"]);
    expect(candidates("org")).toEqual([]);
  });

  it("starts no deeper than five labels, so a very long host costs four requests", () => {
    expect(candidates("a.b.c.d.e.f.example.co.uk")).toEqual(["e.f.example.co.uk", "f.example.co.uk", "example.co.uk", "co.uk"]);
  });

  it("asks in lowercase ASCII, an internationalized name in its xn-- form, and not about an address", () => {
    expect(asciiHost("WWW.AskOne.org.")).toBe("www.askone.org");
    expect(asciiHost("bücher.example")).toBe("xn--bcher-kva.example");
    expect(asciiHost("203.0.113.7")).toBeNull();
    expect(asciiHost("[2001:db8::1]")).toBeNull();
    expect(asciiHost("localhost")).toBeNull();
  });
});

describe("the recorded answers", () => {
  it("map each TLD in IANA's bootstrap file to its registry's server, and leave out a TLD with none", () => {
    const servers = parseBootstrap(JSON.parse(BOOT.status === 200 ? BOOT.body : ""));
    expect(servers.get("org")).toBe("https://rdap.publicinterestregistry.org/rdap/");
    expect(servers.get("com")).toBe("https://rdap.verisign.com/com/v1/");
    expect(servers.get("dev")).toBe("https://pubapi.registry.google/rdap/");
    expect(servers.has("io")).toBe(false);
  });

  it("read the expiration event and the registrar's name, not the abuse contact's", () => {
    expect(parseDomain(JSON.parse(recorded("askone.org.json")), "askone.org")).toEqual({
      domain: "askone.org", expiresAt: Date.parse("2027-08-30T12:25:15.206Z"), registrar: "GoDaddy.com, LLC",
    });
    // Verisign writes the name in capitals.
    expect(parseDomain(JSON.parse(recorded("vercel.com.json")), "vercel.com")).toEqual({
      domain: "vercel.com", expiresAt: Date.parse("2029-10-04T19:30:47Z"), registrar: "Amazon Registrar, Inc.",
    });
  });

  it("say so when a registry publishes no expiry, rather than guess one", () => {
    const answer = JSON.parse(recorded("askone.org.json"));
    answer.events = answer.events.filter((e: { eventAction: string }) => e.eventAction !== "expiration");
    expect(parseDomain(answer, "askone.org")).toMatchObject({ domain: "askone.org", expiresAt: null });
  });

  it("refuse an error object, or a domain object for some other name", () => {
    expect(parseDomain(JSON.parse(recorded("www.askone.org.400.json")), "www.askone.org")).toBeNull();
    expect(parseDomain(JSON.parse(recorded("askone.org.json")), "vercel.com")).toBeNull();
  });
});

describe("a lookup", () => {
  it("walks past PIR's 400 for a subdomain to the domain it belongs to", async () => {
    const { asked, fetch } = served({ [BOOTSTRAP_URL]: BOOT, [`${PIR}www.askone.org`]: WWW_ASKONE, [`${PIR}askone.org`]: ASKONE });
    const r = await rdapOf(fetch).lookup("www.askone.org");
    expect(r).toEqual({ status: "found", domain: "askone.org", expiresAt: Date.parse("2027-08-30T12:25:15.206Z"), registrar: "GoDaddy.com, LLC" });
    expect(asked).toEqual([BOOTSTRAP_URL, `${PIR}www.askone.org`, `${PIR}askone.org`]);
  });

  it("walks past Verisign's 404 the same way", async () => {
    const { fetch } = served({ [BOOTSTRAP_URL]: BOOT, [`${VERISIGN}www.vercel.com`]: { status: 404, body: "" }, [`${VERISIGN}vercel.com`]: VERCEL });
    expect(await rdapOf(fetch).lookup("www.vercel.com")).toMatchObject({ status: "found", domain: "vercel.com", registrar: "Amazon Registrar, Inc." });
  });

  it("asks a domain it already knows directly, once", async () => {
    const { asked, fetch } = served({ [BOOTSTRAP_URL]: BOOT, [`${PIR}askone.org`]: ASKONE });
    expect(await rdapOf(fetch).lookup("www.askone.org", "askone.org")).toMatchObject({ status: "found", domain: "askone.org" });
    expect(asked).toEqual([BOOTSTRAP_URL, `${PIR}askone.org`]);
  });

  it("reads the bootstrap file once a day, not once a lookup", async () => {
    let now = 1_800_000_000_000;
    const { asked, fetch } = served({ [BOOTSTRAP_URL]: BOOT, [`${PIR}askone.org`]: ASKONE });
    const rdap = rdapOf(fetch, () => now);
    await rdap.lookup("askone.org");
    await rdap.lookup("askone.org");
    expect(asked.filter((u) => u === BOOTSTRAP_URL)).toHaveLength(1);
    now += 86_400_000;
    await rdap.lookup("askone.org");
    expect(asked.filter((u) => u === BOOTSTRAP_URL)).toHaveLength(2);
  });

  it("says a TLD has no RDAP service without asking anyone but IANA", async () => {
    const { asked, fetch } = served({ [BOOTSTRAP_URL]: BOOT });
    expect(await rdapOf(fetch).lookup("staygreen.io")).toEqual({ status: "no_rdap", domain: "staygreen.io" });
    expect(asked).toEqual([BOOTSTRAP_URL]);
  });

  it("says nothing was found when every name from the host up is refused", async () => {
    const { asked, fetch } = served({ [BOOTSTRAP_URL]: BOOT });
    expect(await rdapOf(fetch).lookup("a.never-registered.org")).toEqual({ status: "not_found", domain: "a.never-registered.org" });
    expect(asked).toEqual([BOOTSTRAP_URL, `${PIR}a.never-registered.org`, `${PIR}never-registered.org`]);
  });

  it("fails, to be tried again, on any other answer or no answer", async () => {
    const down = served({ [BOOTSTRAP_URL]: BOOT, [`${PIR}askone.org`]: { status: 503, body: "" } });
    expect(await rdapOf(down.fetch).lookup("askone.org")).toEqual({ status: "failed", domain: "askone.org", error: "The registry answered 503" });
    const silent = served({ [BOOTSTRAP_URL]: BOOT, [`${PIR}askone.org`]: { error: "No answer within 10 s" } });
    expect(await rdapOf(silent.fetch).lookup("www.askone.org", "askone.org")).toEqual({ status: "failed", domain: "askone.org", error: "No answer within 10 s" });
  });

  it("records nothing while IANA's file can't be read, asks for it again ten minutes later, and keeps a copy it has", async () => {
    let boot: RdapAnswer = { status: 503, body: "" };
    const { clock, asked, rdap } = paced({ [BOOTSTRAP_URL]: () => boot, [`${PIR}askone.org`]: ASKONE });
    expect(await rdap.lookup("askone.org")).toEqual({ status: "busy", domain: "askone.org", server: "https://data.iana.org" });
    expect(await rdap.lookup("www.askone.org")).toMatchObject({ status: "busy" });
    expect(asked(BOOTSTRAP_URL)).toBe(1);
    clock.now += 600_000;
    boot = BOOT;
    expect(await rdap.lookup("askone.org")).toMatchObject({ status: "found" });
    // A day on, the file fails again: the copy held is used, and asked for again only later.
    clock.now += 86_400_000;
    boot = { error: "No answer within 10 s" };
    expect(await rdap.lookup("askone.org")).toMatchObject({ status: "found" });
    expect(await rdap.lookup("askone.org")).toMatchObject({ status: "found" });
    expect(asked(BOOTSTRAP_URL)).toBe(3);
  });
});

describe("how fast a registry is asked", () => {
  it("asks one registry server at most once a second, walks included, and doesn't hold up another", async () => {
    const { at, rdap } = paced({ [BOOTSTRAP_URL]: BOOT, [`${PIR}www.askone.org`]: WWW_ASKONE, [`${PIR}askone.org`]: ASKONE, [`${VERISIGN}vercel.com`]: VERCEL });
    await rdap.lookup("www.askone.org");
    await rdap.lookup("vercel.com");
    await rdap.lookup("askone.org", "askone.org");
    const times = (prefix: string) => at.filter(([u]) => u.startsWith(prefix)).map(([, t]) => t);
    const pir = times(PIR);
    expect(pir).toHaveLength(3);
    for (let i = 1; i < pir.length; i++) expect(pir[i] - pir[i - 1]).toBeGreaterThanOrEqual(GAP_MS);
    // Verisign's request went out between PIR's, without waiting for PIR's turn.
    expect(times(VERISIGN)[0]).toBe(pir[1]);
  });

  it("backs off a server that answers 429 for the rest of the pass, recording nothing, and until its Retry-After", async () => {
    let limited: RdapAnswer = { status: 429, body: "", retryAfter: "120" };
    const { clock, asked, rdap: fetching } = paced({ [BOOTSTRAP_URL]: BOOT, [`${PIR}askone.org`]: () => limited, [`${PIR}www.askone.org`]: () => limited, [`${VERISIGN}vercel.com`]: VERCEL });
    const pass = new Set<string>();
    expect(await fetching.lookup("askone.org", undefined, pass)).toEqual({ status: "busy", domain: "askone.org", server: "https://rdap.publicinterestregistry.org" });
    // The same pass: PIR is asked nothing more, another registry is.
    expect(await fetching.lookup("www.askone.org", undefined, pass)).toMatchObject({ status: "busy" });
    expect(await fetching.lookup("vercel.com", undefined, pass)).toMatchObject({ status: "found" });
    expect(asked(PIR)).toBe(1);
    // A later pass within the two minutes it asked for: still nothing.
    expect(await fetching.lookup("askone.org", undefined, new Set())).toMatchObject({ status: "busy" });
    expect(asked(PIR)).toBe(1);
    clock.now += 120_000;
    limited = ASKONE;
    expect(await fetching.lookup("askone.org", undefined, new Set())).toMatchObject({ status: "found" });
    // A 429 with no Retry-After backs off the pass only.
    limited = { status: 429, body: "" };
    expect(await fetching.lookup("askone.org", undefined, new Set())).toMatchObject({ status: "busy" });
    limited = ASKONE;
    expect(await fetching.lookup("askone.org", undefined, new Set())).toMatchObject({ status: "found" });
  });

  it("reads Retry-After as seconds or a date, within a day", () => {
    const now = Date.parse("2026-10-22T20:00:00Z");
    expect(retryAfterMs("30", now)).toBe(30_000);
    expect(retryAfterMs("Thu, 22 Oct 2026 20:05:00 GMT", now)).toBe(300_000);
    expect(retryAfterMs("999999999", now)).toBe(86_400_000);
    expect(retryAfterMs(undefined, now)).toBeNull();
    expect(retryAfterMs("soon", now)).toBeNull();
    expect(retryAfterMs("Thu, 22 Oct 2026 19:00:00 GMT", now)).toBeNull();
  });
});

describe("the guarded fetch", () => {
  let server: https.Server;
  let base = "";
  let hang = false;

  beforeAll(async () => {
    server = https.createServer({ key: tls("localhost.key"), cert: tls("localhost.pem") }, (req, res) => {
      if (hang) return;
      if (req.url === "/big") res.writeHead(200).end("x".repeat(4096));
      else if (req.url === "/domain/limited.org") res.writeHead(429, { "retry-after": "30" }).end("slow down");
      else res.writeHead(req.url === "/domain/askone.org" ? 200 : 404, { "content-type": "application/rdap+json" }).end(ASKONE.status === 200 ? ASKONE.body : "");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    // This fixture listens on IPv4; localhost may resolve to ::1 first. The certificate has
    // the 127.0.0.1 SAN, so using the bound address preserves TLS verification on every host.
    base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it("refuses an RDAP server on a private address, as every check does", async () => {
    // The production guard: localhost resolves to a loopback address, which it refuses.
    expect(await guardedFetch()(`${base}/domain/askone.org`, 65536)).toMatchObject({ error: expect.stringMatching(/private/) });
    expect(await guardedFetch()("https://127.0.0.1/domain/askone.org", 65536)).toMatchObject({ error: expect.stringMatching(/private/) });
  });

  it("asks only over https", async () => {
    expect(await guardedFetch({ allow: () => true })("http://localhost/domain/askone.org", 65536)).toEqual({ error: "Not an https address" });
  });

  it("answers with the status and body, reads a bounded body, and gives up after its timeout", async () => {
    const fetch = guardedFetch({ allow: () => true, ca: tls("ca.pem"), timeoutSec: 1 });
    const ok = await fetch(`${base}/domain/askone.org`, 65536);
    expect(ok).toMatchObject({ status: 200 });
    expect(parseDomain(JSON.parse((ok as { body: string }).body), "askone.org")).toMatchObject({ domain: "askone.org" });
    expect(await fetch(`${base}/domain/www.askone.org`, 65536)).toMatchObject({ status: 404 });
    expect(await fetch(`${base}/big`, 1024)).toEqual({ error: "The answer was over 1 KB" });
    expect(await fetch(`${base}/domain/limited.org`, 65536)).toEqual({ status: 429, body: "", retryAfter: "30" });
    hang = true;
    const started = Date.now();
    expect(await fetch(`${base}/domain/askone.org`, 65536)).toMatchObject({ error: expect.stringMatching(/No answer within 1 s/) });
    expect(Date.now() - started).toBeLessThan(5000);
    hang = false;
  });
});
