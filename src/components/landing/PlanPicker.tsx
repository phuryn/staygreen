import Link from "next/link";
import { OrganizationPlans } from "@/components/OrganizationPlans";
import { isBuilt } from "@/lib/launch";

/** Public pages stay sessionless. Clerk enforces the active organization's billing
 * permission; the link also gives signed-out visitors a sign-in path back to billing. */
export function PlanPicker() {
  return (
    <div className="stack" id="plans">
      {isBuilt("billing") ? (
        <>
          <OrganizationPlans />
          <p className="t-2">Choose monthly or yearly billing. Yearly is selected first. A workspace admin can subscribe or change the plan.</p>
          {/* Clerk's cards carry no button for a signed-out visitor, so the way in sits here. */}
          <div className="cluster">
            <Link href="/sign-up" className="btn btn-primary">Start free</Link>
            <Link href="/app/billing" className="btn">Open workspace billing</Link>
          </div>
        </>
      ) : (
        <>
          <p className="t-2">Builder isn&rsquo;t on sale yet. You&rsquo;ll upgrade from your dashboard once it is.</p>
          <div><Link href="/sign-up" className="btn">Start free</Link></div>
        </>
      )}
    </div>
  );
}
