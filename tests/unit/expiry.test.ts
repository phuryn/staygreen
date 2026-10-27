import { describe, expect, it } from "vitest";
import { certCell, daysUntil, domainCell, registrationOf, sslLine, sslOf } from "@/lib/expiry";
import { lastLine } from "@/components/MonitorTable";
import { DAY, monitor, NOW } from "./fixtures";

/* An SSL monitor's certificate and domain, as the screens say them (`src/lib/expiry.ts`): what
   the probes' check read and what the registry said, each saying plainly what is missing when it
   is, and naming no source that wasn't used. */

const iso = (t: number) => new Date(t).toISOString();
const cert = (over: Partial<{ cert_host: string | null; cert_expires_at: string | null; cert_issuer: string | null }> = {}) => ({
  cert_host: "askone.org", cert_expires_at: iso(NOW + 63 * DAY + 3_600_000), cert_issuer: "Let's Encrypt", ...over,
});
const found = { host: "askone.org", name: "askone.org", status: "found", expires_at: iso(NOW + 312 * DAY), registrar: "GoDaddy.com, LLC" };

describe("sslOf, from the row and the registry", () => {
  it("counts whole days left, the way the check does", () => {
    expect(daysUntil(NOW + 63 * DAY + 3_600_000, NOW)).toBe(63);
    expect(daysUntil(NOW + 3_600_000, NOW)).toBe(0);
    expect(daysUntil(NOW - 3_600_000, NOW)).toBe(-1);
  });

  it("gives the certificate the check read and the domain the registry answered for", () => {
    expect(sslOf("askone.org", cert(), found, NOW)).toEqual({
      host: "askone.org", certDays: 63, issuer: "Let's Encrypt",
      domain: { status: "found", name: "askone.org", days: 312, registrar: "GoDaddy.com, LLC" },
    });
  });

  it("leaves out a certificate read from another host, before an edit", () => {
    expect(sslOf("www.askone.org", cert(), undefined, NOW)).toEqual({ host: "www.askone.org" });
    expect(sslOf("www.askone.org", { ...cert(), target_host: "www.askone.org" }, undefined, NOW)).toEqual({ host: "www.askone.org" });
  });

  it("matches the certificate to the host the row derives, as the probe stored it", () => {
    // A target typed with a trailing dot: the database's host drops it, and so did the probe.
    expect(sslOf("askone.org.", { ...cert(), target_host: "askone.org" }, undefined, NOW)).toMatchObject({ certDays: 63, issuer: "Let's Encrypt" });
  });

  it("has nothing until a check or the registry filled it", () => {
    expect(sslOf("askone.org", cert({ cert_host: null, cert_expires_at: null, cert_issuer: null }), undefined, NOW)).toEqual({ host: "askone.org" });
  });

  it("keeps a registry's missing expiry as missing, and each reason there is no domain", () => {
    expect(registrationOf({ ...found, expires_at: null }, NOW)).toEqual({ status: "found", name: "askone.org", days: null, registrar: "GoDaddy.com, LLC" });
    for (const status of ["no_rdap", "not_found", "failed"] as const) {
      expect(registrationOf({ host: "staygreen.io", name: "staygreen.io", status, expires_at: null, registrar: null }, NOW)).toEqual({ status, name: "staygreen.io" });
    }
  });
});

describe("the monitor page's cells", () => {
  it("say days left with the issuer, or what is missing in the monitor's own words", () => {
    expect(certCell(sslOf("askone.org", cert(), undefined, NOW), "No data yet")).toEqual({ days: 63, text: "days left", note: "Let's Encrypt" });
    expect(certCell({ host: "askone.org" }, "Not checked yet")).toEqual({ days: null, text: "Not checked yet" });
    expect(certCell({ host: "askone.org", certDays: 1 }, "x")).toMatchObject({ days: 1, text: "day left" });
    expect(certCell({ host: "askone.org", certDays: -2, issuer: "R11" }, "x")).toEqual({ days: null, text: "Expired", note: "R11" });
    // Valid until 9999, RFC 5280's "no expiry": said in words, not as millions of days.
    const forever = sslOf("askone.org", cert({ cert_expires_at: "9999-12-31T23:59:59.000Z", cert_issuer: "Internal CA" }), undefined, NOW);
    expect(certCell(forever, "x")).toEqual({ days: null, text: "Over 100 years left", note: "Internal CA" });
    expect(sslLine(forever)).toBe("Certificate over 100 years, domain not looked up yet");
    expect(certCell({ host: "askone.org", certDays: 36_500 }, "x")).toMatchObject({ days: 36_500, text: "days left" });
  });

  it("name the domain and its registrar, never RDAP before anything was read from it", () => {
    expect(domainCell(sslOf("www.askone.org", cert({ cert_host: null, cert_expires_at: null }), { ...found, host: "www.askone.org" }, NOW)))
      .toEqual({ days: 312, text: "days left", note: "askone.org, GoDaddy.com, LLC" });
    const unknown = domainCell({ host: "askone.org" });
    expect(unknown).toEqual({ days: null, text: "Not looked up yet" });
    expect(JSON.stringify(unknown)).not.toMatch(/RDAP/);
  });

  it("say plainly why there is no expiry", () => {
    const d = (domain: NonNullable<Parameters<typeof domainCell>[0]>["domain"]) => domainCell({ host: "x", domain });
    expect(d({ status: "found", name: "example.de", days: null, registrar: null })).toEqual({ days: null, text: "No expiry published", note: "example.de: the .de registry's RDAP gives no date" });
    expect(d({ status: "found", name: "askone.org", days: -3, registrar: "GoDaddy.com, LLC" })).toMatchObject({ days: null, text: "Past its expiry date" });
    expect(d({ status: "no_rdap", name: "staygreen.io" })).toEqual({ days: null, text: "Not available", note: ".io has no RDAP service, and Staygreen doesn't read WHOIS yet" });
    expect(d({ status: "not_found", name: "app.gone.org" })).toEqual({ days: null, text: "No record", note: "The .org registry has no record of app.gone.org" });
    expect(d({ status: "failed", name: "askone.org" })).toMatchObject({ days: null, text: "Not read yet" });
  });
});

describe("the list row", () => {
  it("gives both expiries once a check has read the certificate", () => {
    expect(sslLine({ host: "askone.org", certDays: 63, domain: { status: "found", name: "askone.org", days: 312, registrar: null } })).toBe("Certificate 63 days, domain 312 days");
    expect(sslLine({ host: "askone.org", certDays: 1 })).toBe("Certificate 1 day, domain not looked up yet");
    expect(sslLine({ host: "staygreen.io", certDays: 80, domain: { status: "no_rdap", name: "staygreen.io" } })).toBe("Certificate 80 days, domain not available for .io");
    expect(sslLine({ host: "askone.org", certDays: -1 })).toBe("Certificate expired, domain not looked up yet");
    expect(sslLine({ host: "askone.org" })).toBeNull();
  });

  it("is the Latest checks cell for an SSL monitor, and falls back to its window before the certificate is known", () => {
    const ssl = monitor({ id: "m1", type: "ssl", target: "askone.org", ssl: { host: "askone.org", certDays: 63 } });
    expect(lastLine(ssl, NOW)).toEqual({ main: "Certificate 63 days, domain not looked up yet", sub: "checked every 6 hours" });
    const failed = monitor({ id: "m2", type: "ssl", target: "askone.org", ssl: { host: "askone.org" }, reports: [{ loc: "tor1", end: NOW - 60_000, checks: 1, failures: 1, p50: null }] });
    expect(lastLine(failed, NOW).main).toBe("Failed");
  });
});
