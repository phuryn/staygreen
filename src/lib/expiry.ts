import { plural } from "./format";
import type { DomainRegistration, Monitor } from "./model";

/* An SSL monitor's two expiries, as the screens say them (`spec.md § 3.2`): the certificate the
   probes' check read (migration 020, `cert_*` on the monitor's row) and the domain registration
   the probes' leader read through RDAP (`domain_registrations`, `probe/domains.ts`). Pure, so
   every sentence is tested without a database. Each part says plainly what is missing when it
   is, and names no source that wasn't used: a TLD with no RDAP service says so, and nothing reads
   WHOIS yet. No reminder is sent for either: those are alerting's (stage 2.3). */

const DAY_MS = 86_400_000;

/** Whole days from `now` to `t`, below zero once `t` has passed (`src/checks/cert.ts` counts the
 *  same way). */
export const daysUntil = (t: number, now: number) => Math.floor((t - now) / DAY_MS);

/** What `monitors` holds about the certificate (020), and the host the row names now
 *  (`target_host`, lowercase with no trailing dot), which is what `cert_host` was copied from. */
export type CertRead = { cert_host: string | null; cert_expires_at: string | null; cert_issuer: string | null; target_host?: string | null };
/** One row of `workspace_domains` (020). */
export type DomainRead = { host: string; name: string; status: string; expires_at: string | null; registrar: string | null };

export function registrationOf(r: DomainRead | undefined, now: number): DomainRegistration | undefined {
  if (!r) return undefined;
  if (r.status === "found") {
    const t = r.expires_at ? Date.parse(r.expires_at) : NaN;
    return { status: "found", name: r.name, days: Number.isFinite(t) ? daysUntil(t, now) : null, registrar: r.registrar };
  }
  if (r.status === "no_rdap" || r.status === "not_found" || r.status === "failed") return { status: r.status, name: r.name };
  return undefined;
}

/** The `ssl` part of a monitor. A certificate read from another host (before an edit) is not this
 *  host's, so it is left out until a check of this host reads one. */
export function sslOf(host: string, cert: CertRead, domain: DomainRead | undefined, now: number): NonNullable<Monitor["ssl"]> {
  const ssl: NonNullable<Monitor["ssl"]> = { host };
  const t = cert.cert_expires_at ? Date.parse(cert.cert_expires_at) : NaN;
  if (cert.cert_host && cert.cert_host === (cert.target_host ?? host.toLowerCase()) && Number.isFinite(t)) {
    ssl.certDays = daysUntil(t, now);
    if (cert.cert_issuer) ssl.issuer = cert.cert_issuer;
  }
  const registration = registrationOf(domain, now);
  if (registration) ssl.domain = registration;
  return ssl;
}

const tldOf = (name: string) => name.slice(name.lastIndexOf(".") + 1);

/** Past this, a certificate's days are said in words: one valid until 9999 (RFC 5280's value for
 *  a certificate with no expiry, which the database keeps, 020) isn't 2.9 million days of
 *  anything a builder plans around. */
const CENTURY_DAYS = 36_500;

/** A stat cell: a number of days with its unit, or a few words in its place, and a note. */
export type ExpiryCell = { days: number | null; text: string; note?: string };

/** The Certificate cell. `missing` is what the monitor's other numbers say in their place
 *  ("Not checked yet" or "No data yet", `noNumber`). */
export function certCell(ssl: Monitor["ssl"], missing: string): ExpiryCell {
  const days = ssl?.certDays;
  if (days === undefined) return { days: null, text: missing };
  if (days < 0) return { days: null, text: "Expired", note: ssl?.issuer };
  if (days > CENTURY_DAYS) return { days: null, text: "Over 100 years left", note: ssl?.issuer };
  return { days, text: days === 1 ? "day left" : "days left", note: ssl?.issuer };
}

/** The Domain registration cell. */
export function domainCell(ssl: Monitor["ssl"]): ExpiryCell {
  const d = ssl?.domain;
  if (!d) return { days: null, text: "Not looked up yet" };
  const tld = tldOf(d.name);
  switch (d.status) {
    case "found": {
      const note = d.registrar ? `${d.name}, ${d.registrar}` : d.name;
      if (d.days === null) return { days: null, text: "No expiry published", note: `${d.name}: the .${tld} registry's RDAP gives no date` };
      if (d.days < 0) return { days: null, text: "Past its expiry date", note };
      return { days: d.days, text: d.days === 1 ? "day left" : "days left", note };
    }
    case "no_rdap":
      return { days: null, text: "Not available", note: `.${tld} has no RDAP service, and Staygreen doesn't read WHOIS yet` };
    case "not_found":
      return { days: null, text: "No record", note: `The .${tld} registry has no record of ${d.name}` };
    case "failed":
      return { days: null, text: "Not read yet", note: "The registry didn't answer. Staygreen asks again every hour." };
  }
}

/** The list row's "Latest checks" line for an SSL monitor whose certificate is known, the domain
 *  beside it in a few words; null until a check has read the certificate. */
export function sslLine(ssl: Monitor["ssl"]): string | null {
  const days = ssl?.certDays;
  if (days === undefined) return null;
  return `Certificate ${days < 0 ? "expired" : days > CENTURY_DAYS ? "over 100 years" : plural(days, "day")}, domain ${domainWords(ssl?.domain)}`;
}

function domainWords(d: DomainRegistration | undefined): string {
  if (!d) return "not looked up yet";
  switch (d.status) {
    case "found":
      return d.days === null ? "expiry not published" : d.days < 0 ? "past its expiry date" : plural(d.days, "day");
    case "no_rdap":
      return `not available for .${tldOf(d.name)}`;
    case "not_found":
      return "not found";
    case "failed":
      return "not read yet";
  }
}
