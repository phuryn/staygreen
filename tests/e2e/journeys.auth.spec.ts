import type { Page } from "@playwright/test";
import { setupClerkTestingToken } from "@clerk/testing/playwright";
import { TEST_BUDGET } from "../../src/lib/budgets";
import { isBuilt } from "../../src/lib/launch";
import { PAGE_ASSET_LIMIT } from "../../src/lib/page-assets";
import { png, pngChunk, SECRET } from "../support/page-assets";
import { readAccounts } from "./support/accounts";
import { BASE_URL } from "./web-server";
import { expect, expectNoOverflow, test } from "./support/fixtures";
import { insert, select } from "./support/rest";
import { addNote, openIncident, workspaceOf } from "./support/seed";
import { pickApp } from "./support/app-picker";

/* A builder's first hour, as account A, on the real Clerk session and the development database:
   name an app, add monitors, pause and resume, edit one, make the status page, handle an incident, then
   delete the monitor, the page and the app.
   Each step builds on the last, so they run in order; the setup emptied the workspace first. */

const SLUG = "e2e-lighthouse-a";
// The add form resolves the name before it saves; example.com is reserved and always resolves.
const HOST = "example.com";

/** A photo as a phone writes one: `size` bytes, most of them metadata, its location in EXIF straight
 *  after the start of the image. The pixels come from the browser's own JPEG encoder. */
async function photo(page: Page, size: number): Promise<Buffer> {
  const encoded = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 2000;
    c.height = 3000;
    const ctx = c.getContext("2d")!;
    const g = ctx.createLinearGradient(0, 0, 2000, 3000);
    g.addColorStop(0, "teal");
    g.addColorStop(1, "orange");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 2000, 3000);
    const blob = await new Promise<Blob>((done) => c.toBlob((b) => done(b!), "image/jpeg", 0.9));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let out = "";
    for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(out);
  });
  const jpeg = Buffer.from(encoded, "base64");
  const segment = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 255]), data]);
  const parts = [segment(0xe1, Buffer.from(`Exif\0\0MM\0*${SECRET}`, "latin1"))];
  let total = jpeg.length + parts[0].length;
  while (total + 4 <= size) {
    const comment = segment(0xfe, Buffer.alloc(Math.min(65533, size - total - 4), 0x20));
    parts.push(comment);
    total += comment.length;
  }
  return Buffer.concat([jpeg.subarray(0, 2), ...parts, jpeg.subarray(2)]);
}

/** Wait for the server's answer to a Server Action, not for the optimistic pixels. */
const action = (page: Page) => page.waitForResponse((r) => r.request().method() === "POST" && !!r.request().headers()["next-action"]);

type Mon = { id: string; type: string; auto: boolean; target_host: string | null; paused_at: string | null };

