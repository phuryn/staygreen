import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Comparison } from "@/components/landing/Comparison";

// The comparison's rows for what no incumbent watches (`competitors-stripe-supabase-202610.md`).
describe("the comparison", () => {
  const html = renderToStaticMarkup(createElement(Comparison));
  const row = (label: string) => [...html.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(([r]) => r).find((r) => r.includes(`>${label}<`));

  it.each(["Stripe webhook failures", "A paused Supabase project"])("says %s is on Free and not offered by any of the four", (label) => {
    const r = row(label)!;
    expect(r).toBeDefined();
    expect(r).toContain(">Free<");
    expect(r.match(/>Not offered</g)).toHaveLength(4);
  });

  it("says what Not offered means and when it was read, beside the prices' own date", () => {
    expect(html).toContain('dateTime="2026-10-24"');
    expect(html).toContain('dateTime="2026-10-18"');
    expect(html).toContain("isn’t among the monitor types the vendor lists");
  });
});
