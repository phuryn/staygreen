import { expect, test } from "@playwright/test";

/* The anonymous front door: health, the signed-out redirect, and that the public pages exist and
   fit a phone. What the landing page claims is pinned in `landing.spec.ts`. */

test("/health answers 200 with the database reachable, and says nothing about what's stored", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  const body = await res.json();
  expect(body).toMatchObject({ ok: true, database: "reachable" });
  expect(Object.keys(body).sort()).toEqual(["database", "ms", "ok"]);
});

test("every page carries a nonce CSP that refuses framing, fresh per request, and the static headers", async ({ request }) => {
  const [one, two] = [await request.get("/"), await request.get("/")];
  const csp = (r: typeof one) => r.headers()["content-security-policy"] ?? "";
  expect(csp(one)).toContain("frame-ancestors 'none'");
  expect(csp(one)).toContain("object-src 'none'");
  const scriptSrc = (r: typeof one) => /(?:^|;\s*)script-src ([^;]*)/.exec(csp(r))?.[1] ?? "";
  expect(scriptSrc(one)).toContain("'strict-dynamic'");
  const nonce = (r: typeof one) => /'nonce-([^']+)'/.exec(scriptSrc(r))?.[1];
  expect(nonce(one)).toBeTruthy();
  expect(nonce(two)).not.toBe(nonce(one));
  expect(one.headers()["x-frame-options"]).toBe("DENY");
  expect(one.headers()["x-content-type-options"]).toBe("nosniff");
});

test("Clerk's sign-in and sign-up load with nothing refused by the CSP", async ({ page }) => {
  const refused: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|violates/i.test(m.text())) refused.push(m.text().slice(0, 160));
  });
  for (const path of ["/sign-in", "/sign-up"]) {
    await page.goto(path);
    await expect(page.locator(".cl-rootBox").first()).toBeVisible();
    // The pattern is drawn after the form; give it the moment it takes.
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  expect(refused).toEqual([]);
});

test("a signed-out visit to the dashboard goes to sign-in, and the way back is kept", async ({ page }) => {
  await page.goto("/app/monitors");
  await page.waitForURL(/\/sign-in/);
  expect(decodeURIComponent(page.url())).toContain("/app/monitors");
  await expect(page.locator("input[name=identifier]")).toBeVisible();
});

for (const path of ["/", "/pricing", "/scan", "/sign-in", "/sign-up", "/legal/terms", "/legal/privacy", "/support", "/bot"]) {
  test(`${path} renders and fits at 320, 360 and 390`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), { message: `${path} at ${width}px` }).toBe(0);
    }
  });
}
