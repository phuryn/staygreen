import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, expectNoOverflow, test } from "./support/fixtures";
import { readAccounts } from "./support/accounts";

const profileOf = (page: Page) => page.locator(".cl-organizationProfile-root:visible");
const navOf = (page: Page) => profileOf(page).locator(".cl-navbarButton:visible");

async function openSwitcherProfile(page: Page, phone = false) {
  const rail = phone ? page.locator("dialog.drawer") : page.locator("aside.rail");
  if (phone) await page.getByRole("button", { name: "Open menu" }).click();
  await rail.locator(".cl-organizationSwitcherTrigger").click();
  await page.locator(".cl-organizationSwitcherPopoverCard:visible").getByRole("button", { name: /Manage/ }).click();
}

async function chooseInvoices(page: Page, phone = false) {
  const profile = profileOf(page);
  if (phone) await profile.locator(".cl-navbarMobileMenuButton:visible").click();
  await navOf(page).filter({ hasText: /^Invoices$/ }).click();
  await expect(profile.getByRole("heading", { name: "Invoices", exact: true })).toBeVisible();
  await expect(profile.getByText(/This page shows sample data/)).toBeVisible();
  return profile;
}

test("workspace switcher, Plan and billing, and Settings open the same profile tabs", async ({ page }) => {
  await page.goto("/app");
  await openSwitcherProfile(page);
  const tabs = navOf(page);
  await expect(tabs.filter({ hasText: /^Invoices$/ })).toBeVisible();
  const baseline = (await tabs.allTextContents()).map(label => label.trim());
  expect(baseline.indexOf("Billing")).toBeGreaterThanOrEqual(0);
  expect(baseline.indexOf("Invoices")).toBe(baseline.indexOf("Billing") + 1);
  await chooseInvoices(page);

  await page.goto("/app/billing");
  await page.getByRole("button", { name: "Open workspace settings for invoices" }).click();
  await expect(navOf(page)).toHaveText(baseline);
  await chooseInvoices(page);

  await page.goto("/app/settings");
  await page.getByRole("button", { name: "Manage name and members" }).click();
  await expect(navOf(page)).toHaveText(baseline);
  await chooseInvoices(page);
});

