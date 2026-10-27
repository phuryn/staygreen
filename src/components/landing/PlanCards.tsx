import Link from "next/link";
import { isBuilt } from "@/lib/launch";
import { offers, usd } from "@/lib/plan-offer";

/** The landing's two plans, in its own frame: the same lines and prices as Clerk's table, which
 *  stays on /pricing with checkout (`plan-offer.ts`). Only what runs today is listed; what is
 *  coming is said once, on /pricing. */
export function PlanCards() {
  const { free, builder } = offers;
  return (
    <div className="lp-plans" id="plans">
      <div className="lp-plan">
        <h3>{free.name}</h3>
        <p className="lp-plan-price"><span className="num">{usd(free.monthly)}</span><span>No card.</span></p>
        <ul className="ticks">{free.lines.map((l) => <li key={l}>{l}</li>)}</ul>
        <div className="lp-plan-cta"><Link href="/sign-up" className="btn btn-lg btn-block">Start free</Link></div>
      </div>
      <div className="lp-plan dark theme-dark">
        <h3>{builder.name}</h3>
        <p className="lp-plan-price">
          <span className="num">{usd(builder.yearlyMonthly)}</span>
          <span>a month, billed yearly. {usd(builder.monthly)} billed monthly.</span>
        </p>
        <ul className="ticks">{builder.lines.map((l) => <li key={l}>{l}</li>)}</ul>
        <div className="lp-plan-cta">
          {isBuilt("billing")
            ? <p className="lp-plan-note">Start free, then upgrade from your workspace&rsquo;s billing whenever you need it.</p>
            : <p className="lp-plan-note">Builder isn&rsquo;t on sale yet. You&rsquo;ll upgrade from your dashboard once it is.</p>}
        </div>
      </div>
    </div>
  );
}
