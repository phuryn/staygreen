import { createHash } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Caller } from "@/lib/authz";
import { FREE, type Entitlements } from "@/lib/plans";
import { clientFor, describeTarget, Fixtures, hex, readTarget, testUserId } from "../support/integration";
import { imageForm } from "../support/page-assets";

/* Cross-tenant through the product's own Server Actions and reads, on the real
   database (`docs/TESTS.md`, the Integration row: identity is a mock verifier
   behind the same seam as Clerk, `setSessionVerifier` in `session.ts`).

   What this adds to `cross-tenant.test.ts`: the writes that are statements
   rather than SQL functions (rotating a heartbeat, deleting a note or a status
   page), editing a monitor's secret headers, each
   action's resolve-then-check (`AGENTS.md § 1.1`), and the dashboard's reads:
   `loadSnapshot`, which must never carry another workspace's row or any ping
   URL, and `heartbeatUrlOf`, which opens one heartbeat's URL for its own page.

   Faked here and nowhere else: the caller (the verifier), the request headers a
   same-origin browser sends (`next/headers`), and DNS for a monitor's host
   (`setResolver`, answering one public address). Everything the actions write
   goes to the development database. */

vi.mock("next/headers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/headers")>();
  return { ...actual, headers: async () => new Headers({ "sec-fetch-site": "same-origin", host: "localhost" }) };
});

const target = readTarget();

const NOT_FOUND = { ok: false, reason: "That isn't here any more. Reload the page." };

/** Free with room for apps: these workspaces hold several, built through `addApp`, and this suite
 *  isn't about the app limit (`limits.test.ts` holds it). Every other number is Free's. */
const ROOMY: Entitlements = { ...FREE, limits: { ...FREE.limits, apps: 100 } };

