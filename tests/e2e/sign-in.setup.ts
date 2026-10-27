import { readAccounts, STATE } from "./support/accounts";
import { expect, signIn, test } from "./support/fixtures";

/* The first journey and the session every other one runs on: each test account signs in
   through Clerk's `<SignIn />` (`AGENTS.md § 1.5`: Clerk's components are the sign-in surface,
   and this is the suite that has to notice when one stops working), lands on its own
   dashboard, and the session is saved. */

for (const key of ["a", "b"] as const) {
  test(`account ${key} signs in through <SignIn /> and lands on its dashboard`, async ({ page }) => {
    const account = readAccounts()[key];
    await signIn(page, account.email);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page).toHaveURL(/\/app$/);
    await page.context().storageState({ path: STATE[key] });
  });
}
