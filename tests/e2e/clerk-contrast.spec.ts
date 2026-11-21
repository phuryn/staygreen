import { expect, test, type Locator, type Page } from "@playwright/test";
import { edgeContrast, settled } from "./support/contrast";
import { THEME_COOKIE } from "../../src/lib/theme-cookie";
import { BASE_URL } from "./web-server";

/* Clerk's sign-in and sign-up, measured on the rendered page in both themes (`src/lib/clerk-appearance.ts`).
   Clerk draws its edges as a faint tint of one colour, which left the email field without a
   visible box and the Google button without an outline (1.02 to 1.04:1, 2026-11-21). Each edge
   must now read at least as well as the kit's own part does:
   - the email field as the kit's input, `--edge`: 3:1, WCAG 2.2 SC 1.4.11;
   - the Google button as the kit's `.btn`, `--line-strong`: 1.44:1 light, 1.61:1 dark;
   - the "or" divider as the kit's `.divider`, `--line`: 1.25:1 light, 1.28:1 dark.
   The floors sit just under those numbers so rounding in the browser's colour maths can't fail
   a run, and far above the 1.0x Clerk's tint gave. A state (hover, focus) is read only once the
   element matches it and Clerk's transition has finished, so a reading is never the resting edge
   on its way out. */

const floors = {
  light: { input: 3, button: 1.4, divider: 1.2 },
  dark: { input: 3, button: 1.55, divider: 1.22 },
} as const;

type Theme = keyof typeof floors;

async function open(page: Page, theme: Theme, path: string) {
  await page.context().addCookies([{ name: THEME_COOKIE, value: theme, url: BASE_URL }]);
  await page.goto(path);
}

/** The edge once `state` holds and the element has stopped animating. */
async function edgeIn(locator: Locator, state: string) {
  await expect.poll(() => locator.evaluate((e, s) => e.matches(s), state), { message: `matches ${state}` }).toBe(true);
  await settled(locator);
  return (await edgeContrast(locator)).edge;
}

const shadow = (locator: Locator) => locator.evaluate((e) => getComputedStyle(e).boxShadow);

for (const theme of ["light", "dark"] as const) {
  test(`Clerk's sign-in shows its field, its button and its divider in ${theme}`, async ({ page }) => {
    await open(page, theme, "/sign-in");
    const field = page.locator(".cl-formFieldInput").first();
    await expect(field).toBeVisible();
    const google = page.locator(".cl-socialButtonsBlockButton").first();
    await expect(google).toBeVisible();
    // Nothing focused or hovered: the resting edges.
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // Read until the styles settle: Clerk's own tint never reaches a floor, so a pass is the appearance taking hold.
    const edge = (locator: Locator, what: string) => expect.poll(async () => (await edgeContrast(locator)).edge, { message: `${what} in ${theme}` });
    await edge(field, "the email field's edge").toBeGreaterThanOrEqual(floors[theme].input);
    await edge(google, "the Google button's edge").toBeGreaterThanOrEqual(floors[theme].button);
    const lines = await page.locator(".cl-dividerLine").all();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      await expect(line, "the divider is painted").toBeVisible();
      await edge(line, "the divider").toBeGreaterThanOrEqual(floors[theme].divider);
    }

    // Hover keeps the field's edge (Clerk's own hover ring is fainter than the resting edge set here) and darkens the
    // button's to the field's, as the kit's `.btn` does.
    await field.hover();
    expect(await edgeIn(field, ":hover"), `the email field's edge on hover in ${theme}`).toBeGreaterThanOrEqual(floors[theme].input);
    await google.hover();
    expect(await edgeIn(google, ":hover"), `the Google button's edge on hover in ${theme}`).toBeGreaterThanOrEqual(floors[theme].input);
  });

  test(`Clerk's sign-up shows where the keyboard is, on its consent box, in ${theme}`, async ({ page }) => {
    await open(page, theme, "/sign-up");
    const consent = page.locator(".cl-formFieldCheckboxInput").first();
    await expect(consent).toBeVisible();
    await page.mouse.move(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await settled(consent);
    const resting = await shadow(consent);
    expect((await edgeContrast(consent)).edge, `the consent box's edge in ${theme}`).toBeGreaterThanOrEqual(floors[theme].input);

    // From the password field, Tab until the consent box holds the focus (the show-password button sits between).
    await page.locator("input[name=password]").focus();
    for (let i = 0; i < 4 && !(await consent.evaluate((e) => e === document.activeElement)); i++) await page.keyboard.press("Tab");
    expect(await edgeIn(consent, ":focus-visible"), `the consent box's focus ring in ${theme}`).toBeGreaterThanOrEqual(floors[theme].input);
    expect(await shadow(consent), "focus changes the consent box's ring").not.toBe(resting);
  });
}
