import "server-only";
import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { entitlementsFrom, FREE, type Entitlements } from "./plans";
import { SELF_HOSTED_ENTITLEMENTS, selfHostedPlanEnabled } from "./self-hosted-plan";

const subscription = z.object({ status: z.string(), subscriptionItems: z.array(z.object({
  // Backend SDK BillingSubscriptionItem.periodEnd is a Unix timestamp in milliseconds.
  periodEnd: z.number().finite().nullable().optional(),
  status: z.string(), plan: z.object({ id: z.string().optional(), forPayerType: z.enum(["org", "user"]), features: z.array(z.object({ slug: z.string() })) }).nullable(),
})) });

/** Each organization plan's complete feature slugs, by plan id. A subscription read embeds only
 *  the plan's publicly visible features, and the slugs the code checks are hidden ones
 *  (`docs/billing.md`), so they come from the plan list instead. */
export type PlanFeatures = ReadonlyMap<string, readonly string[]>;

export function subscriptionEntitlements(value: unknown, now = Date.now(), plans: PlanFeatures = new Map()): Entitlements {
  const parsed = subscription.safeParse(value);
  if (!parsed.success || parsed.data.status !== "active") return FREE;
  const slugs = new Set(parsed.data.subscriptionItems.filter(i =>
    i.plan?.forPayerType === "org" && (
      i.status === "active" ||
      (i.status === "canceled" && i.periodEnd != null && i.periodEnd > now)
    )
  ).flatMap(i => (i.plan!.id ? plans.get(i.plan!.id) : undefined) ?? i.plan!.features.map(f => f.slug)));
  return entitlementsFrom(slug => slugs.has(slug));
}

// Plans change only when the owner edits them in Clerk; five minutes keeps one read per agent call.
const PLAN_TTL_MS = 5 * 60_000;
let planCache: { at: number; plans: PlanFeatures } | null = null;

async function orgPlanFeatures(client: Awaited<ReturnType<typeof clerkClient>>): Promise<PlanFeatures> {
  if (planCache && Date.now() - planCache.at < PLAN_TTL_MS) return planCache.plans;
  const { data } = await client.billing.getPlanList({ payerType: "org" });
  const plans: PlanFeatures = new Map(data.map(p => [p.id, p.features.map(f => f.slug)]));
  planCache = { at: Date.now(), plans };
  return plans;
}

/** Machine credentials have no browser session/has(). Unless self-hosted, Clerk is the source, per
 * integrations.md § Billing. `workspaces.plan` only routes Builder monitors to Builder-only probes;
 * nothing reads it for entitlements, and no subscription is copied into our database. */
export async function apiEntitlements(orgId: string): Promise<Entitlements> {
  // The caller authenticates the credential and resolves its owning organization first.
  if (!orgId) return FREE;
  if (selfHostedPlanEnabled()) return SELF_HOSTED_ENTITLEMENTS;
  try {
    const client = await clerkClient();
    const [current, plans] = await Promise.all([client.billing.getOrganizationBillingSubscription(orgId), orgPlanFeatures(client)]);
    return subscriptionEntitlements(current, Date.now(), plans);
  } catch { return FREE; }
}
