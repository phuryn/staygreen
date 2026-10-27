import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { accentShades, contrast, PAGE_NEUTRALS } from "../../src/lib/accents";
import { SEED_FILE, type Seed } from "./support/public-setup";

/* The public status page and incident page as a stranger sees them (`AGENTS.md § 2.9`): rendered
   from the snapshot functions through the allowlist DTO, reading no session. The fixture
   (`support/public-setup.ts`) puts a draft note and a monitor on no component beside what the
   page shows; neither may reach the page, in the DOM or in the first response. */

const seed = (): Seed => JSON.parse(readFileSync(SEED_FILE, "utf8"));

async function noOverflowAt(page: Page, widths: number[]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: `at ${width}px` }).toBe(0);
  }
}

test("the status page shows its component, its past incident and the published note", async ({ page }) => {
  const s = seed();
  const res = await page.goto(`/s/${s.slug}`);
  expect(res?.status()).toBe(200);
  await expect(page).toHaveTitle("Harbor status");
  await expect(page.getByRole("heading", { level: 1, name: "All systems operational" })).toBeVisible();
  await expect(page.locator(".sp-comp-name")).toHaveText(["Website"]);
  await expect(page.getByRole("heading", { level: 3, name: "Website is down" })).toBeVisible();
  await expect(page.getByText(s.published)).toBeVisible();
  await expect(page.getByRole("link", { name: /harbor\.example\.com/ })).toHaveAttribute("href", "https://harbor.example.com");
  await noOverflowAt(page, [320, 360, 390]);
});

/** What the browser computed, as hex: colours resolved through the cascade, never read from source. */
async function painted(page: Page) {
  const rgb = await page.evaluate(() => {
    const css = (el: Element | null) => (el ? getComputedStyle(el) : null);
    const home = document.querySelector(".sp-home");
    return {
      ground: css(document.querySelector(".sp"))!.backgroundColor,
      link: css(home)!.color,
      mark: css(document.querySelector(".sp-mark path"))!.fill,
      ring: document.activeElement === home ? css(home)!.outlineColor : null,
      ringStyle: document.activeElement === home ? css(home)!.outlineStyle : null,
    };
  });
  const hex = (c: string | null) => {
    const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(c ?? "");
    return m ? `#${m.slice(1).map((v) => Number(v).toString(16).padStart(2, "0")).join("")}` : c;
  };
  return { ground: hex(rgb.ground)!, link: hex(rgb.link)!, mark: hex(rgb.mark)!, ring: hex(rgb.ring), ringStyle: rgb.ringStyle };
}

test("the page's links, focus ring and mark wear its accent, shaded to read on the theme it shows", async ({ page }) => {
  const s = seed();
  const cases = s.accents.flatMap((a) => (a.theme === "visitor" ? (["light", "dark"] as const) : [a.theme]).map((shown) => ({ ...a, shown })));
  expect(cases.map((c) => `${c.theme}:${c.shown}`)).toEqual(["light:light", "dark:dark", "visitor:light", "visitor:dark"]);
  for (const c of cases) {
    const at = `${c.slug} shown ${c.shown}`;
    await page.emulateMedia({ colorScheme: c.shown });
    await page.goto(`/s/${c.slug}`);
    const shades = accentShades(c.accent, c.shown);
    // Every fixture's colour fails the theme it is shown in as picked, so a pass means the page
    // shaded it, except navy on the follow-the-visitor page shown light, where it reads as it
    // is: that page's two cases prove it switches shade with the preference.
    expect(shades.text === c.accent, at).toBe(c.theme === "visitor" && c.shown === "light");
    // The brand link first, then the homepage link: by keyboard, so the ring is the one a visitor sees.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.locator(".sp-home"), at).toBeFocused();
    const p = await painted(page);
    expect(p.ground, at).toBe(PAGE_NEUTRALS[c.shown].grounds[0]);
    expect(p.link, at).toBe(shades.text);
    expect(contrast(p.link, p.ground), at).toBeGreaterThanOrEqual(4.5);
    expect([p.ring, p.ringStyle], at).toEqual([shades.accent, "solid"]);
    expect(contrast(p.ring!, p.ground), at).toBeGreaterThanOrEqual(3);
    expect(p.mark, at).toBe(shades.accent);
  }
  await page.emulateMedia({ colorScheme: "light" });
});

