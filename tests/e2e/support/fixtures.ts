import { test as base, expect, type Page } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";

/* The authenticated suite's `test`. Every page carries Clerk's testing token (bot protection
   refuses a headless browser without it), and any Server Action answered with
   `x-clerk-auth-status: signed-out` is recorded and thrown after the test, so a development
   instance's silent refusal names itself instead of surfacing as a missing row
   (`docs/integrations.md § Clerk › Gotchas`). */

export const test = base.extend<{ signedOut: string[] }>({
  signedOut: [
    async ({ page }, use) => {
      const seen: string[] = [];
      page.on("response", (r) => {
        // Ours only: a Server Action (it carries `next-action`) posted to the dashboard. Clerk's
        // `<SignIn />` posts one of its own to /sign-in while still signed out, on purpose.
        const req = r.request();
        if (req.headers()["next-action"] && new URL(req.url()).pathname.startsWith("/app") && r.headers()["x-clerk-auth-status"] === "signed-out") seen.push(r.url());
      });
      await use(seen);
      if (seen.length) throw new Error(`Server Actions answered signed-out: ${seen.join(", ")}`);
    },
    { auto: true },
  ],
  page: async ({ page }, use) => {
    await setupClerkTestingToken({ page });
    // The stored session token is long expired when a test opens a page, and Clerk's script
    // replaces it once it loads. A Server Action sent before then answers signed-out: a click
    // 0.8 s after `goto`, before Clerk had asked for its client (2026-10-24, the status page
    // step). Every navigation waits for Clerk, as a person's first click does.
    const goto = page.goto.bind(page);
    page.goto = async (...args: Parameters<Page["goto"]>) => {
      const response = await goto(...args);
      await page.waitForFunction(() => (window as { Clerk?: { loaded?: boolean } }).Clerk?.loaded === true, null, { timeout: 10_000 }).catch(() => {});
      return response;
    };
    await use(page);
  },
});

export { expect };

/** No horizontal scroll at this width: geometry, not a picture (`docs/TESTS.md`). */
export async function expectNoOverflow(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
}

/** Sign in through Clerk's own `<SignIn />` with the fixed test code. Waits for
 *  `prepare_first_factor`, never for the code box: the box renders while the code is still being
 *  sent (`docs/TESTS.md`). Lands on `/app`. */
export async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.locator("input[name=identifier]").fill(email);
  const prepared = page.waitForResponse((r) => /prepare_first_factor/.test(r.url()) && r.ok());
  await page.locator(".cl-formButtonPrimary").click();
  await prepared;
  await page.locator("input[autocomplete=one-time-code]").first().click();
  await page.keyboard.type(process.env.TEST_VERIFICATION_CODE ?? "");
  await page.waitForURL(/\/app(\/|$|\?)/, { timeout: 30_000 });
}
