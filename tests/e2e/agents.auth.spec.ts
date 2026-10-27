import { expect, expectNoOverflow, test } from "./support/fixtures";

// A credential appears once in the DOM and in the HTTP headers; neither belongs in artifacts.
test.use({ trace: "off", screenshot: "off", video: "off" });

// Real member session and native dialogs; creates and revokes one read-only fixture token.
// No agent write or external monitor check is performed.
test("agent setup, one-time token display and revocation work at phone width", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/agents");
  await expect(page.getByRole("heading", { name: "Connect your agent" })).toBeVisible();
  await expect(page.getByRole("list", { name: "The tools of Staygreen's MCP" }).getByText("scan_app", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "Create an API token" });
  await expect(dialog.getByRole("combobox", { name: "Access" })).toHaveValue("read");
  const name = `Agent browser ${Date.now()}`;
  await dialog.getByLabel("Client or pipeline name").fill(name);
  await dialog.getByRole("button", { name: "Create token", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Save your token" });
  await expect(dialog).toBeVisible();
  const token = (await dialog.locator("code").innerText()).trim();
  expect(token).toMatch(/^sg_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/);
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  await expectNoOverflow(page);
  await dialog.getByRole("button", { name: "I've saved it" }).click();
  await expect(page.getByText(token, { exact: true })).toHaveCount(0);
  const headers = { authorization: `Bearer ${token}` };
  const result = await request.post("/api/v1/get_status", { headers, data: {} });
  expect(result.status()).toBe(200);
  await page.getByRole("button", { name: `Revoke ${name}` }).click();
  dialog = page.getByRole("dialog", { name: "Revoke this token?" });
  await dialog.getByRole("button", { name: "Revoke token", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await request.post("/api/v1/get_status", { headers, data: {} })).status()).toBe(401);
  await page.reload(); await expect(page.getByRole("button", { name: `Revoke ${name}` })).toHaveCount(0);
});