describeTarget("actions: a member of A, with B's ids, is refused by every action and never reads B", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);
  let actions: typeof import("@/app/(app)/app/actions");
  let workspace: typeof import("@/lib/workspace");

  let caller: Caller | null = null;
  let A: { id: string; clerk_org_id: string }, B: { id: string; clerk_org_id: string };
  let callerA: Caller, callerB: Caller;
  const b: Record<string, string> = {};
  const a: Record<string, string> = {};
  let bHbUrl = "";

  const as = async <T>(who: Caller, run: () => Promise<T>): Promise<T> => {
    caller = who;
    try {
      return await run();
    } finally {
      caller = null;
    }
  };

  const httpDraft = (appId: string) => ({
    type: "http",
    appId,
    name: "",
    url: `https://itest-${hex(4)}.example.com/health`,
    method: "GET",
    expect: "2xx",
    keyword: "",
    slowMs: 1500,
    assertions: [],
    headers: [],
  });
  const heartbeatDraft = (appId: string) => ({ type: "heartbeat", appId, name: "itest cron", schedule: "0 6 * * *", tz: "UTC", graceMin: 10, maxRunMin: 15, assertions: [] });
  const pageDraft = (slug: string, monitorIds: string[]) => ({
    slug,
    name: "itest page",
    logoText: "itest",
    homepage: "",
    accent: "#1F2DE6",
    theme: "visitor",
    poweredBy: true,
    noindex: false,
    historyDays: 90,
    components: [{ name: "api", inApp: false, monitorIds }],
  });

  beforeAll(async () => {
    const session = await import("@/lib/session");
    const targets = await import("@/lib/targets");
    actions = await import("@/app/(app)/app/actions");
    workspace = await import("@/lib/workspace");
    session.setSessionVerifier({ current: async () => caller, entitlements: async () => ROOMY });
    targets.setResolver(async () => ["93.184.216.34"]);

    A = await fx.workspace();
    B = await fx.workspace();
    callerA = { userId: testUserId(), orgId: A.clerk_org_id, orgRole: "org:admin" };
    callerB = { userId: testUserId(), orgId: B.clerk_org_id, orgRole: "org:admin" };

    // B builds its workspace through the actions, as a member would.
    await as(callerB, async () => {
      const app = await actions.addApp({ name: `itest B ${hex(3)}`, url: "" });
      if (!app.ok) throw new Error(`addApp: ${app.reason}`);
      b.app = app.id;
      const app2 = await actions.addApp({ name: `itest B2 ${hex(3)}`, url: "" });
      if (!app2.ok) throw new Error(`addApp: ${app2.reason}`);
      b.app2 = app2.id;
      const mon = await actions.addMonitor(httpDraft(b.app));
      if (!mon.ok) throw new Error(`addMonitor: ${mon.reason} ${JSON.stringify(mon.fieldErrors)}`);
      b.mon = mon.id;
      const hb = await actions.addMonitor(heartbeatDraft(b.app));
      if (!hb.ok || !hb.heartbeatUrl) throw new Error(`addMonitor heartbeat: ${hb.ok ? "no url" : hb.reason}`);
      b.hb = hb.id;
      bHbUrl = hb.heartbeatUrl;
      const page = await actions.addPage(b.app);
      if (!page.ok) throw new Error(`addPage: ${page.reason}`);
      b.page = page.id;
    });
    b.inc = (await fx.incident(B.id, b.mon)).id;
    await as(callerB, async () => {
      const draft = await actions.saveNote(b.inc, { noteId: null, state: "investigating", text: "B's draft", publish: false });
      if (!draft.ok) throw new Error(`saveNote: ${draft.reason}`);
      b.note = draft.id;
      const pub = await actions.saveNote(b.inc, { noteId: null, state: "identified", text: "B's published update", publish: true });
      if (!pub.ok) throw new Error(`saveNote: ${pub.reason}`);
      b.published = pub.id;
    });

    // A has one of everything too, so its own reads are not empty.
    await as(callerA, async () => {
      const app = await actions.addApp({ name: `itest A ${hex(3)}`, url: "" });
      if (!app.ok) throw new Error(`addApp: ${app.reason}`);
      a.app = app.id;
      const hb = await actions.addMonitor(heartbeatDraft(a.app));
      if (!hb.ok || !hb.heartbeatUrl) throw new Error(`addMonitor heartbeat: ${hb.ok ? "no url" : hb.reason}`);
      a.hb = hb.id;
      a.hbUrl = hb.heartbeatUrl;
      const page = await actions.addPage(a.app);
      if (!page.ok) throw new Error(`addPage: ${page.reason}`);
      a.page = page.id;
    });
    a.inc = (await fx.incident(A.id, a.hb)).id;
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  /** Every row B owns, for the before-and-after comparison. */
  async function rowsOfB() {
    const out: Record<string, unknown[]> = {};
    for (const table of ["apps", "app_logos", "monitors", "incidents", "incident_notes", "status_pages", "page_components", "component_monitors"]) {
      const res = await db.from(table).select("*").eq("workspace_id", B.id);
      out[table] = [...(res.data ?? [])].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
    }
    return out;
  }

  it("built B's fixtures through the actions themselves", () => {
    expect(Object.keys(b).sort()).toEqual(["app", "app2", "hb", "inc", "mon", "note", "page", "published"]);
    for (const [k, v] of Object.entries(b)) expect(v, k).toMatch(/^(app|mon|inc|note|page)_[0-9a-f]{24}$/);
  });

  it("refuses every write on B's ids, and leaves B's rows exactly as they were", async () => {
    const before = await rowsOfB();
    const results = await as(callerA, async () => ({
      addMonitor: await actions.addMonitor(httpDraft(b.app)),
      deleteMonitor: await actions.deleteMonitor(b.mon),
      updateMonitor: await actions.updateMonitor(b.mon, httpDraft(b.app)),
      updateMonitorViaOwnApp: await actions.updateMonitor(b.mon, httpDraft(a.app)),
      pauseMonitor: await actions.pauseMonitor(b.mon, 60),
      resumeMonitor: await actions.resumeMonitor(b.hb),
      rotateHeartbeat: await actions.rotateHeartbeat(b.hb),
      ackIncident: await actions.ackIncident(b.inc),
      saveNoteNew: await actions.saveNote(b.inc, { noteId: null, state: "investigating", text: "A on B", publish: false }),
      saveNoteEdit: await actions.saveNote(b.inc, { noteId: b.note, state: "resolved", text: "A rewrites B", publish: true }),
      saveNoteViaOwnIncident: await actions.saveNote(a.inc, { noteId: b.note, state: "resolved", text: "A rewrites B", publish: false }),
      deleteNote: await actions.deleteNote(b.inc, b.note),
      deleteNoteViaOwnIncident: await actions.deleteNote(a.inc, b.note),
      addPage: await actions.addPage(b.app2),
      savePage: await actions.savePage(b.page, pageDraft(`itest-${hex(6)}`, [])),
      deletePage: await actions.deletePage(b.page),
      deleteApp: await actions.deleteApp(b.app),
      updateApp: await actions.updateApp(b.app, { name: "A renames B", url: "https://a.example.com/" }),
      uploadAppLogo: await actions.uploadAppLogo(b.app, imageForm()),
      removeAppLogo: await actions.removeAppLogo(b.app),
      suggestChecks: await actions.suggestChecks(b.app),
      addSuggestedChecks: await actions.addSuggestedChecks(b.app, { urls: [], ssl: true }),
    }));
    expect(results).toEqual({
      addMonitor: { ok: false, reason: "Pick the app this monitor belongs to.", fieldErrors: { appId: "Pick the app this monitor belongs to" } },
      deleteMonitor: NOT_FOUND,
      updateMonitor: NOT_FOUND,
      updateMonitorViaOwnApp: NOT_FOUND,
      pauseMonitor: NOT_FOUND,
      resumeMonitor: NOT_FOUND,
      rotateHeartbeat: NOT_FOUND,
      ackIncident: NOT_FOUND,
      saveNoteNew: NOT_FOUND,
      saveNoteEdit: NOT_FOUND,
      saveNoteViaOwnIncident: NOT_FOUND,
      deleteNote: NOT_FOUND,
      deleteNoteViaOwnIncident: NOT_FOUND,
      addPage: NOT_FOUND,
      savePage: NOT_FOUND,
      deletePage: NOT_FOUND,
      deleteApp: NOT_FOUND,
      updateApp: NOT_FOUND,
      uploadAppLogo: NOT_FOUND,
      removeAppLogo: NOT_FOUND,
      suggestChecks: NOT_FOUND,
      addSuggestedChecks: NOT_FOUND,
    });
    expect(await rowsOfB()).toEqual(before);
  });

  it("refuses binding B's monitor to A's own page, and A's page keeps its components", async () => {
    const before = await db.from("page_components").select("id, name").eq("page_id", a.page);
    const res = await as(callerA, () => actions.savePage(a.page, pageDraft(`itest-${hex(6)}`, [b.mon])));
    expect(res).toEqual({ ok: false, reason: "Something it points at was just deleted. Reload and try again." });
    expect((await db.from("page_components").select("id, name").eq("page_id", a.page)).data).toEqual(before.data);
  });

  const memberOf = (who: Caller, w: { id: string; clerk_org_id: string }) => ({ caller: who, workspace: { id: w.id, clerk_org_id: w.clerk_org_id }, entitlements: FREE });
  const sealedOf = async (id: string) => (await db.from("monitors").select("heartbeat_token_hash, heartbeat_token_sealed").eq("id", id).single()).data!;

  it("loadSnapshot for A carries A's rows and none of B's", async () => {
    const member = memberOf(callerA, A);
    const snap = await workspace.loadSnapshot(member);
    expect(snap.apps.map((x) => x.id)).toEqual([a.app]);
    expect(snap.monitors.map((x) => x.id)).toEqual([a.hb]);
    expect(snap.incidents.map((x) => x.id)).toEqual([a.inc]);
    expect(snap.pages.map((x) => x.id)).toEqual([a.page]);
    const text = JSON.stringify(snap);
    for (const [k, v] of Object.entries(b)) expect(text, `B's ${k}`).not.toContain(v);
    expect(text).not.toContain(B.id);
    expect(text).not.toContain("B's published update");
    // Nor A's own ping URL, in any form: it is read only on the monitor's page.
    const stored = await sealedOf(a.hb);
    expect(stored.heartbeat_token_sealed).toMatch(/^v1\./);
    for (const v of [new URL(a.hbUrl).pathname.slice(1), stored.heartbeat_token_sealed!, stored.heartbeat_token_hash!]) expect(text).not.toContain(v);
    expect(text).not.toContain("heartbeat_token");
  });

  it("heartbeatUrlOf opens a heartbeat's URL for its own workspace's admin only", async () => {
    expect(await workspace.heartbeatUrlOf(memberOf(callerA, A), a.hb)).toBe(a.hbUrl);
    expect(await workspace.heartbeatUrlOf(memberOf(callerB, B), b.hb)).toBe(bHbUrl);
    // A's admin with B's heartbeat, or B's with A's: nothing, the same as a missing id.
    expect(await workspace.heartbeatUrlOf(memberOf(callerA, A), b.hb)).toBeNull();
    expect(await workspace.heartbeatUrlOf(memberOf(callerB, B), a.hb)).toBeNull();
    expect(await workspace.heartbeatUrlOf(memberOf(callerA, A), `mon_${hex(12)}`)).toBeNull();
    // A member's session naming B's workspace is not B's member.
    expect(await workspace.heartbeatUrlOf(memberOf(callerA, B), b.hb)).toBeNull();
    // A role that holds nothing sees nothing.
    expect(await workspace.heartbeatUrlOf(memberOf({ ...callerA, orgRole: "org:member" }, A), a.hb)).toBeNull();
  });

  it("a ping URL's sealed copy opens only on the monitor it was made for", async () => {
    const other = await as(callerA, () => actions.addMonitor(heartbeatDraft(a.app)));
    if (!other.ok || !other.heartbeatUrl) throw new Error(`addMonitor heartbeat: ${other.ok ? "no url" : other.reason}`);
    expect(await workspace.heartbeatUrlOf(memberOf(callerA, A), other.id)).toBe(other.heartbeatUrl);
    const moved = await db.from("monitors").update({ heartbeat_token_sealed: (await sealedOf(a.hb)).heartbeat_token_sealed }).eq("id", other.id);
    expect(moved.error).toBeNull();
    expect(await workspace.heartbeatUrlOf(memberOf(callerA, A), other.id)).toBeNull();
    expect(await workspace.heartbeatUrlOf(memberOf(callerA, A), a.hb)).toBe(a.hbUrl);
    expect(await as(callerA, () => actions.deleteMonitor(other.id))).toEqual({ ok: true });
  });

  it("resolves B's ids to B's workspace, so the action's own-workspace check is what refuses A", async () => {
    expect((await workspace.resolveMonitor(b.mon))?.workspace).toEqual({ id: B.id, clerk_org_id: B.clerk_org_id });
    expect((await workspace.resolveIncident(b.inc))?.workspace).toEqual({ id: B.id, clerk_org_id: B.clerk_org_id });
    expect((await workspace.resolvePage(b.page))?.workspace).toEqual({ id: B.id, clerk_org_id: B.clerk_org_id });
    expect((await workspace.resolveApp(b.app))?.workspace).toEqual({ id: B.id, clerk_org_id: B.clerk_org_id });
    expect(await workspace.resolveMonitor(`mon_${hex(12)}`)).toBeNull();
  });

  it("rotateHeartbeat retires the old token: each rotation stores the new URL's hash and copy, and nothing finds the old one", async () => {
    const hashOf = (url: string) => createHash("sha256").update(new URL(url).pathname.slice(1)).digest("hex");
    const stored = async () => (await db.from("monitors").select("heartbeat_token_hash").eq("id", a.hb).single()).data!.heartbeat_token_hash;
    expect(await stored()).toBe(hashOf(a.hbUrl));
    const first = await as(callerA, () => actions.rotateHeartbeat(a.hb));
    if (!first.ok) throw new Error(first.reason);
    expect(await stored()).toBe(hashOf(first.heartbeatUrl));
    expect(await workspace.heartbeatUrlOf(memberOf(callerA, A), a.hb)).toBe(first.heartbeatUrl);
    const second = await as(callerA, () => actions.rotateHeartbeat(a.hb));
    if (!second.ok) throw new Error(second.reason);
    expect(await stored()).toBe(hashOf(second.heartbeatUrl));
    expect(await workspace.heartbeatUrlOf(memberOf(callerA, A), a.hb)).toBe(second.heartbeatUrl);
    for (const old of [a.hbUrl, first.heartbeatUrl]) {
      expect((await db.from("monitors").select("id").eq("heartbeat_token_hash", hashOf(old))).data).toEqual([]);
    }
    expect(new Set([a.hbUrl, first.heartbeatUrl, second.heartbeatUrl]).size).toBe(3);
  });

  it("deleteNote deletes a draft once and never a published update", async () => {
    const draft = await as(callerB, () => actions.saveNote(b.inc, { noteId: null, state: "monitoring", text: "B's draft to delete", publish: false }));
    if (!draft.ok) throw new Error(draft.reason);
    expect(await as(callerB, () => actions.deleteNote(b.inc, draft.id))).toEqual({ ok: true });
    expect(await as(callerB, () => actions.deleteNote(b.inc, draft.id))).toEqual(NOT_FOUND);
    expect(await as(callerB, () => actions.deleteNote(b.inc, b.published))).toEqual(NOT_FOUND);
    expect((await db.from("incident_notes").select("id, status").eq("id", b.published).single()).data).toEqual({ id: b.published, status: "published" });
  });

  it("ackIncident acknowledges once through the action", async () => {
    expect(await as(callerA, () => actions.ackIncident(a.inc))).toEqual({ ok: true });
    const first = (await db.from("incidents").select("acked_at, timeline").eq("id", a.inc).single()).data!;
    expect(await as(callerA, () => actions.ackIncident(a.inc))).toEqual({ ok: true });
    expect((await db.from("incidents").select("acked_at, timeline").eq("id", a.inc).single()).data).toEqual(first);
    expect(first.timeline).toHaveLength(1);
  });

  // As after leaving the Builder simulation: the stored page keeps choices Free doesn't unlock.
  it("savePage on Free still saves a page left without the mark and unlisted, and puts the mark back", async () => {
    await db.from("status_pages").update({ powered_by: false, noindex: true }).eq("id", a.page);
    const draft = { ...pageDraft(`itest-${hex(6)}`, [a.hb]), poweredBy: false, noindex: true };
    expect(await as(callerA, () => actions.savePage(a.page, draft))).toEqual({ ok: true });
    expect((await db.from("status_pages").select("powered_by, noindex").eq("id", a.page).single()).data).toEqual({ powered_by: true, noindex: false });
  });

  // Free has one status page, so this frees A's for the app test below.
  it("deletePage deletes A's page once, and its components with it", async () => {
    expect(await as(callerA, () => actions.savePage(a.page, pageDraft(`itest-${hex(6)}`, [a.hb])))).toEqual({ ok: true });
    expect((await db.from("page_components").select("id").eq("page_id", a.page)).data).toHaveLength(1);
    expect(await as(callerA, () => actions.deletePage(a.page))).toEqual({ ok: true });
    expect(await as(callerA, () => actions.deletePage(a.page))).toEqual(NOT_FOUND);
    expect((await db.from("status_pages").select("id").eq("id", a.page)).data).toEqual([]);
    expect((await db.from("page_components").select("id").eq("page_id", a.page)).data).toEqual([]);
  });

  it("deleteApp takes the app's monitors, page and incidents, and hands a shared host's SSL monitor to the app still watching it", async () => {
    const host = `itest-${hex(4)}.example.com`;
    const draft = (appId: string) => ({ ...httpDraft(appId), url: `https://${host}/health` });
    const ids = await as(callerA, async () => {
      const first = await actions.addApp({ name: `itest A first ${hex(3)}`, url: "" });
      const second = await actions.addApp({ name: `itest A second ${hex(3)}`, url: "" });
      if (!first.ok || !second.ok) throw new Error("addApp");
      const m1 = await actions.addMonitor(draft(first.id));
      const m2 = await actions.addMonitor(draft(second.id));
      const pg = await actions.addPage(first.id);
      for (const r of [m1, m2, pg]) if (!r.ok) throw new Error(r.reason);
      if (!m1.ok || !m2.ok || !pg.ok) throw new Error("unreachable");
      return { first: first.id, second: second.id, m1: m1.id, m2: m2.id, page: pg.id };
    });
    const inc = (await fx.incident(A.id, ids.m1)).id;
    const ssl = async () => (await db.from("monitors").select("id, app_id").eq("workspace_id", A.id).eq("type", "ssl").eq("auto", true).eq("target_host", host)).data;
    const [auto] = (await ssl())!;
    expect(auto.app_id).toBe(ids.first);

    expect(await as(callerA, () => actions.deleteApp(ids.first))).toEqual({ ok: true });
    expect((await db.from("apps").select("id").eq("id", ids.first)).data).toEqual([]);
    expect((await db.from("monitors").select("id").eq("app_id", ids.first)).data).toEqual([]);
    expect((await db.from("status_pages").select("id").eq("id", ids.page)).data).toEqual([]);
    expect((await db.from("incidents").select("id").eq("id", inc)).data).toEqual([]);
    // The same SSL monitor, its history kept, now under the app that still watches the host.
    expect(await ssl()).toEqual([{ id: auto.id, app_id: ids.second }]);
    expect(await as(callerA, () => actions.deleteApp(ids.first))).toEqual(NOT_FOUND);

    // The last app on the host takes the SSL monitor with it.
    expect(await as(callerA, () => actions.deleteApp(ids.second))).toEqual({ ok: true });
    expect(await ssl()).toEqual([]);
  });

  it("deleteApp takes another app's SSL monitor when its own HTTP monitors were the last on the host", async () => {
    const [h, h2] = [`itest-${hex(4)}.example.com`, `itest-${hex(4)}.example.com`];
    const at = (appId: string, host: string) => ({ ...httpDraft(appId), url: `https://${host}/health` });
    const ids = await as(callerA, async () => {
      const x = await actions.addApp({ name: `itest A owner ${hex(3)}`, url: "" });
      const y = await actions.addApp({ name: `itest A last ${hex(3)}`, url: "" });
      if (!x.ok || !y.ok) throw new Error("addApp");
      const m1 = await actions.addMonitor(at(x.id, h));
      const m2 = await actions.addMonitor(at(y.id, h));
      if (!m1.ok || !m2.ok) throw new Error("addMonitor");
      // X's monitor moves away; the SSL monitor on h stays X's while Y still watches h.
      const moved = await actions.updateMonitor(m1.id, at(x.id, h2));
      if (!moved.ok) throw new Error(moved.reason);
      return { x: x.id, y: y.id };
    });
    const ssl = async (host: string) => (await db.from("monitors").select("app_id").eq("workspace_id", A.id).eq("type", "ssl").eq("auto", true).eq("target_host", host)).data;
    expect(await ssl(h)).toEqual([{ app_id: ids.x }]);

    expect(await as(callerA, () => actions.deleteApp(ids.y))).toEqual({ ok: true });
    expect(await ssl(h)).toEqual([]);
    expect(await ssl(h2)).toEqual([{ app_id: ids.x }]);
  });

  it("updateMonitor closes the monitor's open incident when its address changes, and not on a rename", async () => {
    const [x, y] = [`itest-${hex(4)}.example.com`, `itest-${hex(4)}.example.com`];
    const app = await as(callerA, () => actions.addApp({ name: `itest A incident ${hex(3)}`, url: "" }));
    if (!app.ok) throw new Error(app.reason);
    const draft = { ...httpDraft(app.id), url: `https://${x}/health` };
    const made = await as(callerA, () => actions.addMonitor(draft));
    if (!made.ok) throw new Error(made.reason);
    // Down, with an incident open, as the probe writes them.
    await db.from("monitors").update({ state: "down", state_since: new Date().toISOString() }).eq("id", made.id);
    const inc = (await db.from("incidents").insert({ workspace_id: A.id, monitor_id: made.id, title: "itest is down", severity: "down" }).select("id").single()).data!;
    const incident = async () => (await db.from("incidents").select("resolved_at, timeline").eq("id", inc.id).single()).data!;

    expect(await as(callerA, () => actions.updateMonitor(made.id, { ...draft, name: "Renamed" }))).toEqual({ ok: true });
    expect((await incident()).resolved_at).toBeNull();

    // The incident is about an address nobody checks any more; the new one starts with no state.
    expect(await as(callerA, () => actions.updateMonitor(made.id, { ...draft, name: "Renamed", url: `https://${y}/health` }))).toEqual({ ok: true });
    const closed = await incident();
    expect(closed.resolved_at).not.toBeNull();
    expect(closed.timeline.at(-1).text).toBe("Address changed, incident closed");
    expect((await db.from("monitors").select("state").eq("id", made.id).single()).data).toEqual({ state: null });
  });

  it("updateMonitor changes what a monitor checks, keeps a stored header, and moves the SSL monitor with the host", async () => {
    const [x, y] = [`itest-${hex(4)}.example.com`, `itest-${hex(4)}.example.com`];
    const app = await as(callerA, () => actions.addApp({ name: `itest A edit ${hex(3)}`, url: "" }));
    if (!app.ok) throw new Error(app.reason);
    const draft = { ...httpDraft(app.id), url: `https://${x}/health`, headers: [{ name: "Authorization", value: "Bearer one" }] };
    const made = await as(callerA, () => actions.addMonitor(draft));
    if (!made.ok) throw new Error(made.reason);
    const id = made.id;
    const secrets = async () => (await db.from("monitor_secrets").select("name, sealed").eq("monitor_id", id).order("name")).data!;
    const autoSsl = async () => (await db.from("monitors").select("target_host, app_id").eq("workspace_id", A.id).eq("type", "ssl").eq("auto", true).in("target_host", [x, y])).data;
    const [kept] = await secrets();
    expect(await autoSsl()).toEqual([{ target_host: x, app_id: app.id }]);

    // A stored header sent back empty keeps its sealed value at its own address; a new one is
    // sealed for this monitor.
    const samePlace = { ...draft, name: "Renamed", headers: [{ name: "Authorization", value: "" }, { name: "X-Key", value: "two" }] };
    expect(await as(callerA, () => actions.updateMonitor(id, samePlace))).toEqual({ ok: true });
    expect((await secrets())[0].sealed).toBe(kept.sealed);

    // At any other address, another path on the same site included, a kept value would go
    // somewhere it was never typed for, so it is asked for again, and nothing changes until it is.
    const reason = "Type Authorization again: a kept value is only sent to the address it was saved for.";
    expect(await as(callerA, () => actions.updateMonitor(id, { ...samePlace, url: `https://${x}/v2` }))).toEqual({ ok: false, reason, fieldErrors: { headers: reason } });
    const moved = { ...samePlace, url: `https://${y}/v2` };
    expect(await as(callerA, () => actions.updateMonitor(id, moved))).toEqual({ ok: false, reason, fieldErrors: { headers: reason } });
    expect((await db.from("monitors").select("target").eq("id", id).single()).data).toEqual({ target: `https://${x}/health` });
    const edited = { ...moved, headers: [{ name: "Authorization", value: "Bearer one" }, { name: "X-Key", value: "two" }] };
    expect(await as(callerA, () => actions.updateMonitor(id, edited))).toEqual({ ok: true });
    const row = (await db.from("monitors").select("type, app_id, name, target, target_host, state").eq("id", id).single()).data;
    expect(row).toEqual({ type: "http", app_id: app.id, name: "Renamed", target: `https://${y}/v2`, target_host: y, state: null });
    const now = await secrets();
    expect(now.map((s) => s.name)).toEqual(["Authorization", "X-Key"]);
    expect(now[0].sealed).not.toBe(kept.sealed);
    expect(await autoSsl()).toEqual([{ target_host: y, app_id: app.id }]);

    // An empty value for a header that isn't stored is refused, and so is a new type.
    const blank = await as(callerA, () => actions.updateMonitor(id, { ...edited, headers: [{ name: "X-New", value: "" }] }));
    expect(blank).toMatchObject({ ok: false, fieldErrors: { headers: "Enter a value for X-New, on one line." } });
    expect((await as(callerA, () => actions.updateMonitor(id, heartbeatDraft(app.id)))).ok).toBe(false);
    expect((await db.from("monitors").select("type").eq("id", id).single()).data).toEqual({ type: "http" });

    // The automatic SSL monitor changes with its HTTP monitor, never on its own.
    const ssl = (await db.from("monitors").select("id").eq("workspace_id", A.id).eq("auto", true).eq("target_host", y).single()).data!;
    expect(await as(callerA, () => actions.updateMonitor(ssl.id, { type: "ssl", appId: app.id, name: "", host: y }))).toEqual({
      ok: false,
      reason: "Staygreen added this monitor with an HTTPS monitor, and it changes with that one.",
    });

    // Removing every header removes them all.
    expect(await as(callerA, () => actions.updateMonitor(id, { ...edited, headers: [] }))).toEqual({ ok: true });
    expect(await secrets()).toEqual([]);
  });

  it("updateMonitor counts the per-host limit when the host changes, and never against the monitor itself", async () => {
    const full = `itest-${hex(4)}.example.com`;
    const app = await as(callerA, () => actions.addApp({ name: `itest A hosts ${hex(3)}`, url: "" }));
    if (!app.ok) throw new Error(app.reason);
    const at = (host: string, path = "health") => ({ ...httpDraft(app.id), url: `https://${host}/${path}` });
    const onFull: string[] = [];
    for (let i = 0; i < (FREE.limits.perHost as number); i++) {
      const r = await as(callerA, () => actions.addMonitor(at(full, `p${i}`)));
      if (!r.ok) throw new Error(r.reason);
      onFull.push(r.id);
    }
    const other = await as(callerA, () => actions.addMonitor(at(`itest-${hex(4)}.example.com`)));
    if (!other.ok) throw new Error(other.reason);

    const moved = await as(callerA, () => actions.updateMonitor(other.id, at(full, "moved")));
    expect(moved).toEqual({ ok: false, reason: `Free allows ${FREE.limits.perHost} monitors per host, and ${full} has ${FREE.limits.perHost}.` });
    expect(await as(callerA, () => actions.updateMonitor(onFull[0], { ...at(full, "renamed"), name: "Still here" }))).toEqual({ ok: true });
    expect((await db.from("monitors").select("name").eq("id", onFull[0]).single()).data).toEqual({ name: "Still here" });
  });

  it("refuses a signed-out caller before anything is read", async () => {
    caller = null;
    expect(await actions.deleteMonitor(a.hb)).toEqual({ ok: false, reason: "Your session has ended. Sign in again to keep going." });
    expect((await db.from("monitors").select("id").eq("id", a.hb)).data).toEqual([{ id: a.hb }]);
  });
});
