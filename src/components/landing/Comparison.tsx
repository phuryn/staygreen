import Link from "next/link";
import { isLive } from "@/lib/launch";
import { has, limits } from "@/lib/plans";

// What the same things cost elsewhere: the cheapest plan that unlocks each one, per vendor.
//
// Every competitor figure is a receipt from `docs/product/research/competitors-202610.md`,
// labelled V there (read from the vendor's own pricing page on the date below). A cell the
// research could not verify says so instead of guessing; re-verify before changing a figure,
// and change `checked` with it. "Not offered" is only for a capability absent from the vendor's
// own exhaustive list of monitor types (`competitors-stripe-supabase-202610.md`, `absentChecked`). Staygreen's column names the tier from the plan
// module and links to live prices; only the dated competitor figures are kept here.

const checked = "2026-10-18";
const absentChecked = "2026-10-24";
const dateLabel = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const checkedLabel = dateLabel(checked);

type Cell = { amount: number; currency: "USD" | "EUR"; plan: string } | { plan: "Free" | "Builder" } | { unknown: string } | { absent: true };
type Vendor = { id: string; name: string; source: string };

const vendors: Vendor[] = [
  { id: "uptimerobot", name: "UptimeRobot", source: "https://uptimerobot.com/pricing/" },
  { id: "betterstack", name: "Better Stack", source: "https://betterstack.com/pricing" },
  { id: "openstatus", name: "OpenStatus", source: "https://www.openstatus.dev/pricing" },
  { id: "hyperping", name: "Hyperping", source: "https://hyperping.com/pricing" },
];

const free: Cell = { plan: "Free" };
const builder: Cell = { plan: "Builder" };
const staygreenFor = (onFree: boolean): Cell => (onFree ? free : builder);
const absent: Cell = { absent: true };
const nowhere = { uptimerobot: absent, betterstack: absent, openstatus: absent, hyperping: absent };

const rows: { label: string; staygreen: Cell; cells: Record<string, Cell> }[] = [
  // What no incumbent watches (plan.md, Phase 3). Each vendor's monitor types
  // were read on `absentChecked`; UptimeRobot and Better Stack only watch Stripe's status page.
  { label: "Stripe webhook failures", staygreen: staygreenFor(limits.free.stripeAccounts > 0), cells: nowhere },
  { label: "A paused Supabase project", staygreen: staygreenFor(limits.free.supabaseMonitors !== 0), cells: nowhere },
  {
    label: "Webhook alerts",
    // Every alert channel is on both plans (spec.md § 1).
    staygreen: free,
    cells: {
      uptimerobot: { amount: 41, currency: "EUR", plan: "Team" },
      betterstack: { amount: 34, currency: "USD", plan: "One responder seat" },
      openstatus: { amount: 30, currency: "USD", plan: "Starter" },
      hyperping: { amount: 24, currency: "USD", plan: "Essentials, billed yearly" },
    },
  },
  {
    label: "Checks every minute",
    staygreen: staygreenFor(limits.free.httpIntervalMin <= 1),
    cells: {
      uptimerobot: { amount: 10, currency: "EUR", plan: "Solo" },
      betterstack: { amount: 34, currency: "USD", plan: "One responder seat" },
      openstatus: { amount: 30, currency: "USD", plan: "Starter" },
      hyperping: { amount: 24, currency: "USD", plan: "Essentials, billed yearly" },
    },
  },
  {
    label: "A status page on your own domain",
    // An own domain with automatic TLS is on both plans (spec.md § 1), once it runs.
    staygreen: isLive("customDomains") ? free : { unknown: "Coming soon" },
    cells: {
      uptimerobot: { amount: 10, currency: "EUR", plan: "Solo" },
      betterstack: { unknown: "Its pricing page doesn't say which plan" },
      openstatus: { amount: 30, currency: "USD", plan: "Starter" },
      hyperping: { amount: 24, currency: "USD", plan: "Essentials, billed yearly" },
    },
  },
  {
    label: "A status page without the vendor's name on it",
    staygreen: staygreenFor(has("free", "white_label")),
    cells: {
      uptimerobot: { amount: 41, currency: "EUR", plan: "Team" },
      betterstack: { amount: 284, currency: "USD", plan: "A seat, plus white-label for one page" },
      openstatus: { amount: 330, currency: "USD", plan: "Starter plus white-label" },
      hyperping: { amount: 249, currency: "USD", plan: "Business, billed yearly" },
    },
  },
];

function Value({ c }: { c: Cell }) {
  if ("unknown" in c) return <span className="cmp-unknown">{c.unknown}</span>;
  if ("absent" in c) return <span className="cmp-unknown">Not offered</span>;
  if (!("amount" in c)) return <Link className="link" href="/pricing#plans">{c.plan}</Link>;
  return (
    <>
      <span className="cmp-price num">{new Intl.NumberFormat("en-US", { style: "currency", currency: c.currency, maximumFractionDigits: 0 }).format(c.amount)}/mo</span>
      <span className="cmp-plan">{c.plan}</span>
    </>
  );
}

export function Comparison({ headingLevel = 3 }: { headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="cmp" aria-labelledby="cmp-h">
      <div className="cmp-head">
        <H id="cmp-h" className="cmp-title">What the same things cost elsewhere</H>
        <p className="cmp-lead">
          The cheapest plan that unlocks each one, from each vendor&rsquo;s own pricing page on <time dateTime={checked}>{checkedLabel}</time>. Billed monthly unless it says otherwise.
        </p>
      </div>

      <div className="cmp-wide">
        <table className="table cmp-table">
          <caption className="sr-only">Cheapest plan that unlocks each feature, by vendor, as of {checkedLabel}</caption>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Feature</span></th>
              <th scope="col" className="cmp-us">Staygreen</th>
              {vendors.map((v) => <th key={v.id} scope="col">{v.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td className="cmp-us"><Value c={r.staygreen} /></td>
                {vendors.map((v) => <td key={v.id}><Value c={r.cells[v.id]} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* The same figures as one list per feature, for a phone. Only one of the two is ever
          displayed, so a screen reader meets the figures once. */}
      <div className="cmp-narrow">
        {rows.map((r) => (
          <div key={r.label} className="cmp-card" role="group" aria-label={r.label}>
            <p className="cmp-card-title">{r.label}</p>
            <dl className="cmp-dl">
              <div className="cmp-us">
                <dt>Staygreen</dt>
                <dd><Value c={r.staygreen} /></dd>
              </div>
              {vendors.map((v) => (
                <div key={v.id}>
                  <dt>{v.name}</dt>
                  <dd><Value c={r.cells[v.id]} /></dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <p className="cmp-foot">
        Not offered means it isn&rsquo;t among the monitor types the vendor lists, read on <time dateTime={absentChecked}>{dateLabel(absentChecked)}</time>. Watching Stripe&rsquo;s own status page doesn&rsquo;t count: it can&rsquo;t see your failed deliveries.{" "}
        UptimeRobot showed its prices in euros, so they stay in euros here. Prices change: check{" "}
        {vendors.map((v, i) => (
          <span key={v.id}>
            <a className="link" href={v.source} rel="noreferrer">{v.name}</a>
            {i < vendors.length - 2 ? ", " : i === vendors.length - 2 ? " and " : ""}
          </span>
        ))}{" "}
        before you decide.
      </p>
    </section>
  );
}
