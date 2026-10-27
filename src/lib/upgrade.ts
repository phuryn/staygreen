import { builderOnlyLocations, builderRegion, cities, every, list } from "@/components/landing/plan-copy";
import { isBuilt, isLive } from "./launch";
import { limits, limitsOf, type Limits, type PlanId } from "./plans";

/* What Builder adds at each place a Free workspace meets it (`design/README.md`, principle 8).

   A gated control keeps its look and carries the Builder mark (`BuilderTag`,
   `src/components/Tags.tsx`); pressing it opens one of these, never nothing and never an error.
   Each sentence is about the plans, read from the plan module, and never about this workspace:
   the screen that shows a mark has already decided the workspace is on Free, and says what it is
   using in its own copy, where it has the numbers to check (`docs/TESTS.md § What a screen may
   claim`). Pure, so the unit suite holds every sentence against `limits`. */

const F = limits.free;
const B = limits.builder;

export type Offer = { title: string; body: string };

export const offers = {
  builder: {
    title: "What Builder adds",
    body: `${B.apps} apps with a status page each, ${B.monitors} monitors checked ${every(B.httpIntervalMin)}, a third location in ${builderRegion}${isLive("frankfurt") ? "" : " (Coming soon)"}, routing by severity, ${B.historyLabel} of history, and pages without the Staygreen mark.`,
  },
  apps: {
    title: "More apps with Builder",
    body: `Free includes ${F.apps === 1 ? "one app" : `${F.apps} apps`}. Builder includes ${B.apps}, each with its own monitors and status page.`,
  },
  statusPages: {
    title: "More status pages with Builder",
    body: `Free includes ${F.statusPages === 1 ? "one status page" : `${F.statusPages} status pages`}. Builder includes ${B.statusPages}, one for every app, and can take the Staygreen mark off them.`,
  },
  assertions: {
    title: "More assertions with Builder",
    body: `Free checks up to ${F.assertions} assertions on an HTTP monitor. Builder checks up to ${B.assertions}.`,
  },
  heartbeatAssertions: {
    title: "More assertions with Builder",
    body: `Free checks ${F.heartbeatAssertions === 1 ? "one assertion" : `up to ${F.heartbeatAssertions} assertions`} on a heartbeat. Builder checks up to ${B.heartbeatAssertions}.`,
  },
  location: {
    title: "A third location with Builder",
    body: `Builder adds ${list(cities(builderOnlyLocations))}, in ${builderRegion}${isLive("frankfurt") ? "" : " (Coming soon)"}, to ${list(cities(F.locations))}, and checks ${every(B.httpIntervalMin)} instead of ${every(F.httpIntervalMin)}.`,
  },
  whiteLabel: {
    title: "Your brand alone with Builder",
    body: "Builder takes “Powered by Staygreen” off your status pages, and the Staygreen name off your widget and badge.",
  },
  privatePages: {
    title: "Pages kept out of search with Builder",
    body: "Builder can ask search engines not to list a status page. Members-only pages come with Builder when they ship.",
  },
  alertRules: {
    title: "Alert rules with Builder",
    body: `Builder adds routing by severity. Alert delay and repeat while down${isLive("alertTiming") ? "" : " (Coming soon)"}, and maintenance windows${isLive("maintenanceWindows") ? "" : " (Coming soon)"}, are also part of Builder when available.`,
  },
  teammates: {
    title: "Teammates without an account with Builder",
    body: "Builder sends alerts to email addresses that aren't a member's, as many as you like, each confirmed by its owner first. On every plan, each member gets alerts at their own address.",
  },
  api: {
    title: "More API calls with Builder",
    body: `Builder allows ${B.apiPerMin} calls a minute to the MCP server and the API, where Free allows ${F.apiPerMin}.`,
  },
  history: {
    title: "A year of history with Builder",
    body: `Builder keeps ${B.historyLabel} of daily uptime. CSV export is ${isLive("csvExport") ? "included" : "Coming soon"}. Free keeps ${F.historyLabel}.`,
  },
} satisfies Record<string, Offer>;

export type OfferKey = keyof typeof offers;

/** Where every mark leads: the billing page, which holds the checkout once billing ships. Until
 *  then the button says what it opens, never "Upgrade", and the note says nothing is charged. */
export function upgradeAction(billingBuilt = isBuilt("billing")): { label: string; href: string; note: string | null } {
  return billingBuilt
    ? { label: "Upgrade to Builder", href: "/app/billing", note: null }
    : { label: "See Builder", href: "/app/billing", note: "Builder isn’t on sale yet, so nothing here charges you." };
}

/** Whether a workspace can add an app: `open` below its plan's limit; `builder` on Free with every
 *  app Free includes, which Builder lifts, so the control carries the mark; `full` on Builder at
 *  its own limit, which nothing lifts. Counted over the whole workspace, never the app the rail
 *  has chosen. `create_app` holds the limit itself (`AGENTS.md § 2.8`); this only picks the
 *  control. */
export function addAppGate(s: { plan: PlanId; limits?: Limits; apps: readonly unknown[] }): "open" | "builder" | "full" {
  if (s.apps.length < limitsOf(s).apps) return "open";
  return s.plan === "free" ? "builder" : "full";
}
