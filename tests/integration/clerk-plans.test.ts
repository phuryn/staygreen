import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { builderSlugs } from "@/lib/plans";

/* The Clerk dashboard is the other half of the plan module (`docs/integrations.md § Billing`).
   A read-back proves the slugs the code gates on are the ones Builder carries, and that the
   development instance runs `scripts/clerk/billing.json`, the setup production copies
   (`docs/billing.md`). The gated slugs are hidden from the pricing table; the display-only
   features beside them (`show_*`) are labels nothing reads. This reads the development
   instance's plans through the Backend API and writes nothing. A production key is refused; a
   missing one skips, and says so. */

const setup = JSON.parse(readFileSync(new URL("../../scripts/clerk/billing.json", import.meta.url), "utf8")).billing as {
  features: Record<string, { name: string }>;
  plans: Record<string, { features: string[]; amount: number; annual_monthly_amount: number }>;
};
const display = (slug: string) => slug.startsWith("show_");

const key = process.env.CLERK_SECRET_KEY?.trim() ?? "";
if (key && !key.startsWith("sk_test_")) throw new Error("CLERK_SECRET_KEY is not a development key; this file reads the development instance only");
const suite = key ? describe : describe.skip;
if (!key) console.warn('[integration] SKIPPED "Clerk plans": CLERK_SECRET_KEY is not set. Nothing in this file reached Clerk.');

const plans = z.object({
  data: z.array(
    z.object({
      slug: z.string(),
      for_payer_type: z.string(),
      is_default: z.boolean(),
      fee: z.object({ amount: z.number() }),
      annual_monthly_fee: z.object({ amount: z.number() }),
      features: z.array(z.object({ slug: z.string(), name: z.string() })),
    }),
  ),
});

suite("Clerk plans", () => {
  it("has Free as the organizations' default, Builder carrying exactly the slugs the code gates on, and the repository's setup", async () => {
    const res = await fetch("https://api.clerk.com/v1/billing/plans", { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    const org = plans.parse(await res.json()).data.filter((p) => p.for_payer_type === "org");
    const slugsOf = (slug: string) => org.find((p) => p.slug === slug)?.features.map((f) => f.slug).sort();

    expect(org.map((p) => p.slug).sort()).toEqual(["builder", "free_org"]);
    expect(org.find((p) => p.is_default)?.slug).toBe("free_org");
    // Free is the absence of every gate, so it carries none of them; Builder carries exactly them.
    expect(slugsOf("free_org")?.filter((s) => !display(s))).toEqual([]);
    expect(slugsOf("builder")?.filter((s) => !display(s))).toEqual([...builderSlugs].sort());
    // The instance runs the setup in the repository, labels included.
    for (const plan of ["free_org", "builder"]) {
      expect(slugsOf(plan), plan).toEqual([...setup.plans[plan].features].sort());
      // The table prints names, so a reworded label is drift too.
      for (const f of org.find((p) => p.slug === plan)!.features) expect(f.name, f.slug).toBe(setup.features[f.slug].name);
      // The landing's cards print the file's prices (`src/lib/plan-offer.ts`), so a price changed
      // in the dashboard alone is drift as well.
      const live = org.find((p) => p.slug === plan)!;
      expect([live.fee.amount, live.annual_monthly_fee.amount], plan).toEqual([setup.plans[plan].amount, setup.plans[plan].annual_monthly_amount]);
    }
  });
});