test("an admin saves billing details, searches, downloads a PDF and sends invoice requests", async ({ page }) => {
  await page.goto("/app");
  await openSwitcherProfile(page);
  const profile = await chooseInvoices(page);
  const table = profile.getByRole("table", { name: "Invoice documents" });
  await expect(table.getByText(/^Refund · Corrects /)).toBeVisible();

  const link = table.getByRole("link", { name: /^Download STG\// }).first();
  const downloading = page.waitForEvent("download");
  await link.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect((await readFile(await download.path())).subarray(0, 5).toString()).toBe("%PDF-");

  await profile.getByText("Search invoices", { exact: true }).click();
  await profile.getByRole("textbox", { name: "Document number" }).fill("NO-SUCH-DOCUMENT");
  await profile.getByRole("button", { name: "Search", exact: true }).click();
  const empty = profile.getByRole("heading", { name: "No documents match" });
  await expect(empty).toBeVisible();
  await profile.getByRole("button", { name: "Clear search" }).last().click();
  await expect(table).toBeVisible();

  await profile.getByRole("button", { name: "Edit billing details" }).click();
  await profile.getByRole("textbox", { name: "Company name" }).fill("Example Studio browser test");
  await profile.getByRole("button", { name: "Save details" }).click();
  await expect(profile.getByRole("status").filter({ hasText: "Billing details saved." })).toBeVisible();
  await expect(profile.getByText("VAT ID confirmed in VIES.")).toBeVisible();

  // A `has` locator is matched inside each row, so it must not start from the profile or the table.
  const original = table.getByRole("row").filter({ has: page.getByRole("button", { name: /^Correct STG\// }) }).first();
  const correct = original.getByRole("button", { name: /^Correct STG\// });
  await correct.click();
  const dialog = page.getByRole("dialog", { name: /^Correct STG\// });
  const corrections: { organization: string; request_id: string }[] = [];
  const invoices: { organization: string; request_id: string }[] = [];
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/app", async route => {
    const request = route.request();
    const input = request.headers()["next-action"] ? request.postDataJSON()?.[0] : null;
    if (!input?.request_id) return route.continue();
    if (input.documentId) {
      corrections.push(input);
      if (corrections.length === 1) { await hold; return route.abort(); }
    } else if (input.payment_ref === undefined || input.payment_ref === "$undefined") {
      // React's action encoding sends an undefined argument field as the string "$undefined".
      invoices.push(input);
      if (invoices.length === 1) return route.abort();
    }
    return route.continue();
  });
  try {
    await dialog.getByRole("button", { name: "Ask for correction" }).click();
    await expect.poll(() => corrections.length).toBe(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  } finally {
    release();
  }
  await dialog.getByRole("button", { name: "Retry correction" }).click();
  const success = page.getByRole("dialog", { name: "Correction requested" });
  await expect(success.getByRole("status")).toContainText("Correction requested for");
  await success.getByRole("button", { name: "Done" }).click();
  await expect(table.getByText("Correction being issued", { exact: true })).toBeVisible();
  const pending = table.getByRole("row").filter({ hasText: "Buyer details corrected" })
    .filter({ has: page.getByText("Being issued", { exact: true }) });
  await expect(pending).toBeVisible();
  await expect(pending.getByRole("link")).toHaveCount(0);
  await profile.getByRole("button", { name: "Issue now" }).click();
  await expect(profile.getByText("Request sent to the issuer.", { exact: true })).toBeVisible();
  await profile.getByRole("button", { name: "Missing an invoice?" }).click();
  await profile.getByRole("button", { name: "Retry request" }).click();
  await expect(table.getByText("Invoice requested", { exact: true })).toBeVisible();
  const active = readAccounts().a.orgId;
  for (const attempts of [corrections, invoices]) {
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ organization: active, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(attempts[1]).toEqual(attempts[0]);
  }
});

test("a failed refresh keeps the billing editor and a later retry keeps its draft", async ({ page }) => {
  await page.goto("/app");
  await openSwitcherProfile(page);
  const profile = await chooseInvoices(page);
  await profile.getByRole("button", { name: "Edit billing details" }).click();
  const name = profile.getByRole("textbox", { name: "Company name" });
  await name.fill("Still editing");
  let rejected = 0;
  await page.route("**/app", route => {
    if (route.request().headers()["next-action"]) {
      rejected++;
      return route.abort();
    }
    return route.continue();
  });
  await profile.getByRole("button", { name: "Refresh invoices" }).click();
  await expect(profile.getByRole("alert").filter({ hasText: "Couldn’t load invoices." })).toBeVisible();
  expect(rejected).toBe(1);
  await expect(name).toHaveValue("Still editing");
  await page.unroute("**/app");
  await profile.getByRole("button", { name: "Try again" }).click();
  await expect(profile.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(name).toHaveValue("Still editing");
});

for (const phone of [false, true]) {
  test(`the correction dialog traps focus and dismisses on Escape in the ${phone ? "phone drawer" : "desktop profile"}`, async ({ page }) => {
    if (phone) await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/app");
    await openSwitcherProfile(page, phone);
    const profile = await chooseInvoices(page, phone);
    if (phone) {
      await expectNoOverflow(page);
      await expect(profile.getByRole("table")).toBeVisible();
    }
    const correct = profile.getByRole("button", { name: /^Correct STG\// }).first();
    await correct.click();
    const dialog = page.getByRole("dialog", { name: /^Correct STG\// });
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    const submit = dialog.getByRole("button", { name: "Ask for correction" });
    await expect(cancel).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(submit).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(cancel).toBeFocused();
    // Hit testing at Clerk's own close control reaches the top-layer dialog.
    const clerkClose = page.locator(".cl-modalCloseButton:visible");
    await expect(clerkClose).toBeVisible();
    expect(await clerkClose.evaluate(button => {
      const box = button.getBoundingClientRect();
      return !!document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.closest("dialog.dialog");
    })).toBe(true);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(profile).toBeVisible();
    if (phone) await expect(page.locator("dialog.drawer[open]")).toBeVisible();
    await expect(correct).toBeFocused();
  });
}
