// The plans as Clerk's pricing table shows them, read from the setup both Clerk instances run
// (`scripts/clerk/billing.json`, `docs/billing.md`). The landing's own cards print these lines and
// prices, so they can't say something different from Clerk's table on /pricing (owner,
// 2026-10-24). `clerk-billing-config.test.ts` pins the lines to the plan module, and
// `tests/integration/clerk-plans.test.ts` pins this file to the instance.

import setup from "../../scripts/clerk/billing.json";

type Feature = { name: string; publicly_visible: boolean };
type Plan = { name: string; amount: number; annual_monthly_amount: number; features: string[] };

const { features, plans } = setup.billing as unknown as { features: Record<string, Feature>; plans: Record<"free_org" | "builder", Plan> };

export type Offer = {
  name: string;
  /** US dollars a month, billed monthly. */
  monthly: number;
  /** US dollars a month, billed yearly. */
  yearlyMonthly: number;
  /** The plan's visible features, in the order Clerk's card lists them. */
  lines: string[];
};

const offer = (p: Plan): Offer => ({
  name: p.name,
  monthly: p.amount / 100,
  yearlyMonthly: p.annual_monthly_amount / 100,
  lines: p.features.filter((k) => features[k].publicly_visible).map((k) => features[k].name),
});

export const offers = { free: offer(plans.free_org), builder: offer(plans.builder) };

/** The free card's lines that hold on every plan, for what the product does as a whole (the homepage's
    `featureList`). Its counts and its interval are Free's alone, since Builder raises them, so they
    are left out by key rather than by wording (review s52-1, 2026-11-08). */
const FREE_ONLY = ["show_free_apps", "show_free_interval"];
export const productLines: string[] = plans.free_org.features
  .filter((k) => features[k].publicly_visible && !FREE_ONLY.includes(k))
  .map((k) => features[k].name);

/** "$9", "$7.50". */
export const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
