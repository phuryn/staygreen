"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { Loading, PageHead } from "@/components/Shell";
import { PlanTable } from "@/components/PlanTable";
import { OrganizationPlans } from "@/components/OrganizationPlans";
import { builderOnlyLocations, builderRegion } from "@/components/landing/plan-copy";
import { SoonTag } from "@/components/Tags";
import { isBuilt, isLive } from "@/lib/launch";
import { limits, locations, limitsOf } from "@/lib/plans";
import { useWorkspace, type Workspace } from "@/lib/workspace-store";
import { simulateBuilderPlan } from "./actions";

type Simulation = { builder: boolean } | null;

const cities = (ids: readonly (keyof typeof locations)[]) => {
  const names = ids.map((l) => locations[l].city);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
};

function Usage({ label, used, of, note }: { label: string; used: number; of: number; note?: string }) {
  const ratio = of ? used / of : 0;
  return (
    <div className="pb-usage">
      <div className="spread">
        <span className="t-strong">{label}</span>
        <span className="num t-2">{used} of {of}</span>
      </div>
      <div className={`meter${ratio > 0.9 ? " full" : ""}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={of} aria-valuenow={used}>
        <span style={{ width: `${Math.min(100, ratio * 100)}%` }} />
      </div>
      {note && <span className="t-meta">{note}</span>}
    </div>
  );
}

function Billing({ s, simulation }: { s: Workspace; simulation: Simulation }) {
  const builder = s.plan === "builder";
  const L = limitsOf(s);
  const B = limits.builder;
  const manage = s.can["billing:manage"];
  // Counted the way the database counts them against the plan: SSL checks added for a host
  // don't count, and a heartbeat counts as a monitor and as a heartbeat.
  const monitors = s.monitors.filter((m) => !m.auto).length;
  const heartbeats = s.monitors.filter((m) => m.type === "heartbeat").length;
  const simulated = !!simulation?.builder;
  // Clerk's table and checkout, for an admin of a workspace with a real plan. On Free it is the
  // page's first block, since every Builder mark leads here to upgrade (`upgradeAction`); on
  // Builder it follows the usage, beside managing the subscription. A simulated plan describes no
  // paid subscription, so these controls stay out until the developer returns to the real plan.
  const checkout = isBuilt("billing") && manage && !simulated;
  const plans = checkout && (
    <section className={builder ? "section pb-section-gap" : "section pb-upgrade"} aria-labelledby="checkout-h">
      <h2 id="checkout-h" className="t-section">{builder ? "Plans and payment" : "Upgrade to Builder"}</h2>
      <OrganizationPlans />
      {builder && <ManageSubscription />}
    </section>
  );

  return (
    <>
      <PageHead
        title="Plan and billing"
        sub={
          simulated
            ? "You're on Builder, simulated for development. Nothing is billed."
            : builder
              ? "You're on Builder."
              : "You're on Free. It stays free, and commercial use is allowed."
        }
      />

      {simulation && manage && <DevPlanSwitch on={simulation.builder} />}

      {!builder && plans}

      <div className={!builder && plans ? "pb-billing pb-section-gap" : "pb-billing"}>
        <section className="panel stack" aria-labelledby="use-h">
          <div className="stack-sm">
            <h2 id="use-h" className="t-section">{builder ? "Builder" : "Free"}: what you&apos;re using</h2>
            <span className="t-meta">
              {L.httpIntervalMin === 1 ? "1-minute" : `${L.httpIntervalMin}-minute`} checks from {cities(L.locations.filter((id) => locations[id].live))}, and {L.historyLabel} of history.
            </span>
            {builder && !isLive("frankfurt") && <span className="t-meta">Checks from {cities(builderOnlyLocations)} <SoonTag /></span>}
          </div>
          <Usage label="Apps" used={s.apps.length} of={L.apps} />
          <Usage label="Monitors" used={monitors} of={L.monitors} note="Heartbeats count here too. The SSL checks added for each host don't." />
          <Usage label="Heartbeats" used={heartbeats} of={L.heartbeats} note={L.heartbeatAssertions === 1 ? "1 assertion each" : `Up to ${L.heartbeatAssertions} assertions each`} />
          <Usage label="Status pages" used={s.pages.length} of={L.statusPages} />
        </section>

        {/* What Builder adds, said here only where Clerk's table above doesn't already say it. */}
        {!(checkout && !builder) && <section className="panel stack" aria-labelledby="plan-h">
          <div className="row">
            <h2 id="plan-h" className="t-section">Builder</h2>
            {!builder && !isBuilt("billing") && <SoonTag />}
          </div>
          {builder ? (
            <>
              <p className="t-2">This workspace is on Builder. Features marked Coming soon are still being built.</p>
              {simulated ? (
                <p className="callout callout-info">
                  <span>Simulated in this browser only. Clerk Billing isn&apos;t involved and nothing is charged. Turn the switch above off to go back to the plan you really have.</span>
                </p>
              ) : (
                manage && <p className="t-meta">Manage your subscription below to change or cancel it, update your payment method, or view statements.</p>
              )}
            </>
          ) : (
            <>
              <p className="t-2">
                {B.apps} apps, {B.httpIntervalMin}-minute checks, a third location in {builderRegion} ({cities(builderOnlyLocations)}){!isLive("frankfurt") && <> <SoonTag /></>}, {B.monitors} monitors, {B.statusPages} status pages, routing by severity, notify-only teammates, email subscribers {!isLive("subscribers") && <SoonTag />} and {B.historyLabel} of history.
              </p>
              {manage ? (
                isBuilt("billing") ? null : (
                  <p className="t-2">You can&apos;t upgrade yet. Paying for Builder arrives with the public launch, and nothing here will charge you before then.</p>
                )
              ) : (
                <p className="t-meta">A workspace admin can change the plan.</p>
              )}
            </>
          )}
        </section>}
      </div>

      {builder && plans}

      <section className="section pb-section-gap" aria-labelledby="cmp-h">
        <h2 id="cmp-h" className="t-section">Free and Builder side by side</h2>
        <div className="panel panel-flush">
          <PlanTable highlight={s.plan} />
        </div>
      </section>

      <section className="section" aria-labelledby="fine-h">
        <h2 id="fine-h" className="t-section">Downgrades and refunds</h2>
        <div className="stack-sm prose">
          <p className="t-2">Moving back to Free deletes nothing. Every app stays, though another can&apos;t be added until you&apos;re within Free&apos;s {limits.free.apps === 1 ? "one" : limits.free.apps}. Monitors beyond Free&apos;s {limits.free.monitors} pause, pages beyond the first stop being served and say why, and upgrading again restores them.</p>
          <p className="t-2">Monitor types marked Coming soon are included in both plans when they ship, at no extra cost.</p>
          <p className="t-2">If Staygreen ever shuts down, paying customers get a refund for the unused part of their plan.</p>
        </div>
      </section>
    </>
  );
}

function ManageSubscription() {
  const clerk = useClerk();
  return (
    <div className="stack-sm">
      <div><button type="button" className="btn" onClick={() => clerk.openOrganizationProfile()}>Manage subscription and payments</button></div>
      <p className="t-meta">Open Billing in your workspace settings to see statements, update payment details or cancel. Cancellation takes effect at the end of the paid period.</p>
    </div>
  );
}

/** Development only: rendered when `next dev` runs with DEV_PLAN_OVERRIDE=on (`session.ts`). */
function DevPlanSwitch({ on }: { on: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flip(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await simulateBuilderPlan(next);
      if (r.ok) router.refresh();
      else setError(r.reason);
    } catch {
      setError("That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel dev-only stack-sm" aria-label="Development only">
      <label className="switch">
        <input type="checkbox" role="switch" checked={on} disabled={busy} aria-describedby="dev-plan-hint" onChange={(e) => flip(e.target.checked)} />
        <span className="t-strong">Simulate Builder plan (development only)</span>
      </label>
      <span id="dev-plan-hint" className="hint">
        Sets a cookie in this browser, and every screen and limit then behaves as Builder. It works only under <code className="code">next dev</code> with <code className="code">DEV_PLAN_OVERRIDE=on</code>, and production never shows it.
      </span>
      {error && <span className="error" role="alert">{error}</span>}
    </section>
  );
}

export function BillingScreen({ simulation }: { simulation: Simulation }) {
  const s = useWorkspace();
  return s ? <Billing s={s} simulation={simulation} /> : <Loading />;
}
