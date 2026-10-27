import { expect, expectNoOverflow, test } from "./support/fixtures";

// Real authenticated screen and native dialogs; no channel is saved and no provider is called.
// The shared server pins Slack configuration off so this state is deterministic.
test("channel setup validates beside the field and clears credentials on dismissal", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/alerts");
  await expect(page.getByRole("button", { name: "Add to Slack" })).toBeDisabled();
  await expect(page.getByText("Slack isn't configured yet.")).toBeVisible();
  await page.getByRole("button", { name: "Signed webhook", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a signed webhook" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^Channel name/).fill("Receiver");
  await dialog.getByLabel(/^HTTPS endpoint/).fill("https://127.0.0.1/private");
  await dialog.getByRole("button", { name: "Generate secret" }).click();
  await expect(dialog.getByLabel(/^Signing secret/)).toHaveValue(/^[a-f0-9]{64}$/);
  await dialog.getByRole("button", { name: "Add channel", exact: true }).click();
  await expect(dialog.getByLabel(/^HTTPS endpoint/)).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("Use a public HTTPS address on port 443, without a login or fragment.")).toBeVisible();
  await expectNoOverflow(page);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "Signed webhook", exact: true }).click();
  await expect(dialog.getByLabel(/^HTTPS endpoint/)).toHaveValue("");
  await expect(dialog.getByLabel(/^Signing secret/)).toHaveValue("");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Discord", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Connect Discord" }).getByLabel(/^Discord webhook URL/)).toBeVisible();
  await expectNoOverflow(page);
});