test.describe.serial("a builder's first hour", () => {
  let workspaceId = "";
  let apiMonitorId = "";
  let secondAppId = "";
  let editorPath = "";

  test("names an app with its address, is offered its checks, and can add a monitor of its own instead", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1, name: "Start with your app" })).toBeVisible();
    workspaceId = await workspaceOf(readAccounts().a.orgId);
    // Suggested checks and a monitor's test are real requests from the dashboard's server to the
    // address, out of one budget. The suites never check an outside host, so this workspace's
    // tests are spent before its first app: the suggestions are refused and say so, each test is
    // refused, and each save goes through "anyway".
    await insert("budgets", { workspace_id: workspaceId, action: "test_check", actor: "workspace", window_started_at: new Date().toISOString(), used: TEST_BUDGET.workspace.limit });
    await page.getByLabel("App name").fill("Lighthouse");
    await page.getByLabel(/Address/).fill(`https://${HOST}`);
    // Hold the suggested checks back: until they arrive, the form says what is happening rather
    // than looking finished. The save's refresh already has the app, but the router keeps this
    // screen until the navigation started with it lands, so the first-app form stays (review 107).
    await page.route(/\/app\/apps\/app_[0-9a-f]{24}\/checks/, async (route) => { await new Promise((r) => setTimeout(r, 3000)); await route.continue(); });
    await page.getByRole("button", { name: "Add app" }).click();
    await expect(page.getByRole("button", { name: "Finding checks…" })).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: `Added. Trying ${HOST} to suggest its first checks…` })).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByRole("heading", { level: 1, name: "Start with your app" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Finding checks…" })).toBeDisabled();
    await page.waitForURL(/\/app\/apps\/app_[0-9a-f]{24}\/checks$/);
    await page.unroute(/\/app\/apps\/app_[0-9a-f]{24}\/checks/);
    await expect(page.getByRole("heading", { level: 1, name: "Suggested checks for Lighthouse" })).toBeVisible();
    await expect(page.locator(".callout-warn", { hasText: "This workspace has run 100 tests in an hour" })).toBeVisible();
    await expect(page.getByText(`You can still add a monitor for ${HOST} yourself.`)).toBeVisible();
    // Nothing was added for it: the builder decides.
    expect(await select("monitors", `workspace_id=eq.${workspaceId}&select=id`)).toEqual([]);
    await page.getByRole("link", { name: "Add a monitor", exact: true }).click();
    await page.waitForURL(/\/app\/monitors\/new\?app=app_[0-9a-f]{24}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Add a monitor" })).toBeVisible();

    // One app has no app control in the rail, only its name and state under the logo. Free has
    // one app, so the overview's Add another app carries the Builder mark and says what Builder
    // adds, rather than opening the form.
    const rail = page.getByRole("complementary", { name: "Workspace" });
    await expect(rail.getByRole("button", { name: /^App:/ })).toHaveCount(0);
    await expect(rail.locator(".rail-app-name")).toHaveText("Lighthouse");
    await expect(rail.locator(".rail-app .rail-sum")).toHaveText(["No monitors yet"]);
    await expect(rail.locator(".rail-app .rail-sum svg.state-icon.unchecked")).toBeVisible();
    await expect(rail.locator("[aria-current]")).toHaveCount(1);
    await expect(rail.locator('[aria-current="page"]')).toHaveText("Monitors");
    await rail.getByRole("link", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Add another app (Builder)" }).click();
    const offer = page.getByRole("dialog", { name: "More apps with Builder" });
    await expect(offer).toContainText("Free includes one app. Builder includes 10");
    await expect(offer.getByRole("link", { name: /Builder$/ })).toHaveAttribute("href", "/app/billing");
    await expect(page.getByRole("heading", { level: 2, name: "Add another app" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(offer).toBeHidden();
  });

  test("adds an HTTP monitor that says Not checked yet, and gets the host's SSL monitor with it", async ({ page }) => {
    await page.goto("/app/monitors/new");
    // With one app there is nothing to choose, so the form names it instead of asking.
    await expect(page.getByText("Part of Lighthouse.")).toBeVisible();
    await expect(page.getByLabel("Which app is it part of?")).toHaveCount(0);
    await page.getByLabel("Address", { exact: true }).fill(`https://${HOST}/api/health`);
    await page.getByLabel(/^Name/).fill("Lighthouse API");
    // Test comes first: the form's main button tests, and saving is offered after a pass, or,
    // here, after a test refused with when it can run again, as adding the monitor as it is.
    const submit = page.locator('form button[type="submit"]');
    await expect(submit).toHaveText("Test");
    await expect(page.getByRole("button", { name: "Add anyway" })).toHaveCount(0);
    const spent = page.locator(".callout-warn", { hasText: "This workspace has run 100 tests in an hour" });
    await page.getByLabel(/^Name/).press("Enter");
    await expect(spent).toContainText(/You can test again at \d/);
    await expect(page.getByText("It couldn't be tested, so nothing is saved yet.")).toBeVisible();
    await expect(submit).toHaveText("Test again");
    await page.getByRole("button", { name: "Add anyway" }).click();
    await page.waitForURL(/\/app\/monitors\/mon_[0-9a-f]{24}$/);
    apiMonitorId = page.url().split("/").pop()!;
    await expect(page.getByRole("heading", { level: 1, name: "Lighthouse API" })).toBeVisible();
    await expect(page.getByText("Not checked yet").first()).toBeVisible();
    await expect(page.locator("aside").getByRole("button", { name: /^App:/ })).toHaveCount(0);
    await expect(page.locator("aside [aria-current]")).toHaveCount(1);
    await expect(page.locator('aside [aria-current="page"]')).toHaveText("Monitors");

    const mons = await select<Mon>("monitors", `workspace_id=eq.${workspaceId}&select=id,type,auto,target_host,paused_at`);
    expect(mons.filter((m) => m.type === "ssl" && m.auto && m.target_host === HOST)).toHaveLength(1);

    await page.goto("/app/monitors");
    await expect(page.getByRole("link", { name: /Lighthouse API/ })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(HOST.replace(/\./g, "\\.")) }).first()).toBeVisible();
  });

  test("pauses the monitor until resumed, and it stays paused across a reload, then resumes", async ({ page }) => {
    await page.goto(`/app/monitors/${apiMonitorId}`);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const paused = action(page);
    await page.getByRole("button", { name: "Until I resume" }).click();
    await paused;
    await page.reload();
    await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
    let [row] = await select<Mon>("monitors", `id=eq.${apiMonitorId}&select=paused_at`);
    expect(row.paused_at).not.toBeNull();

    const resumed = action(page);
    await page.getByRole("button", { name: "Resume" }).click();
    await resumed;
    await page.reload();
    await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
    [row] = await select<Mon>("monitors", `id=eq.${apiMonitorId}&select=paused_at`);
    expect(row.paused_at).toBeNull();
  });

  test("edits the monitor: a new path and a secret header, kept on the next save without retyping it", async ({ page }) => {
    await page.goto(`/app/monitors/${apiMonitorId}`);
    await page.getByRole("link", { name: "Edit", exact: true }).click();
    await page.waitForURL(/\/edit$/);
    await expect(page.getByRole("heading", { level: 1, name: "Edit Lighthouse API" })).toBeVisible();
    const address = page.getByLabel("Address", { exact: true });
    await expect(address).toHaveValue(`https://${HOST}/api/health`);
    await address.fill(`https://${HOST}/status`);
    await page.getByRole("button", { name: "Add header" }).click();
    await page.getByLabel("Header 1 name").fill("Authorization");
    await page.getByLabel("Header 1 value").fill("Bearer e2e-secret");
    await page.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByRole("button", { name: "Save anyway" }).click();
    await page.waitForURL(new RegExp(`/app/monitors/${apiMonitorId}$`));
    await expect(page.getByText(`https://${HOST}/status`).first()).toBeVisible();

    type Secret = { name: string; sealed: string };
    const secrets = () => select<Secret>("monitor_secrets", `monitor_id=eq.${apiMonitorId}&select=name,sealed`);
    const [first] = await secrets();
    expect(first.name).toBe("Authorization");
    expect(first.sealed).not.toContain("e2e-secret");

    // The stored header comes back without its value, and saving leaves it sealed as it was.
    await page.getByRole("link", { name: "Edit", exact: true }).click();
    await page.waitForURL(/\/edit$/);
    await expect(page.getByLabel("Header 1 name")).toHaveValue("Authorization");
    await expect(page.getByLabel("Header 1 value")).toHaveValue("");
    await page.getByRole("button", { name: "Test", exact: true }).click();
    await page.getByRole("button", { name: "Save anyway" }).click();
    await page.waitForURL(new RegExp(`/app/monitors/${apiMonitorId}$`));
    expect(await secrets()).toEqual([first]);

    const [row] = await select<{ id: string; target: string }>("monitors", `id=eq.${apiMonitorId}&select=id,target`);
    expect(row.target).toBe(`https://${HOST}/status`);
    const mons = await select<Mon>("monitors", `workspace_id=eq.${workspaceId}&select=id,type,auto,target_host,paused_at`);
    expect(mons.filter((m) => m.type === "ssl" && m.auto && m.target_host === HOST)).toHaveLength(1);
  });

  test("adds a heartbeat, whose page shows its ping URL any time, and a new URL retires the old", async ({ page }) => {
    await page.goto("/app/monitors/new");
    // The types are radios, one of eight, named by their label.
    await page.getByRole("radio", { name: "Heartbeat" }).check();
    // A heartbeat asks for no address: the job calls Staygreen, and the form says so.
    await expect(page.getByRole("heading", { name: "How a heartbeat works" })).toBeVisible();
    await expect(page.getByLabel("Address", { exact: true })).toHaveCount(0);
    // Nor anything to test before saving: its first ping is the test.
    await expect(page.getByRole("heading", { name: "Try it before you save" })).toHaveCount(0);
    await page.getByLabel(/^Name/).fill("Nightly backup");
    // No schedule is filled in for the builder: only they know when their job runs.
    await expect(page.getByLabel("Schedule", { exact: true })).toHaveValue("");
    await page.getByLabel("Schedule", { exact: true }).fill("0 6 * * *");
    await page.getByRole("button", { name: "Add monitor" }).last().click();
    await expect(page.getByRole("heading", { level: 1, name: "Heartbeat added" })).toBeVisible();
    const url = (await page.locator(".hb-ping .hb-url").innerText()).trim();
    expect(url).toMatch(/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_-]{16,}$/);
    const token = url.split("/").pop()!;
    // Until something receives pings, the screen says the address doesn't answer yet.
    await expect(page.locator(".callout-warn", { hasText: "Nothing receives pings yet" })).toHaveCount(isBuilt("probes") ? 0 : 1);
    // One line per place a job runs; the shell one carries the URL, the Actions one a secret.
    await expect(page.getByRole("tabpanel")).toContainText(`"${url}" || true`);
    await page.getByRole("tab", { name: "GitHub Actions" }).click();
    await expect(page.getByRole("tabpanel")).toContainText("secrets.STAYGREEN_PING_URL");
    await expect(page.getByRole("tabpanel")).not.toContainText(token);

    await page.getByRole("link", { name: "Open the monitor" }).click();
    await page.waitForURL(/\/app\/monitors\/mon_/);
    await expect(page.getByRole("heading", { level: 1, name: "Nightly backup" })).toBeVisible();
    // The monitor's page shows the same URL, after a reload too.
    const shown = page.locator(".hb-ping .hb-url");
    await expect(shown).toHaveText(url);
    await page.reload();
    await expect(shown).toHaveText(url);

    // A new URL replaces it at once, and is what the page shows from then on.
    await page.getByRole("button", { name: "Make a new URL" }).click();
    await page.getByRole("group", { name: "Make a new ping URL" }).getByRole("button", { name: "Make a new URL" }).click();
    await expect(shown).not.toHaveText(url);
    const next = (await shown.innerText()).trim();
    expect(next).toMatch(/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_-]{16,}$/);
    await page.reload();
    await expect(shown).toHaveText(next);

    // Every other screen gets the workspace's snapshot, which never holds a ping URL.
    await page.goto("/app/monitors");
    await expect(page.getByText("Nightly backup").first()).toBeVisible();
    const html = await page.content();
    for (const t of [token, next.split("/").pop()!]) expect(html).not.toContain(t);
  });

  test("makes the app's status page, which starts with its HTTP monitor as a component, and visitors see it", async ({ page, browser }) => {
    await page.goto("/app/status-pages");
    await pickApp(page, page.getByLabel("App", { exact: true }), "Lighthouse");
    await page.getByRole("button", { name: "New status page" }).click();
    await page.waitForURL(/\/app\/status-pages\/page_[0-9a-f]{24}$/);

    await page.getByLabel("Page name").fill("Lighthouse status");
    await page.getByRole("textbox", { name: "Staygreen address" }).fill(SLUG);
    // A new page starts with one component per HTTP monitor of the app, checked by it.
    await expect(page.locator("#pe-c-0")).toHaveValue("Lighthouse API");
    await expect(page.locator("#pe-c-1")).toHaveCount(0);
    await page.locator("#pe-c-0").fill("API");
    await page.getByText("Checked by Lighthouse API").click();
    await expect(page.getByRole("checkbox", { name: "Lighthouse API" })).toBeChecked();
    const saved = action(page);
    await page.getByRole("button", { name: "Save changes" }).click();
    await saved;
    await expect(page.getByText("Everything here is what visitors see.")).toBeVisible();

    editorPath = new URL(page.url()).pathname;
    // A logo saves on its own.
    const logo = page.getByLabel("Logo image");
    const uploaded = action(page);
    await logo.setInputFiles("tests/fixtures/page-assets/logo.png");
    await uploaded;
    await expect(page.getByText("Logo image saved. Visitors see it on their next refresh.")).toBeVisible();

    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    const res = await pub.goto(`/s/${SLUG}`);
    expect(res?.status()).toBe(200);
    await expect(pub.getByRole("heading", { level: 1, name: "Not checked yet" })).toBeVisible();
    await expect(pub.locator(".sp-comp-name")).toHaveText(["API"]);
    // The page shows the uploaded logo, which loads under the page's CSP, and the tab uses it.
    const img = pub.locator("img.sp-uploaded-logo").first();
    const src = await img.getAttribute("src");
    expect(src).toMatch(/^\/page-assets\/asset_[0-9a-f]{32}$/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
    await expect(pub.locator(`link[rel="icon"][href="${src}"]`)).toHaveCount(1);

    // The README badge: the widget screen hands out its Markdown on the app's public address, the
    // Copy button copies exactly that, and the image it names answers a stranger in the page's state.
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    // The editor's copy icon copies the address its heading shows, as a link.
    const shownAddress = await page.locator(".page-head .addr").textContent();
    expect(shownAddress).toMatch(new RegExp(`/${SLUG}$`));
    await page.getByRole("button", { name: "Copy address" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://${shownAddress}`);

    await page.goto("/app/widget");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Widget and badge/ })).not.toContainText("Soon");
    const markdown = `[![Lighthouse status](${BASE_URL}/s/${SLUG}/badge.svg)](${BASE_URL}/s/${SLUG})`;
    // The screen also hands out the banner and pill embed; this is the README one.
    await expect(page.locator("pre.snippet", { hasText: "badge.svg" })).toHaveText(markdown);
    await expect(page.getByRole("img", { name: "Lighthouse status", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Copy Markdown" }).click();
    await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(markdown);
    const badge = await visitor.request.get(`/s/${SLUG}/badge.svg`);
    expect(badge.status()).toBe(200);
    expect(badge.headers()["content-type"]).toBe("image/svg+xml");
    const svg = await badge.text();
    expect(svg).toContain("<title>Lighthouse status: not checked yet</title>");
    expect(svg).toContain(">Staygreen</text>");
    await visitor.close();
  });

  test("copies the saved Staygreen address, preserves collapsed drafts and saves component order", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.goto(editorPath);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const copy = page.getByRole("button", { name: "Copy Staygreen address", exact: true });
    await copy.click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://status.staygreen.io/${SLUG}`);
    await page.getByRole("textbox", { name: "Staygreen address" }).fill(`${SLUG}-draft`);
    await expect(copy).toHaveCount(0);

    await page.getByLabel("Page name", { exact: true }).fill("");
    await page.getByLabel("Domain", { exact: true }).fill("status.unsaved.example.com");
    for (const title of ["Branding", "Address", "Your own domain", "Components", "Options"]) {
      const toggle = page.getByRole("button", { name: `Collapse ${title}`, exact: true });
      const content = page.locator(`#${await toggle.getAttribute("aria-controls")}`);
      await toggle.click();
      await expect(content).toBeHidden();
      await expect(page.getByRole("button", { name: `Expand ${title}`, exact: true })).toHaveAttribute("aria-expanded", "false");
    }
    // Browser validation opens Branding; the untouched collapsed sections stay closed.
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("button", { name: "Collapse Branding" })).toBeVisible();
    await expect(page.getByLabel("Page name", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await page.getByRole("button", { name: "Expand Address", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Staygreen address" })).toHaveValue(`${SLUG}-draft`);
    await page.getByRole("button", { name: "Expand Your own domain", exact: true }).click();
    await expect(page.getByLabel("Domain", { exact: true })).toHaveValue("status.unsaved.example.com");
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(copy).toBeVisible();
    await page.getByRole("button", { name: "Expand Components", exact: true }).click();

    for (const name of ["Website", "Database"]) {
      await page.getByRole("button", { name: "Add component", exact: true }).click();
      const row = page.locator(".pe-comp").last();
      await row.getByLabel("Name", { exact: true }).fill(name);
      await row.locator("summary").click();
      await row.getByRole("checkbox", { name: "Lighthouse API", exact: true }).check();
    }
    for (const row of await page.locator(".pe-comp").all()) await row.getByRole("switch", { name: "Show in your app's banner" }).check();

    const up = page.getByRole("button", { name: "Move Database up", exact: true });
    await up.click();
    await expect(up).toBeFocused();
    await up.press("Enter");
    await expect(up).toBeFocused();
    await expect(up).toHaveAttribute("aria-disabled", "true");
    // End controls remain focusable but activation cannot move them past the end.
    await up.press("Enter");
    await expect.poll(() => page.locator(".pe-comp input[data-key]").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)))
      .toEqual(["Database", "API", "Website"]);
    const down = page.getByRole("button", { name: "Move API down", exact: true });
    await down.click();
    await expect(down).toBeFocused();
    await expect(down).toHaveAttribute("aria-disabled", "true");

    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expectNoOverflow(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const saved = action(page);
    await page.getByRole("button", { name: "Save changes" }).click();
    await saved;
    await expect(page.getByText("Everything here is what visitors see.")).toBeVisible();
    const pageId = editorPath.split("/").pop()!;
    expect(await select<{ name: string; position: number }>("page_components", `page_id=eq.${pageId}&select=name,position&order=position`))
      .toEqual([{ name: "Database", position: 0 }, { name: "Website", position: 1 }, { name: "API", position: 2 }]);
    await page.reload();
    await expect.poll(() => page.locator(".pe-comp input[data-key]").evaluateAll(inputs => inputs.map(input => (input as HTMLInputElement).value)))
      .toEqual(["Database", "Website", "API"]);
    const visitor = await browser.newContext();
    try {
      const pub = await visitor.newPage();
      await pub.goto(`/s/${SLUG}`);
      await expect(pub.locator(".sp-comp-name")).toHaveText(["Database", "Website", "API"]);
    } finally { await visitor.close(); }

    await page.goto("/app/widget");
    await expect(page.getByText("Banner enabled for: Database, Website, API.", { exact: false })).toBeVisible();
    const first = page.locator(".wd-piece").first();
    await expect(first.locator(".sg-banner")).toBeVisible();
    await expect(first.getByText("Example update", { exact: true })).toBeVisible();
    await first.getByRole("switch", { name: "Simulate an incident" }).check();
    await expect(first.getByText("Simulated, with an example update. Dismissing it ends the simulation.")).toBeVisible();
    await first.getByRole("button", { name: "Dismiss this update" }).click();
    await expect(first.getByRole("switch", { name: "Simulate an incident" })).not.toBeChecked();
    await expect(first.locator(".sg-banner")).toHaveCount(0);
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expectNoOverflow(page);
    }

    // Restore the serial journey's one-component fixture for its later incident assertions.
    await page.goto(editorPath);
    await page.getByRole("button", { name: "Remove Database", exact: true }).click();
    await page.getByRole("button", { name: "Remove Website", exact: true }).click();
    await page.getByRole("switch", { name: "Show in your app's banner" }).uncheck();
    const restored = action(page);
    await page.getByRole("button", { name: "Save changes" }).click();
    await restored;
  });

  test("takes the image a builder has, up to 10 MB or an SVG, and stores a small one of its pixels only", async ({ page }) => {
    await page.goto(editorPath);
    /** Choose a file, wait for the server's answer, and fetch what the page now serves, with the
     *  size a browser decodes it at. */
    async function upload(kind: "logo" | "favicon", file: { name: string; mimeType: string; buffer: Buffer }) {
      const current = page.locator(`img[alt="Current ${kind}"]`);
      const before = (await current.count()) ? await current.getAttribute("src") : null;
      const answered = action(page);
      await page.getByLabel(kind === "logo" ? "Logo image" : "Favicon", { exact: true }).setInputFiles(file);
      await answered;
      await expect(page.locator(`#pe-asset-${kind}-error`)).toHaveCount(0);
      await expect.poll(() => current.getAttribute("src")).not.toBe(before);
      const src = (await current.getAttribute("src"))!;
      await expect.poll(() => current.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);
      const res = await page.request.get(src);
      return { type: res.headers()["content-type"], bytes: await res.body(), size: await current.evaluate((el: HTMLImageElement) => ({ width: el.naturalWidth, height: el.naturalHeight })) };
    }
    const pixelsOnly = (r: { type: string; bytes: Buffer }) => {
      expect(r.type).toMatch(/^image\/(webp|png)$/);
      expect(r.bytes.length).toBeLessThan(PAGE_ASSET_LIMIT);
      expect(r.bytes.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
      expect(r.bytes.includes(Buffer.from("<svg"))).toBe(false);
    };

    // Over 10 MB is refused in the browser, before anything is sent, with the limit named.
    const tooBig = png({ width: 1700, height: 1550, noise: true, level: 0 });
    expect(tooBig.length).toBeGreaterThan(10 * 1024 * 1024);
    await page.getByLabel("Logo image").setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: tooBig });
    await expect(page.locator("#pe-asset-logo-error")).toHaveText("Upload an image no larger than 10 MB.");

    // A 6 MB PNG, with a private text chunk, becomes the logo the header needs: 96 px tall at 3x.
    const big = png({ width: 1300, height: 1200, noise: true, level: 0, before: [pngChunk("tEXt", Buffer.from(`Comment\0${SECRET}`, "latin1"))] });
    expect(big.length).toBeGreaterThan(6_000_000);
    const fromPng = await upload("logo", { name: "export.png", mimeType: "image/png", buffer: big });
    pixelsOnly(fromPng);
    expect(fromPng.size).toEqual({ width: 104, height: 96 });

    // A 9 MB photo with its location in EXIF becomes a small logo, and the location is gone.
    const fromJpeg = await upload("logo", { name: "sign.jpg", mimeType: "image/jpeg", buffer: await photo(page, 9 * 1024 * 1024) });
    pixelsOnly(fromJpeg);
    expect(fromJpeg.size).toEqual({ width: 64, height: 96 });

    // An SVG that carries a script and links an outside image is drawn as an image, so neither
    // runs nor loads, here or for any visitor, and only its pixels are stored.
    const fetched: string[] = [];
    page.on("request", (r) => { if (r.url().includes("sg-svg-probe")) fetched.push(r.url()); });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32"><script>window.top.__sgSvg = 1</script><image href="${new URL("/sg-svg-probe.png", page.url())}" width="64" height="32"/><rect width="32" height="32" fill="teal"/></svg>`;
    const fromSvg = await upload("logo", { name: "logo.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
    pixelsOnly(fromSvg);
    expect(fromSvg.size).toEqual({ width: 192, height: 96 });
    // A favicon from the same SVG is the square a tab draws, as a PNG.
    const favicon = await upload("favicon", { name: "favicon.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
    pixelsOnly(favicon);
    expect([favicon.type, favicon.size]).toEqual(["image/png", { width: 48, height: 48 }]);
    expect(fetched).toEqual([]);
    expect(await page.evaluate(() => (window as { __sgSvg?: number }).__sgSvg)).toBeUndefined();
  });

  test("an incident: acknowledges it, publishes the draft, and visitors see only what was published", async ({ page, browser, request }) => {
    const incidentId = await openIncident({ workspaceId, monitorId: apiMonitorId, title: "Lighthouse API is down" });
    await addNote({ workspaceId, incidentId, body: "We're looking into errors on the API." });

    await page.goto("/app/incidents");
    await expect(page.getByText("Lighthouse: Lighthouse API is down")).toBeVisible();
    await page.getByRole("link", { name: "Open incident" }).click();
    await page.waitForURL(new RegExp(`/app/incidents/${incidentId}$`));

    const acked = action(page);
    await page.getByRole("button", { name: "Acknowledge" }).first().click();
    await acked;
    const [inc] = await select<{ acked_at: string | null }>("incidents", `id=eq.${incidentId}&select=acked_at`);
    expect(inc.acked_at).not.toBeNull();

    const published = action(page);
    await page.getByRole("button", { name: "Publish update" }).first().click();
    await published;
    await expect(page.getByRole("list", { name: "Published updates" })).toContainText("We're looking into errors on the API.");

    // The form stays open after a publish while the incident is open.
    await page.getByLabel("Update", { exact: true }).fill("Draft that must never be public");
    const drafted = action(page);
    await page.getByRole("button", { name: "Save draft" }).click();
    await drafted;
    await expect(page.getByText("Draft that must never be public")).toBeVisible();

    const visitor = await browser.newContext();
    const pub = await visitor.newPage();
    await pub.goto(`/s/${SLUG}`);
    await expect(pub.getByRole("heading", { level: 1, name: "Outage: API" })).toBeVisible();
    await expect(pub.getByText("We're looking into errors on the API.")).toBeVisible();
    await pub.goto(`/i/${incidentId}`);
    await expect(pub.getByRole("heading", { level: 1, name: "API is down" })).toBeVisible();
    await visitor.close();

    // The first response a stranger's browser gets, before any script: the draft isn't in it.
    for (const path of [`/s/${SLUG}`, `/i/${incidentId}`]) {
      const body = await (await request.get(path)).text();
      expect(body).toContain("We&#x27;re looking into errors on the API.");
      expect(body).not.toContain("Draft that must never be public");
    }
  });

  test("one app choice filters all four collections and survives the workspace screens and reload", async ({ page }) => {
    test.setTimeout(120_000);
    // Free has one app, so the second is a row a workspace keeps from Builder, written directly.
    const [second] = await insert<{ id: string }>("apps", { workspace_id: workspaceId, name: "Beacon", url: "https://example.org" });
    secondAppId = second.id;
    await page.goto("/app");

    const rail = page.getByRole("complementary", { name: "Workspace" });
    const switcher = rail.getByRole("button", { name: /^App:/ });
    const menu = rail.getByRole("menu", { name: "Choose app" });
    const choose = async (name: string) => {
      await switcher.click();
      await menu.getByRole("menuitemradio", { name: new RegExp(`^${name}(,|$)`) }).click();
      await expect(switcher).toHaveAccessibleName(`App: ${name}`);
    };
    await expect(switcher).toHaveAccessibleName("App: All apps");
    await switcher.click();
    // An empty app keeps the hollow ring and says why, in the same words as the rail's summary.
    const unchecked = menu.getByRole("menuitemradio", { name: "Beacon, No monitors yet" });
    await expect(unchecked.locator("svg.state-icon.unchecked")).toBeVisible();
    await expect(unchecked.locator("svg")).toHaveCount(1);
    // Past Free's one app, the menu's Add app lands on the overview with the Builder offer open.
    await menu.getByRole("menuitem", { name: "Add app" }).click();
    await expect(page).toHaveURL(/\/app\?add=app$/);
    const offer = page.getByRole("dialog", { name: "More apps with Builder" });
    await expect(offer).toBeVisible();
    await expect(offer.getByRole("link")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(offer).toBeHidden();

    // An app with nothing open still says what is open elsewhere: the choice never reads as "nothing is down".
    await rail.getByRole("link", { name: /^Incidents/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Incidents", exact: true })).toBeVisible();
    await expect(page.getByRole("main")).not.toHaveAttribute("aria-busy", "true");
    // The document's queued navigation scroll must not dismiss a menu anchored to the
    // unchanged sticky rail. Deliver it after opening, the order that used to lose the click.
    await switcher.click();
    await expect(menu).toBeVisible();
    await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await choose("Beacon");
    // Beacon has no monitors, so its line says so, and names it: "No incidents" alone would read as the workspace.
    await expect(page.getByText("No incidents in Beacon. Nothing in it has been checked yet.", { exact: true })).toBeVisible();
    await expect(page.getByText("1 incident open in other apps.", { exact: true })).toBeVisible();
    await expect(rail.getByRole("link", { name: /^Incidents/ })).toContainText("1 open");
    // Under the switcher, the chosen app's state, then what is wrong in the others.
    await expect(rail.locator(".rail-app .rail-sum")).toHaveText(["No monitors yet", "Other apps: 1 down"]);
    await page.getByRole("button", { name: "Show all apps" }).click();
    await expect(rail.locator(".rail-app .rail-sum")).toHaveText(["1 down"]);
    await expect(switcher).toHaveAccessibleName("App: All apps");
    await expect(page.getByText("Lighthouse: Lighthouse API is down", { exact: true })).toBeVisible();
    await rail.getByRole("link", { name: "Overview", exact: true }).click();
    await page.waitForURL(/\/app$/);

    const [mon] = await insert<{ id: string }>("monitors", {
      workspace_id: workspaceId, app_id: secondAppId, type: "http", name: "Beacon API",
      target: "https://example.org/health", target_host: "example.org", interval_sec: 180,
    });
    await openIncident({ workspaceId, monitorId: mon.id, title: "Beacon API is down" });
    await page.reload();
    await expect(page.locator(".app-block")).toHaveCount(2);
    await choose("Beacon");
    await expect(page.locator(".app-block")).toHaveCount(1);
    await expect(page.locator(".app-block")).toContainText("Beacon API");
    await expect(page.getByRole("region", { name: "Needs attention" })).toContainText("Beacon API is down");
    await expect(page.getByRole("region", { name: "Needs attention" })).not.toContainText("Lighthouse");
    // The overview of one app is that app's, and still says what needs the builder in the others.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("One thing in Beacon needs you");
    await expect(page.getByText("One thing needs you in other apps.", { exact: true })).toBeVisible();
    await expect(rail.locator(".rail-app .rail-sum")).toHaveText(["1 down", "Other apps: 1 down"]);
    // The rail's count is every app's, like the other-apps line above it.
    await expect(rail.getByRole("link", { name: /Incidents/ })).toContainText("2 open");
    expect(new URL(page.url()).searchParams.has("app")).toBe(false);

    await rail.getByRole("link", { name: "Monitors", exact: true }).click();
    await expect(page.getByRole("button", { name: "App", exact: true })).toHaveAccessibleDescription("Beacon");
    await expect(page.getByRole("link", { name: "Beacon API", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Lighthouse API", exact: true })).toHaveCount(0);
    await pickApp(page, page.getByLabel("App", { exact: true }), "Lighthouse");
    await expect(switcher).toHaveAccessibleName("App: Lighthouse");
    await expect(page.getByRole("link", { name: "Lighthouse API", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Beacon API", exact: true })).toHaveCount(0);
    await rail.getByRole("link", { name: /Incidents/ }).click();
    await expect(page.getByRole("button", { name: "App", exact: true })).toHaveAccessibleDescription("Lighthouse");
    await expect(page.getByText("Lighthouse: Lighthouse API is down", { exact: true })).toBeVisible();
    await expect(page.getByText("Beacon: Beacon API is down", { exact: true })).toHaveCount(0);
    await pickApp(page, page.getByLabel("App", { exact: true }), "Beacon");
    await expect(switcher).toHaveAccessibleName("App: Beacon");
    await expect(page.getByText("Beacon: Beacon API is down", { exact: true })).toBeVisible();
    await expect(page.getByText("Lighthouse: Lighthouse API is down", { exact: true })).toHaveCount(0);
    // An app with its own incident open still says another app has one too.
    await expect(page.getByText("1 incident open in other apps.", { exact: true })).toBeVisible();
    await rail.getByRole("link", { name: "Status pages", exact: true }).click();
    await expect(page.getByText("No status page for this app yet", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Lighthouse status", exact: true })).toHaveCount(0);
    await expect(page.locator(".page-head")).toContainText("1 of 1 used");
    // Free's one page is in use: the button keeps its place and says what Builder adds.
    await page.getByRole("button", { name: "New status page (Builder)" }).click();
    await expect(page.getByRole("dialog", { name: "More status pages with Builder" })).toBeVisible();
    await page.keyboard.press("Escape");
    await choose("Lighthouse");
    await expect(page.getByRole("link", { name: "Lighthouse status", exact: true })).toBeVisible();
    await expect(page.getByLabel("App", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("App", { exact: true })).toHaveText("This app has a page");

    for (const [label, path] of [["Alerts", "alerts"], ["Widget and badge", "widget"], ["Agents and API", "agents"], ["Plan and billing", "billing"], ["Settings", "settings"]]) {
      await rail.getByRole("navigation").getByRole("link", { name: new RegExp(`^${label}`) }).click();
      await page.waitForURL(new RegExp(`/app/${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(switcher).toHaveAccessibleName("App: Lighthouse");
      if (label === "Alerts") {
        await pickApp(page, page.getByLabel("App", { exact: true }), "Beacon");
        await expect(page.getByRole("combobox", { name: "Applies to" })).toHaveValue("");
        await pickApp(page, page.getByLabel("App", { exact: true }), "Lighthouse");
        // Routing's app choice is local to its form; it does not change the dashboard filter.
        await expect(switcher).toHaveAccessibleName("App: Lighthouse");
      }
      if (label === "Settings") {
        // Each app's delete is behind its "…" menu (owner, 2026-10-26).
        await expect(page.getByRole("button", { name: "More for Lighthouse", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: "More for Beacon", exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: /^Delete/ })).toHaveCount(0);
      }
    }
    await page.reload();
    await expect(switcher).toHaveAccessibleName("App: Lighthouse");
    await choose("Beacon");
    await page.waitForURL(/\/app$/);
    await expect(page.locator(".app-block")).toHaveCount(1);
    await expect(page.locator(".app-block")).toContainText("Beacon");
    await page.locator(".page-head").getByRole("link", { name: "Add monitor", exact: true }).click();
    await expect(page.getByLabel("Which app is it part of?").locator(".app-picker-name")).toHaveText("Beacon");
    expect(new URL(page.url()).searchParams.has("app")).toBe(false);
    // A reload restores the choice after the form's first render; the form still follows it.
    await page.reload();
    await expect(switcher).toHaveAccessibleName("App: Beacon");
    await expect(page.getByLabel("Which app is it part of?").locator(".app-picker-name")).toHaveText("Beacon");
    await pickApp(page, page.getByLabel("Which app is it part of?"), "Lighthouse");
    await expect(switcher).toHaveAccessibleName("App: Beacon");
  });

  test("the app filter supports the keyboard, light dismissal and both themes at the phone floor", async ({ page }) => {
    await page.goto("/app/monitors");
    const trigger = page.getByLabel("App", { exact: true });
    const list = page.getByRole("listbox", { name: "App", exact: true });
    await trigger.click();
    await expect(list).toBeVisible();
    await trigger.click();
    await expect(list).toBeHidden();
    await trigger.focus();
    await page.keyboard.press("End");
    await expect(list.getByRole("option").last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(list.getByRole("option", { name: "All apps", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(list.getByRole("option").nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(list.getByRole("option", { name: "All apps", exact: true })).toBeFocused();
    await page.keyboard.press("b");
    await expect(list.getByRole("option", { name: "Beacon", exact: true })).toBeFocused();
    await expect(trigger).toHaveAccessibleDescription("All apps");
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAccessibleDescription("Beacon");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(list.getByRole("option", { name: "Beacon", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(list.getByRole("option", { name: "All apps", exact: true }).locator(".app-logo")).toHaveCount(0);
    await expect(list.getByRole("option", { name: "Beacon", exact: true }).locator(".app-logo")).toBeVisible();
    await page.keyboard.press("Home");
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAccessibleDescription("Beacon");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await trigger.click();
    await page.getByLabel("Search monitors").click();
    await expect(list).toBeHidden();
    await expect(page.getByLabel("Search monitors")).toBeFocused();
    await trigger.click();
    await page.keyboard.press("Tab");
    await expect(list).toBeHidden();
    await expect(page.getByLabel("Type", { exact: true })).toBeFocused();

    await page.setViewportSize({ width: 320, height: 720 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(theme => document.documentElement.setAttribute("data-theme", theme), theme);
      await trigger.click();
      await expect(list).toBeVisible();
      await expectNoOverflow(page);
      const box = await list.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      await page.keyboard.press("Escape");
    }
  });

  test("details keep their own item; fresh tabs and fresh visits start on All apps", async ({ page, context }) => {
    test.setTimeout(120_000);
    await page.goto("/app/monitors");
    const rail = page.getByRole("complementary", { name: "Workspace" });
    const switcher = rail.getByRole("button", { name: /^App:/ });
    const choose = async (name: string) => {
      await switcher.click();
      await rail.getByRole("menuitemradio", { name: new RegExp(`^${name}(,|$)`) }).click();
    };
    for (const [collection, item, heading] of [
      ["Monitors", "Lighthouse API", "Lighthouse API"],
      ["Incidents", "Open incident", "Lighthouse API is down"],
      ["Status pages", "Lighthouse status", "Lighthouse status"],
    ]) {
      await choose("Lighthouse");
      await rail.getByRole("link", { name: new RegExp(`^${collection}`) }).click();
      await page.getByRole("main").getByRole("link", { name: item, exact: true }).click();
      // The detail's own address, once the navigation has landed, not the list's.
      await page.waitForURL(/\/app\/(monitors|incidents|status-pages)\/[^/?]+/);
      const detailUrl = page.url();
      await rail.getByRole("link", { name: "Monitors", exact: true }).click();
      await page.waitForURL(/\/app\/monitors$/);
      await choose("Beacon");
      await page.goBack();
      await expect(page).toHaveURL(detailUrl);
      if (collection === "Status pages") await expect(page.getByLabel("Page name")).toHaveValue(heading);
      else await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(switcher).toHaveAccessibleName("App: Beacon");
      await page.reload();
      await expect(switcher).toHaveAccessibleName("App: Beacon");
      // Choosing on a detail always shows the selected app's overview.
      await choose("Lighthouse");
      await page.waitForURL(/\/app$/);
      await expect(page.locator(".app-block")).toHaveCount(1);
    }

    const fresh = await context.newPage();
    await setupClerkTestingToken({ page: fresh });
    await fresh.goto("/app");
    await expect(fresh.locator("aside").getByRole("button", { name: "App: All apps", exact: true })).toBeVisible();
    await expect(fresh.locator(".app-block")).toHaveCount(2);
    await fresh.close();
    // window.open deliberately keeps an opener: the new tab receives a copy of sessionStorage.
    const popupReady = page.waitForEvent("popup");
    await page.evaluate(() => window.open("/app", "_blank"));
    const popup = await popupReady;
    await expect(popup.locator("aside").getByRole("button", { name: "App: All apps", exact: true })).toBeVisible();
    await expect(popup.locator(".app-block")).toHaveCount(2);
    await popup.close();
    await expect(switcher).toHaveAccessibleName("App: Lighthouse");
    // A fresh document visit in this tab also cannot carry yesterday's choice forward.
    await page.goto("/app");
    await expect(switcher).toHaveAccessibleName("App: All apps");
  });

  test("the switcher works with keys and in the phone drawer, then clears when one app remains", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/app");
    const rail = page.getByRole("complementary", { name: "Workspace" });
    const switcher = rail.getByRole("button", { name: /^App:/ });
    const menu = rail.getByRole("menu", { name: "Choose app" });
    await switcher.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: "All apps", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Add app" })).toBeFocused();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: /^Lighthouse,/ })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    await expect(switcher).toBeFocused();
    await expect(switcher).toHaveAccessibleName("App: Lighthouse");
    await page.keyboard.press("Space");
    await expect(menu.getByRole("menuitemradio", { checked: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(switcher).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(menu).toBeHidden();
    await expect(rail.getByRole("link", { name: "Overview", exact: true })).toBeFocused();
    await switcher.click();
    await page.getByRole("heading", { level: 1 }).click();
    await expect(menu).toBeHidden();
    // Both Clerk controls share the footer container, not merely a convenient DOM order.
    await expect(rail.locator(".rail-foot .rail-user .cl-organizationSwitcherTrigger")).toBeVisible();
    await expect(rail.locator(".rail-foot .rail-user .cl-userButtonTrigger")).toBeVisible();

    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole("button", { name: "Open menu" }).click();
      const drawer = page.getByRole("dialog", { name: "Menu", exact: true });
      await expect(drawer.locator(".rail-user .cl-organizationSwitcherTrigger")).toBeVisible();
      await expect(drawer.locator(".rail-user .cl-userButtonTrigger")).toBeVisible();
      const control = drawer.getByRole("button", { name: /^App:/ });
      await control.click();
      const list = drawer.getByRole("menu", { name: "Choose app" });
      const option = list.getByRole("menuitemradio", { name: /^Beacon,/ });
      const box = await list.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await option.click();
      await expect(drawer).toBeHidden();
      await expect(page.locator(".app-block")).toHaveCount(1);
      await expect(page.locator(".app-block")).toContainText("Beacon");
      // The top bar says the same as the rail: the chosen app, its state and the others'.
      await expect(page.locator(".topbar-app-name")).toHaveText("Beacon");
      await expect(page.locator(".topbar-app .rail-sum")).toHaveText(["1 down", "Other apps: 1 down"]);
      await expectNoOverflow(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(switcher).toHaveAccessibleName("App: Beacon");
    // The chosen app, deleted from the overview's "…" menu: the overview falls back to the app left.
    await rail.getByRole("link", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "More for Beacon", exact: true }).click();
    await page.getByRole("menu", { name: "More for Beacon" }).getByRole("menuitem", { name: "Delete app" }).click();
    const deleted = action(page);
    await page.getByRole("dialog").getByRole("button", { name: "Delete app", exact: true }).click();
    await deleted;
    await expect(switcher).toHaveCount(0);
    await expect(page.locator(".app-block")).toHaveCount(1);
    await expect(page.locator(".app-block")).toContainText("Lighthouse");
    await page.reload();
    await expect(switcher).toHaveCount(0);
    await expect(page.locator(".app-block")).toContainText("Lighthouse");
  });

  test("deletes the HTTP monitor, its SSL monitor goes with it, and its address answers not found", async ({ page }) => {
    await page.goto(`/app/monitors/${apiMonitorId}`);
    await page.getByRole("button", { name: "Delete monitor" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Delete Lighthouse API?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Delete monitor" }).click();
    await page.waitForURL(/\/app\/monitors(\?|$)/);
    await expect(page.getByRole("link", { name: /Lighthouse API/ })).toHaveCount(0);

    const mons = await select<Mon>("monitors", `workspace_id=eq.${workspaceId}&select=id,type,auto,target_host,paused_at`);
    expect(mons.map((m) => m.type)).toEqual(["heartbeat"]);

    const res = await page.goto(`/app/monitors/${apiMonitorId}`);
    expect(res?.status()).toBe(404);
  });

  test("deletes the status page from its editor, and its address answers not found", async ({ page, request }) => {
    const [sp] = await select<{ id: string }>("status_pages", `workspace_id=eq.${workspaceId}&select=id`);
    await page.goto(`/app/status-pages/${sp.id}`);
    await page.getByRole("button", { name: "Delete status page" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Delete Lighthouse status?" })).toBeVisible();
    // "Keep it" keeps it.
    await dialog.getByRole("button", { name: "Keep it" }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Delete status page" }).click();
    await dialog.getByRole("button", { name: "Delete status page" }).click();
    await page.waitForURL(/\/app\/status-pages$/);
    expect(await select("status_pages", `workspace_id=eq.${workspaceId}&select=id`)).toEqual([]);
    expect((await request.get(`/s/${SLUG}`)).status()).toBe(404);
  });

  test("deletes the app from Settings, and the dashboard starts over", async ({ page }) => {
    // On a phone, with the "…" at the bottom of the screen: the menu opens above it, inside the
    // screen, and stays open (review ui26).
    await page.setViewportSize({ width: 390, height: 560 });
    await page.goto("/app/settings");
    const more = page.getByRole("button", { name: "More for Lighthouse" });
    await more.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom - window.innerHeight + 8));
    const button = (await more.boundingBox())!;
    expect(button.y + button.height).toBeGreaterThan(560 - 60);
    await more.click();
    const item = page.getByRole("menu", { name: "More for Lighthouse" }).getByRole("menuitem", { name: "Delete app" });
    await expect(item).toBeVisible();
    const box = (await item.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(button.y);
    await item.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Delete Lighthouse?" })).toBeVisible();
    await expect(dialog).toContainText("Its monitor is deleted, with its incidents.");
    const deleted = action(page);
    await dialog.getByRole("button", { name: "Delete app" }).click();
    await deleted;
    await expect(dialog).toBeHidden();
    // The Apps section stays, empty, with the overview's add flow (owner, 2026-10-23).
    const apps = page.getByRole("region", { name: "Apps" });
    await expect(apps).toContainText("No apps yet.");
    await expect(apps.getByRole("link", { name: "Add app" })).toHaveAttribute("href", "/app?add=app");
    expect(await select("apps", `workspace_id=eq.${workspaceId}&select=id`)).toEqual([]);
    expect(await select("monitors", `workspace_id=eq.${workspaceId}&select=id`)).toEqual([]);

    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1, name: "Start with your app" })).toBeVisible();
  });
});