test("a draft note and a monitor on no component never reach the page, in the DOM or the raw response", async ({ page, request }) => {
  const s = seed();
  await page.goto(`/s/${s.slug}`);
  const dom = await page.content();
  const raw = await (await request.get(`/s/${s.slug}`)).text();
  // Positive control first: the page that should be there is there.
  expect(raw).toContain("Harbor status");
  for (const body of [dom, raw]) {
    expect(body).not.toContain(s.draft);
    for (const name of s.privateNames) expect(body).not.toContain(name);
  }
});

test("markup in a published note is shown as text on both public pages, and never runs", async ({ page }) => {
  const s = seed();
  for (const path of [`/s/${s.slug}`, `/i/${s.pastIncident}`]) {
    await page.goto(path);
    await expect(page.getByText(s.hostile), path).toBeVisible();
    await expect(page.locator('img[src="x"]'), path).toHaveCount(0);
    expect(await page.evaluate(() => (window as { __sgXss?: number }).__sgXss), path).toBeUndefined();
  }
});

test("an incident's short link shows it inside its page's frame", async ({ page }) => {
  const s = seed();
  const res = await page.goto(`/i/${s.pastIncident}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1, name: "Website is down" })).toBeVisible();
  await expect(page.getByText(/^Resolved\. Started/)).toBeVisible();
  await expect(page.getByText(s.published)).toBeVisible();
  expect(await page.content()).not.toContain(s.draft);
  await expect(page.getByRole("link", { name: "See the whole status page" })).toHaveAttribute("href", `/s/${s.slug}`);
  // Alert links are private by nature: never indexed.
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await noOverflowAt(page, [320, 390]);
});

test("an incident on a monitor no page shows is not found, the same as one that doesn't exist", async ({ page }) => {
  const s = seed();
  for (const id of [s.privateIncident, "inc_000000000000000000000000", "not-an-id"]) {
    const res = await page.goto(`/i/${id}`);
    expect(res?.status(), id).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "There is no incident at this address" })).toBeVisible();
    expect(await page.content()).not.toContain("Internal billing worker");
  }
});

test("a status page address with nothing behind it is not found", async ({ page }) => {
  for (const slug of ["no-such-page-here", "Not_A_Slug"]) {
    const res = await page.goto(`/s/${slug}`);
    expect(res?.status(), slug).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "There is no status page at this address" })).toBeVisible();
  }
});

test("the page's README badge is an SVG a browser parses and draws, in the page's own state, and only where the page is", async ({ page, request }) => {
  const s = seed();
  await page.goto(`/s/${s.slug}`);
  const heading = (await page.getByRole("heading", { level: 1 }).innerText()).trim();
  const res = await request.get(`/s/${s.slug}/badge.svg`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/svg+xml");
  expect(res.headers()["cache-control"]).toBe("no-store");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["set-cookie"]).toBeUndefined();
  const body = await res.text();
  // Parsed the way a browser parses a standalone SVG: strict XML (`docs/TESTS.md`).
  const parsed = await page.evaluate((xml) => {
    const doc = new DOMParser().parseFromString(xml, "image/svg+xml");
    return { error: doc.getElementsByTagName("parsererror").length, root: doc.documentElement.localName, title: doc.querySelector("title")?.textContent ?? "" };
  }, body);
  expect(parsed).toEqual({ error: 0, root: "svg", title: expect.stringMatching(/^Harbor status: /) });
  // The page's headline and the badge say the same thing: an all-clear on both, or on neither.
  expect(heading === "All systems operational").toBe(parsed.title === "Harbor status: operational");
  // On Free the badge carries the Staygreen name, as the page carries its footer.
  expect(body).toContain(">Staygreen</text>");
  // And it draws as an image, the way a README embeds it.
  await page.setContent(`<img id="b" src="${new URL(`/s/${s.slug}/badge.svg`, page.url())}">`);
  await expect.poll(() => page.locator("#b").evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);

  for (const slug of ["no-such-page-here", "Not_A_Slug"]) {
    const missing = await request.get(`/s/${slug}/badge.svg`);
    expect(missing.status(), slug).toBe(404);
    expect(missing.headers()["cache-control"], slug).toBe("no-store");
  }
});
