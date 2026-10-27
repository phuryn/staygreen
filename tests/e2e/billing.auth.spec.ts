import { expect, expectNoOverflow, test } from "./support/fixtures";
import { expectOrganizationPrices } from "./support/pricing";
import { readAccounts } from "./support/accounts";

test("signed-in public pricing names the active workspace beside checkout", async ({ page }) => {
  const { a } = readAccounts();
  await page.goto("/pricing");
  await expect(page.getByText(`Plans and payment for workspace: ${a.orgName}.`, { exact: true })).toBeVisible();
  await expectOrganizationPrices(page);
  // The home page keeps its own two plan cards, signed in too; Clerk's table is /pricing's alone.
  await page.goto("/");
  await expect(page.locator(".lp-plan")).toHaveCount(2);
  await expect(page.locator(".cl-pricingTable")).toHaveCount(0);
});

// No payment: real checkout and cancellation with the test card are the owner's drill.
test("a Free admin meets the upgrade first, with Builder's button on a phone's first screen", async ({ page }) => {
  await page.goto("/app/billing");
  await expect(page.locator("main h2").first()).toHaveText("Upgrade to Builder");
  await expectOrganizationPrices(page);
  // Side by side, Clerk lines the cards' rows up; Builder's button stays under its price, not
  // under an empty band as tall as the list of Free's features, which has no button of its own.
  const head = (await page.locator(".cl-pricingTableCard__builder .cl-pricingTableCardHeader").boundingBox())!;
  const footer = (await page.locator(".cl-pricingTableCard__builder .cl-pricingTableCardFooter").boundingBox())!;
  expect(footer.y - (head.y + head.height)).toBeLessThan(24);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoOverflow(page);
  // Stacked, Builder's card comes before Free's, which the workspace already has.
  const top = async (card: string) => (await page.locator(`.cl-pricingTableCard__${card}`).boundingBox())!.y;
  expect(await top("builder")).toBeLessThan(await top("free_org"));
  await page.evaluate(() => window.scrollTo(0, 0));
  const subscribe = (await page.locator(".cl-pricingTableCard__builder button").filter({ hasNotText: /features/i }).first().boundingBox())!;
  expect(subscribe.y + subscribe.height).toBeLessThan(844);
});

// The phone menu is a modal dialog; Clerk's menus have to open inside it to be seen and used.
test("on a phone, the menu's workspace switcher opens and reaches workspace settings", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/billing");
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.locator("dialog.drawer .cl-organizationSwitcherTrigger").click();
  const card = page.locator("dialog.drawer .cl-organizationSwitcherPopoverCard");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: /Manage/ }).click();
  await expect(page.locator(".cl-organizationProfile-root")).toBeVisible();
  await expectNoOverflow(page);
});
