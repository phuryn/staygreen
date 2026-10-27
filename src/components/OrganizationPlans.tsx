"use client";

import { PricingTable, useOrganization } from "@clerk/nextjs";
import { soonList } from "@/components/landing/plan-copy";
import { soonAreas } from "@/lib/launch";

/** Clerk owns prices, the period selector and checkout. Its mounted table defaults
 * to annual (there is no period prop in this SDK); the browser suite pins that
 * vendor behavior. Both plan periods must be enabled in the Clerk dashboard.
 * Appearance inherits the root provider's kit tokens, including in the drawer.
 *
 * Each card's button sits under its price, so Builder's isn't below its whole feature list.
 * Clerk lines the cards' rows up with subgrid, so a card without a button (the workspace's
 * current plan) put its features in the row of the other card's button, which then sat under
 * an empty band as tall as that list (the owner, 2026-10-24). Each body is a plain column. */
const appearance = { elements: { pricingTableCardBody: { display: "flex", flexDirection: "column" } } } as const;

export function OrganizationPlans() {
  const { isLoaded, organization } = useOrganization();
  // Wait for Clerk to identify the payer before mounting its checkout controls.
  // Signed-out visitors have no active organization; Clerk handles their signup.
  if (!isLoaded) return <p className="t-2" role="status">Loading workspace and plans…</p>;
  return (
    <div className="stack-sm">
      {organization && <p className="t-2">Plans and payment for workspace: <strong>{organization.name}</strong>.</p>}
      <PricingTable
        key={organization?.id ?? "signed-out"}
        for="organization"
        ctaPosition="top"
        appearance={appearance}
        newSubscriptionRedirectUrl="/app/billing"
        fallback={<p className="t-2" role="status">Loading plans and prices…</p>}
      />
      {soonAreas.length > 0 && <p className="t-meta">Coming soon: {soonList()}. These aren&rsquo;t part of what you&rsquo;re paying for today.</p>}
    </div>
  );
}
