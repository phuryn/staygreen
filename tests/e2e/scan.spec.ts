import { expect, test } from "@playwright/test";
import { BOT_PROTECTION } from "../../src/lib/bot-protection";
const findings = { checked_at: "2026-10-23T12:00:00Z", certificate: { state: "unknown", message: "A valid certificate could not be confirmed.", expires_at: null },
  domain: { state: "unknown", message: "The registry did not provide an expiry date.", expires_at: null }, status_page: { state: "unknown", url: null, message: "No status link was found." },
  supabase: { state: "skipped", message: "No project supplied.", steps: [] }, stripe: { state: "skipped", message: "No key supplied.", failed_events: null, pending_events: null },
  dependencies: { checks: [{ provider: "Clerk", host: "clerk.example.com", url: "https://clerk.example.com/npm/@clerk/clerk-js@6/dist/clerk.browser.js", keyword: "Clerk", purpose: "Catches a missing sign-in script.", dns: "issue", tls: "unknown", frontend: "issue", reason: BOT_PROTECTION }], dns: [{ kind: "dns", record: "NS", recordName: "example.com", expected: "ns1.example.net, ns2.example.net", name: "Domain nameservers", purpose: "Catches a DNS move." }] },
  crons: [], crons_message: "Use the CLI for repository cron findings.", mcp: "Coming soon" };
test("public scan shows real response states and retry errors without simulated findings", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/scan", route => {
    calls++; return route.fulfill(calls === 1 ? { status: 200, contentType: "application/json", body: JSON.stringify(findings) } : { status: 429, headers: { "Retry-After": "45" }, body: "rate limit" });
  });
  await page.goto("/scan");
  await expect(page.getByRole("heading", { name: "Scan results" })).toHaveCount(0);
  await page.getByLabel("Your app's URL").fill("https://example.com"); await page.getByRole("button", { name: "Scan my app" }).click();
  await expect(page.getByRole("heading", { name: "Scan results" })).toBeVisible(); await expect(page.getByText("A valid certificate could not be confirmed.")).toBeVisible();
  await expect(page.getByText("Unknown and skipped checks are not an all-clear.", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign-in dependencies" })).toBeVisible();
  await expect(page.getByText("DNS: issue. TLS: unknown. Frontend: issue.")).toBeVisible();
  await expect(page.getByText(BOT_PROTECTION)).toBeVisible();
  await expect(page.getByText("ns1.example.net, ns2.example.net", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Scan my app" }).click(); await expect(page.getByRole("alert").filter({ hasText: "Too many scans" })).toContainText("45 seconds");
  await expect(page.getByRole("heading", { name: "Scan results" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
