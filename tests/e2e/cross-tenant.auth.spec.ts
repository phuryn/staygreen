import { readAccounts, STATE } from "./support/accounts";
import { expect, test } from "./support/fixtures";
import { insert, remove } from "./support/rest";
import { openIncident, workspaceOf } from "./support/seed";

/* A member of another workspace holding A's ids (`docs/TESTS.md § Required for every feature
   that touches data`). Account B is signed in for real; A's rows are written straight to the
   development database. Every route answers B exactly as it answers an id that doesn't exist:
   not-found and not-owned are one answer (`AGENTS.md § 1.1`). */

test.use({ storageState: STATE.b });

// A's rows go again afterwards: the journeys start from A's empty workspace.
let appId = "";
test.afterAll(async () => {
  if (appId) await remove("apps", `id=eq.${appId}`);
});

test("account B gets the same not-found for A's monitor, incident and status page as for a missing one", async ({ page }) => {
  const { a } = readAccounts();
  const ws = await workspaceOf(a.orgId);
  const [app] = await insert<{ id: string }>("apps", { workspace_id: ws, name: "Tenant A secret app", url: "https://tenant-a.example.com" });
  appId = app.id;
  const [mon] = await insert<{ id: string }>("monitors", {
    workspace_id: ws,
    app_id: app.id,
    type: "http",
    name: "Tenant A secret monitor",
    target: "https://tenant-a.example.com/health",
    target_host: "tenant-a.example.com",
    interval_sec: 180,
  });
  const [pg] = await insert<{ id: string }>("status_pages", { workspace_id: ws, app_id: app.id, slug: "e2e-tenant-a", name: "Tenant A page" });
  const inc = await openIncident({ workspaceId: ws, monitorId: mon.id, title: "Tenant A secret incident" });

  const missing = { monitors: "mon_000000000000000000000000", incidents: "inc_000000000000000000000000", "status-pages": "page_000000000000000000000000" };
  const foreign = { monitors: mon.id, incidents: inc, "status-pages": pg.id };

  for (const kind of Object.keys(missing) as (keyof typeof missing)[]) {
    const none = await page.goto(`/app/${kind}/${missing[kind]}`);
    const noneHeading = await page.getByRole("heading", { level: 1 }).innerText();
    const theirs = await page.goto(`/app/${kind}/${foreign[kind]}`);
    expect(none?.status(), kind).toBe(404);
    expect(theirs?.status(), kind).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(noneHeading);
    expect(await page.content()).not.toContain("Tenant A secret");
  }

  for (const path of ["/app", "/app/monitors", "/app/incidents", "/app/status-pages"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await page.content(), path).not.toContain("Tenant A secret");
  }
});
