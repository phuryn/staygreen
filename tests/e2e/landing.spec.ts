import { expect, test } from "@playwright/test";
import { built, isBuilt } from "../../src/lib/launch";
import { offers, usd } from "../../src/lib/plan-offer";
import { limits } from "../../src/lib/plans";
import { expectOrganizationPrices } from "./support/pricing";

/* What the front door claims (plan.md stage 4.1): its numbers come from the plan module, nothing
   on it pretends to run or to take payment before it does, and the promises a buyer relies on
   are on the page. The flags are read from `launch.ts`, so flipping one changes what these
   expect instead of breaking them. */

test("the landing shows one set of plans, its own cards with Clerk's lines and prices, and leaves Clerk's table to /pricing", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".cl-pricingTable")).toHaveCount(0);
  const [free, builder] = [page.locator(".lp-plan").nth(0), page.locator(".lp-plan").nth(1)];
  await expect(page.locator(".lp-plan")).toHaveCount(2);
  for (const line of offers.free.lines) await expect(free).toContainText(line);
  for (const line of offers.builder.lines) await expect(builder).toContainText(line);
  await expect(free).toContainText(`${limits.free.monitors} monitors`);
  await expect(builder).toContainText(`${limits.builder.monitors} monitors`);
  await expect(builder).toContainText(usd(offers.builder.yearlyMonthly));
  await expect(builder).toContainText(usd(offers.builder.monthly));
  await expect(free.getByRole("link", { name: "Start free" })).toHaveAttribute("href", "/sign-up");
  for (const width of [320, 360, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  }
});

for (const path of ["/pricing"]) {
  test(`${path} loads organization prices, defaults to yearly and fits a phone`, async ({ page }) => {
    await page.goto(path);
    await expectOrganizationPrices(page);
    await expect(page.getByRole("link", { name: "Open workspace billing" })).toHaveAttribute("href", "/app/billing");
    for (const width of [320, 360, 390, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    }
  });
}

test("while billing isn't built, no Builder button offers to take payment", async ({ page }) => {
  test.skip(isBuilt("billing"), "billing is built");
  for (const path of ["/", "/pricing"]) {
    await page.goto(path);
    await expect(page.getByText("Builder isn’t on sale yet.").first(), path).toBeVisible();
    await expect(page.getByRole("link", { name: /^(Start with|Upgrade to|Buy) Builder/ }), path).toHaveCount(0);
    expect(await page.locator("a[href*='checkout'], form[action*='checkout']").count(), path).toBe(0);
  }
});

test("while nothing checks monitors, every public page says so", async ({ page }) => {
  test.skip(built.probes && built.alerts, "probes and alerts are built");
  for (const path of ["/", "/pricing", "/scan"]) {
    await page.goto(path);
    await expect(page.getByText("Staygreen is still being built."), path).toBeVisible();
  }
});

test("pricing carries the refund-if-we-close promise, and the comparison is dated with its sources", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByText("What if Staygreen shuts down?")).toBeVisible();
  await expect(page.getByText("You get a refund for the unused part of your plan.")).toBeVisible();
  const cmp = page.locator("section.cmp");
  // The prices' date, and the date the "Not offered" rows were read.
  await expect(cmp.locator("time")).toHaveCount(2);
  for (const time of await cmp.locator("time").all()) await expect(time).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}$/);
  for (const name of ["UptimeRobot", "Better Stack", "OpenStatus", "Hyperping"]) {
    await expect(cmp.locator(".cmp-foot").getByRole("link", { name })).toHaveAttribute("href", /^https:\/\//);
  }
});

test("the scan page runs no scan until the scan is built", async ({ page }) => {
  test.skip(isBuilt("scan"), "the scan is built");
  await page.goto("/scan");
  await expect(page.getByRole("heading", { level: 1, name: "What could fail without you noticing?" })).toBeVisible();
  await expect(page.locator("main form, main input, main textarea")).toHaveCount(0);
  // The header offers no scan it can't run.
  await expect(page.getByRole("navigation", { name: "Site" }).getByRole("link", { name: "Scan your app" })).toHaveCount(0);
});

test("an address with nothing behind it is a real 404 in the site's frame", async ({ page }) => {
  const res = await page.goto("/no-such-page-here");
  expect(res?.status()).toBe(404);
  await expect(page).toHaveTitle(/Not found/);
  await expect(page.getByRole("navigation", { name: "Site" })).toBeVisible();
});
