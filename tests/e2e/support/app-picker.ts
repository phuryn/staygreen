import { expect, type Locator, type Page } from "@playwright/test";

/** The labelled AppPicker button and its controlled listbox, including when several pickers exist. */
export async function pickApp(page: Page, trigger: Locator, name: string) {
  await trigger.click();
  const id = await trigger.getAttribute("aria-controls");
  if (!id) throw new Error("AppPicker must name its listbox");
  const list = page.getByRole("listbox").filter({ has: page.getByRole("option", { name, exact: true }) });
  await expect(list).toHaveAttribute("id", id);
  await list.getByRole("option", { name, exact: true }).click();
  await expect(trigger.locator(".app-picker-name")).toHaveText(name);
  await expect(trigger).toBeFocused();
  await expect(list).toBeHidden();
}
