import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/public-metadata";
import { Comparison } from "@/components/landing/Comparison";
import { PlanPicker } from "@/components/landing/PlanPicker";
import { soonList } from "@/components/landing/plan-copy";
import { PlanTable } from "@/components/PlanTable";
import { SoonTag } from "@/components/Tags";
import { soonAreas } from "@/lib/launch";
import { limits } from "@/lib/plans";
import { ADDRESS_LINE, COMPANY, legalContactEmail } from "@/lib/legal";

const F = limits.free;

export const metadata: Metadata = {
  ...publicPageMetadata("/pricing"),
  title: "Pricing",
  description: `Free for ${F.apps === 1 ? "one app" : `${F.apps} apps`} and ${F.monitors} monitors with commercial use. Compare Builder's higher limits and monthly or yearly billing.`,
};

export default function Pricing() {
  const contact = legalContactEmail();
  return (
    <>
      <section className="wrap band-tight stack-lg">
        <div className="stack">
          <h1 className="t-display">Free for most apps. Builder when you need more.</h1>
          <p className="t-lead">Both plans check what your app returns, not just that it answers. Builder adds scale and polish for the pages your users see.</p>
        </div>
        <PlanPicker />
      </section>

      <section className="wrap band-tight stack" aria-labelledby="all">
        <h2 id="all" className="t-section-lg">Everything in each plan</h2>
        <PlanTable />
      </section>

      <section className="wrap band-tight">
        <Comparison headingLevel={2} />
      </section>

      <section className="wrap band-tight" aria-labelledby="terms">
        <h2 id="terms" className="t-section-lg" style={{ marginBottom: "var(--s-5)" }}>The fine print, in plain words</h2>
        <dl className="faq">
          {soonAreas.length > 0 && (
            <div>
              <dt className="row">What does <SoonTag /> mean?</dt>
              <dd>That part isn&rsquo;t running yet, so it isn&rsquo;t what you&rsquo;re paying for. When it ships, each plan gets it as the plan table above shows, at no extra cost. Today that&rsquo;s {soonList()}.</dd>
            </div>
          )}
          {/* The refund promise, in decisions.md's words ("Sell a narrower V1 that works"). */}
          <div>
            <dt>What if Staygreen shuts down?</dt>
            <dd>You get a refund for the unused part of your plan.</dd>
          </div>
          <div>
            <dt>What happens if I cancel Builder?</dt>
            <dd>
              You keep Builder until the end of what you paid for, then move to Free. Nothing is deleted: every app stays, monitors over {F.monitors} pause, {F.statusPages === 1 ? "status pages after the first" : `status pages after the first ${F.statusPages}`} stop being served and say why, and all of it comes back if you upgrade again. Adding another app waits until you&rsquo;re within Free&rsquo;s {F.apps === 1 ? "one" : F.apps}.
            </dd>
          </div>
          <div>
            <dt>Is there a per-seat price, SMS, or usage credit?</dt>
            <dd>No. Builder lets you add teammates who get alerts without an account, at no cost. Staygreen doesn&rsquo;t do SMS, phone calls or on-call rotas.</dd>
          </div>
          <div>
            <dt>Do you send invoices?</dt>
            <dd>
              You get a receipt for each payment. An invoice with your company details and VAT number is available on request. Send those details to {contact
                ? <a className="link" href={`mailto:${contact}`}>{contact}</a>
                : <>{COMPANY.name}, {ADDRESS_LINE}</>}. Prices are in US dollars.
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
