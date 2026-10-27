import { expect, type Page } from "@playwright/test";
import { slugLabel } from "../../../src/lib/plans";

/** Tests the real vendor DOM rather than its changeable English labels or a price copy. */
export async function expectOrganizationPrices(page: Page) {
  await expect(page.locator(".cl-pricingTable")).toHaveCount(1);
  await expect(page.locator(".cl-pricingTableCard")).toHaveCount(2);
  const builder = page.locator(".cl-pricingTableCard__builder");
  await expect(builder.locator(".cl-pricingTableCardFee")).toHaveText(/\d/);
  const toggle = builder.locator(".cl-pricingTableCardPeriodToggle");
  const annual = toggle.locator('[role="switch"]');
  await expect(annual).toBeChecked();
  // The visible indicator covers the native switch, so a visitor's click lands on it.
  await toggle.locator(".cl-switchIndicator").click();
  await expect(annual).not.toBeChecked();
  await toggle.locator(".cl-switchIndicator").click();
  await expect(annual).toBeChecked();
  // The table prints each feature's name from the Clerk dashboard; a visitor must read words, not
  // the slugs the code checks (docs/billing.md, the plan's features).
  const features = (await builder.locator("li").allInnerTexts()).map(t => t.trim());
  expect(features.filter(t => t in slugLabel), "Builder's features in Clerk are named by their slug").toEqual([]);
}
