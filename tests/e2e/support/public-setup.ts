import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { deleteWorkspaces, insert } from "./rest";
import { addNote, openIncident } from "./seed";

/* The public suite's one fixture: a workspace no person signs into, with a status page that has
   something to show and something it must not. Its organization id is made up and matches no
   Clerk organization, so no member can ever reach it. It's rebuilt from nothing on every run and
   deleted by the teardown this function returns. */

export const FIXTURE_ORG = "org_e2epublicfixture";
export const SEED_FILE = join(__dirname, "..", ".seed.json");

export type Seed = {
  slug: string;
  /** The same builder's other pages, one per theme, each with an accent its theme has to shade. */
  accents: { slug: string; theme: "light" | "dark" | "visitor"; accent: string }[];
  pastIncident: string;
  privateIncident: string;
  published: string;
  hostile: string;
  draft: string;
  privateNames: string[];
};

export default async function publicSetup() {
  config({ quiet: true });
  await deleteWorkspaces([FIXTURE_ORG]);

  const [ws] = await insert<{ id: string }>("workspaces", { clerk_org_id: FIXTURE_ORG });
  const [app] = await insert<{ id: string }>("apps", { workspace_id: ws.id, name: "Harbor", url: "https://harbor.example.com" });
  const mon = (name: string, target: string) => ({ workspace_id: ws.id, app_id: app.id, type: "http", name, target, target_host: new URL(target).host, interval_sec: 180 });
  const [site] = await insert<{ id: string }>("monitors", mon("Harbor website", "https://harbor.example.com/"));
  // On no component, so on no page: its name, address and incident must never reach a visitor.
  const [hidden] = await insert<{ id: string }>("monitors", mon("Internal billing worker", "https://billing-internal.example.com/health"));

  // Pure yellow can't be read on white as it is, so a light page has to darken it.
  const [page] = await insert<{ id: string }>("status_pages", { workspace_id: ws.id, app_id: app.id, slug: "e2e-harbor", name: "Harbor status", logo_text: "Harbor", homepage: "https://harbor.example.com", theme: "light", accent: "#ffff00" });
  // Navy can't be read on near-black, and a page that follows the visitor needs both shades.
  const accents: Seed["accents"] = [
    { slug: "e2e-harbor", theme: "light", accent: "#ffff00" },
    { slug: "e2e-harbor-night", theme: "dark", accent: "#1b2a4a" },
    { slug: "e2e-harbor-dusk", theme: "visitor", accent: "#1b2a4a" },
  ];
  for (const a of accents.slice(1)) {
    const [other] = await insert<{ id: string }>("apps", { workspace_id: ws.id, name: `Harbor ${a.theme}`, url: "https://harbor.example.com" });
    await insert("status_pages", { workspace_id: ws.id, app_id: other.id, slug: a.slug, name: `Harbor ${a.theme} status`, logo_text: "Harbor", homepage: "https://harbor.example.com", theme: a.theme, accent: a.accent });
  }
  const [cmp] = await insert<{ id: string }>("page_components", { workspace_id: ws.id, page_id: page.id, name: "Website", position: 0 });
  await insert("component_monitors", { workspace_id: ws.id, component_id: cmp.id, monitor_id: site.id });

  const published = "We rolled back the cache change and pages load again.";
  // A member's words reach strangers here, so a published note carrying markup must arrive as text.
  const hostile = `<script>window.__sgXss=1</script><img src="x" onerror="window.__sgXss=2"> was in the error page`;
  const draft = "DRAFT: blame the CDN vendor, do not publish";
  const pastIncident = await openIncident({ workspaceId: ws.id, monitorId: site.id, title: "Harbor website is down", resolved: true });
  await addNote({ workspaceId: ws.id, incidentId: pastIncident, body: hostile, published: true });
  await addNote({ workspaceId: ws.id, incidentId: pastIncident, body: published, published: true });
  await addNote({ workspaceId: ws.id, incidentId: pastIncident, body: draft });

  const privateIncident = await openIncident({ workspaceId: ws.id, monitorId: hidden.id, title: "Internal billing worker is down" });
  await addNote({ workspaceId: ws.id, incidentId: privateIncident, body: "Billing worker restarted by hand", published: true });

  const seed: Seed = {
    slug: "e2e-harbor",
    accents,
    pastIncident,
    privateIncident,
    published,
    hostile,
    draft,
    privateNames: ["Internal billing worker", "billing-internal.example.com", "Billing worker restarted by hand"],
  };
  writeFileSync(SEED_FILE, JSON.stringify(seed, null, 2));

  return async () => {
    await deleteWorkspaces([FIXTURE_ORG]);
  };
}
