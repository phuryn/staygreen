import { afterAll, beforeAll, expect, it } from "vitest";
import { limits } from "@/lib/plans";
import { incidentDto, snapshotDto } from "@/lib/public-page";
import { clientFor, describeTarget, expectOk, Fixtures, heartbeatMonitor, hex, httpMonitor, readTarget } from "../support/integration";

/* The public surfaces: `public_status_snapshot(slug)` and `public_incident(id)`,
   which `/s/<slug>` and `/i/<id>` render with no session (`AGENTS.md § 2.3`,
   `§ 2.8`: draft notes never reach a public surface; `spec.md § 6`: a monitor
   bound to no component is private).

   Each absence below is paired with a presence on the same page, so an empty
   or missing snapshot can't pass for a withheld row: the draft is absent while
   the page and its other components are present, and it appears the moment it
   is published. The allowlist is asserted as exact key sets at every level, and
   the serialized snapshot is searched for every private string the fixtures
   hold: monitor ids, names, targets, hosts, token hashes, draft bodies, and the
   other workspace's incident. */

const target = readTarget();

describeTarget("public snapshot: only the allowlist, only what a page shows", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);
  const hostApi = `itest-${hex(4)}.example.com`;
  const hostPrivate = `itest-${hex(4)}.example.com`;
  const draftBody = `itest draft ${hex(6)} not for the public`;
  const secondDraftBody = `itest second draft ${hex(6)} not for the public`;
  const publishedPrivateBody = `itest private-monitor update ${hex(6)}`;

  let A: { id: string }, B: { id: string };
  let page: Record<string, any>, otherPage: Record<string, any>, pageB: Record<string, any>;
  let api: Record<string, any>, cron: Record<string, any>, hidden: Record<string, any>, otherMon: Record<string, any>, monB: Record<string, any>;
  let incApi: Record<string, any>, incHidden: Record<string, any>, incOther: Record<string, any>, incB: Record<string, any>;
  let draft: Record<string, any>;

  const snapshot = async (slug: string) => expectOk(await db.rpc("public_status_snapshot", { p_slug: slug })) as Record<string, any> | null;
  const publicIncident = async (id: string) => expectOk(await db.rpc("public_incident", { p_incident_id: id })) as Record<string, any> | null;

  beforeAll(async () => {
    A = await fx.workspace();
    B = await fx.workspace();
    const app = await fx.app(A.id);
    const otherApp = await fx.app(A.id);
    const appB = await fx.app(B.id);

    api = await fx.monitor(httpMonitor(A.id, app.id, hostApi, limits.builder, { p_name: `itest api ${hex(3)}` }));
    cron = await fx.monitor(heartbeatMonitor(A.id, app.id, limits.builder, { p_name: `itest cron ${hex(3)}` }));
    hidden = await fx.monitor(httpMonitor(A.id, app.id, hostPrivate, limits.builder, { p_name: `itest private ${hex(3)}` }));
    otherMon = await fx.monitor(httpMonitor(A.id, otherApp.id, `itest-${hex(4)}.example.com`, limits.builder));
    monB = await fx.monitor(httpMonitor(B.id, appB.id, `itest-${hex(4)}.example.com`, limits.builder));

    page = await fx.page(A.id, app.id, limits.builder.statusPages);
    otherPage = await fx.page(A.id, otherApp.id, limits.builder.statusPages);
    pageB = await fx.page(B.id, appB.id, limits.builder.statusPages);
    // Three components: one per bound monitor and, between them, one with no monitor at all.
    page = await fx.savePage(page as never, [
      { name: "API", monitorIds: [api.id] },
      { name: "Empty component", monitorIds: [] },
      { name: "Cron", inApp: true, monitorIds: [cron.id] },
    ]);
    otherPage = await fx.savePage(otherPage as never, [{ name: "Other page component", monitorIds: [otherMon.id] }]);
    pageB = await fx.savePage(pageB as never, [{ name: "B component", monitorIds: [monB.id] }]);

    incApi = await fx.incident(A.id, api.id, { title: "itest API incident" });
    draft = await fx.note(A.id, incApi.id, false, draftBody);
    incHidden = await fx.incident(A.id, hidden.id, { title: "itest private monitor incident" });
    await fx.note(A.id, incHidden.id, true, publishedPrivateBody);
    incOther = await fx.incident(A.id, otherMon.id, { title: "itest other page incident" });
    await fx.note(A.id, incOther.id, true);
    incB = await fx.incident(B.id, monB.id, { title: "itest B incident" });
    await fx.note(B.id, incB.id, true);
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("returns the page with its two bound components, and nothing for a slug no page has", async () => {
    const s = await snapshot(page.slug);
    expect(s?.page.slug).toBe(page.slug);
    expect(s?.components.map((c: any) => ({ key: c.key, name: c.name, inApp: c.inApp, states: c.states }))).toEqual([
      { key: 0, name: "API", inApp: false, states: [null] },
      { key: 2, name: "Cron", inApp: true, states: [null] },
    ]);
    expect(await snapshot(`itest-${hex(6)}`)).toBeNull();
  });

  it("never shows a component with no monitor", async () => {
    const s = await snapshot(page.slug);
    expect(s?.components.map((c: any) => c.name)).toEqual(["API", "Cron"]);
    expect(JSON.stringify(s)).not.toContain("Empty component");
  });

  it("holds exactly the allowlisted keys at every level", async () => {
    const id = (await db.from("incident_notes").select("id").eq("incident_id", incOther.id).single()).data!.id;
    expect(id).toMatch(/^note_/);
    const s = (await snapshot(otherPage.slug))!;
    expect(Object.keys(s).sort()).toEqual(["components", "incidents", "page"]);
    expect(Object.keys(s.page).sort()).toEqual(["accent", "faviconUrl", "historyDays", "homepage", "logoText", "logoUrl", "name", "noindex", "poweredBy", "slug", "theme"]);
    expect(s.components).toHaveLength(1);
    expect(Object.keys(s.components[0]).sort()).toEqual(["daily", "inApp", "key", "name", "states"]);
    expect(s.incidents).toHaveLength(1);
    expect(Object.keys(s.incidents[0]).sort()).toEqual(["components", "id", "notes", "openedAt", "resolvedAt", "severity", "title"]);
    expect(s.incidents[0].notes).toHaveLength(1);
    expect(Object.keys(s.incidents[0].notes[0]).sort()).toEqual(["at", "body", "id", "state"]);
    const i = (await publicIncident(incOther.id))!;
    expect(Object.keys(i).sort()).toEqual(["components", "incidentId", "incidents", "page"]);
    expect(i.incidentId).toBe(incOther.id);
  });

  it("is a shape the product's own DTO accepts", async () => {
    expect(snapshotDto.safeParse(await snapshot(page.slug)).success).toBe(true);
    expect(snapshotDto.safeParse(await snapshot(otherPage.slug)).success).toBe(true);
    expect(incidentDto.safeParse(await publicIncident(incOther.id)).success).toBe(true);
  });

  it("carries no monitor id, name, target, host, token hash, sealed ping URL or config", async () => {
    const text = JSON.stringify([await snapshot(page.slug), await snapshot(otherPage.slug)]);
    expect(text).toContain("API"); // the page is really there
    for (const m of [api, cron, hidden, otherMon]) {
      for (const value of [m.id, m.name, m.target, m.target_host, m.heartbeat_token_hash, m.heartbeat_token_sealed].filter(Boolean)) {
        expect(text, `monitor field ${value}`).not.toContain(value);
      }
    }
    expect(cron.heartbeat_token_sealed).toMatch(/^v1\./);
    expect(text).not.toContain("assertions");
    expect(text).not.toContain("heartbeat_token");
    expect(text).not.toContain(A.id);
  });

  it("never shows a draft: the incident is absent and public_incident is null until its note is published", async () => {
    let s = await snapshot(page.slug);
    expect(s?.components.length).toBe(2); // the page is there, only the incident is withheld
    expect(s?.incidents).toEqual([]);
    expect(JSON.stringify(s)).not.toContain(draftBody);
    expect(await publicIncident(incApi.id)).toBeNull();

    // Published: the same note appears, and a second draft beside it stays hidden.
    expectOk(
      await db.rpc("save_incident_note", {
        p_workspace_id: A.id,
        p_incident_id: incApi.id,
        p_note_id: draft.id,
        p_state: "identified",
        p_body: draftBody,
        p_publish: true,
        p_author_user_id: null,
        p_author_client: "itest",
      }),
    );
    await fx.note(A.id, incApi.id, false, secondDraftBody);
    s = await snapshot(page.slug);
    expect(s?.incidents.map((i: any) => ({ id: i.id, title: i.title, components: i.components, notes: i.notes.map((n: any) => ({ id: n.id, state: n.state, body: n.body })) }))).toEqual([
      { id: incApi.id, title: "itest API incident", components: [0], notes: [{ id: draft.id, state: "identified", body: draftBody }] },
    ]);
    expect(JSON.stringify(s)).not.toContain(secondDraftBody);
    const i = await publicIncident(incApi.id);
    expect(i?.incidentId).toBe(incApi.id);
    expect(i?.page.slug).toBe(page.slug);
    expect(JSON.stringify(i)).not.toContain(secondDraftBody);
  });

  it("the public routes' loaders find the page by its slug and a published incident by its real id", async () => {
    // `/s/<slug>` and `/i/<id>` read through these (`src/lib/public-data.ts`), each with an id
    // shape check before the query; an id is `public.new_id`'s prefix and 24 hex digits.
    const { loadPublicIncident, loadPublicView } = await import("@/lib/public-data");
    expect(incApi.id).toMatch(/^inc_[0-9a-f]{24}$/);
    const view = await loadPublicView(page.slug);
    expect(view?.components.map((c) => c.name)).toEqual(["API", "Cron"]);
    expect(view?.incidents.map((i) => i.id)).toEqual([incApi.id]);
    const one = await loadPublicIncident(incApi.id);
    expect(one?.incidentId).toBe(incApi.id);
    expect(one?.view.page.slug).toBe(page.slug);
    expect(await loadPublicIncident(incHidden.id)).toBeNull();
  });

  it("never shows an incident on a monitor bound to no component, even with a published note", async () => {
    const s = await snapshot(page.slug);
    expect(s?.incidents.map((i: any) => i.id)).not.toContain(incHidden.id);
    expect(JSON.stringify(s)).not.toContain(publishedPrivateBody);
    expect(await publicIncident(incHidden.id)).toBeNull();
  });

  it("never shows an incident from another page of the same workspace", async () => {
    expect((await snapshot(otherPage.slug))?.incidents.map((i: any) => i.id)).toEqual([incOther.id]);
    expect((await snapshot(page.slug))?.incidents.map((i: any) => i.id)).not.toContain(incOther.id);
    expect((await publicIncident(incOther.id))?.page.slug).toBe(otherPage.slug);
  });

  it("never shows another workspace's incident", async () => {
    expect((await snapshot(pageB.slug))?.incidents.map((i: any) => i.id)).toEqual([incB.id]);
    for (const slug of [page.slug, otherPage.slug]) {
      const text = JSON.stringify(await snapshot(slug));
      expect(text).not.toContain(incB.id);
      expect(text).not.toContain("itest B incident");
      expect(text).not.toContain("B component");
    }
    const i = await publicIncident(incB.id);
    expect(i?.page.slug).toBe(pageB.slug);
    expect(i?.incidents.map((x: any) => x.id)).toEqual([incB.id]);
  });

  it("shows a paused monitor as paused, and a pause whose end has passed as no pause", async () => {
    expectOk(await db.rpc("pause_monitor", { p_workspace_id: A.id, p_monitor_id: cron.id, p_minutes: 60, p_reason: "itest reason never public" }));
    let s = await snapshot(page.slug);
    expect(s?.components.find((c: any) => c.name === "Cron")?.states).toEqual(["paused"]);
    expect(JSON.stringify(s)).not.toContain("itest reason never public");
    const past = await db
      .from("monitors")
      .update({ paused_at: new Date(Date.now() - 2 * 3600_000).toISOString(), paused_until: new Date(Date.now() - 3600_000).toISOString() })
      .eq("id", cron.id)
      .select("id");
    expect(past.data).toHaveLength(1);
    s = await snapshot(page.slug);
    expect(s?.components.find((c: any) => c.name === "Cron")?.states).toEqual([null]);
    expectOk(await db.rpc("resume_monitor", { p_workspace_id: A.id, p_monitor_id: cron.id }));
  });

  it("shows a resolved incident only within the page's history window", async () => {
    const old = await fx.incident(A.id, cron.id, {
      title: "itest old incident",
      opened_at: new Date(Date.now() - 41 * 86400_000).toISOString(),
      resolved_at: new Date(Date.now() - 40 * 86400_000).toISOString(),
    });
    await fx.note(A.id, old.id, true);
    expect(page.history_days).toBe(90);
    expect((await snapshot(page.slug))?.incidents.map((i: any) => i.id)).toContain(old.id);
    await fx.savePage({ ...(page as Parameters<typeof fx.savePage>[0]), history_days: 30 }, [
      { name: "API", monitorIds: [api.id] },
      { name: "Empty component", monitorIds: [] },
      { name: "Cron", inApp: true, monitorIds: [cron.id] },
    ]);
    const s = await snapshot(page.slug);
    expect(s?.page.historyDays).toBe(30);
    expect(s?.incidents.map((i: any) => i.id)).toEqual([incApi.id]);
  });
});
