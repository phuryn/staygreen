import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Comparison } from "@/components/landing/Comparison";

// The comparison's receipts: what no incumbent watches (`competitors-stripe-supabase-202610.md`) and
// what the vendors' pricing pages leave unsaid (`competitors-202610.md` § 2, § 3 and § 7).
describe("the comparison", () => {
  const html = renderToStaticMarkup(createElement(Comparison));
  const row = (label: string) => [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(([r]) => r).find((r) => r.includes(`>${label}<`));

  it.each(["Stripe webhook failures", "A paused Supabase project"])("says %s is on Free and not offered by any of the four", (label) => {
    const r = row(label)!;
    expect(r).toBeDefined();
    expect(r).toContain(">Free<");
    expect(r.match(/>Not offered</g)).toHaveLength(4);
  });

  // Its free plan names Slack and e-mail alerts and its seat names phone and SMS: neither names webhooks.
  it("prices no plan for Better Stack's webhook alerts, which its pricing page doesn't place", () => {
    const cells = [...row("Webhook alerts")!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell);
    expect(cells).toHaveLength(5);
    expect(cells[2]).toContain("say which plan");
    expect(cells[2]).not.toContain("$");
  });

  // The footer puts these three OpenStatus prices on its cheapest paid plan, Starter.
  it.each([
    ["Webhook alerts", "Starter"],
    ["A status page on your own domain", "Starter"],
    ["A status page without the vendor&#x27;s name on it", "Starter plus white-label"],
  ])("prices OpenStatus's %s on %s", (label, plan) => {
    const cells = [...row(label)!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => cell);
    expect(cells[3]).toContain(`>${plan}<`);
    expect(cells[3]).toContain("$");
  });

  it("says what Not offered means and when it was read, beside the prices' own date", () => {
    expect(html).toContain('dateTime="2026-10-24"');
    expect(html).toContain('dateTime="2026-10-18"');
    expect(html).toContain("isn’t among the monitor types the vendor lists");
    expect(html).toContain("OpenStatus’s pricing table covers only its paid plans, so for webhooks, an own domain and a page without its name, its prices are on its cheapest paid plan.");
  });
});
