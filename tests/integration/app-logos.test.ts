import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Caller } from "@/lib/authz";
import { FREE } from "@/lib/plans";
import { clientFor, describeTarget, Fixtures, hex, readTarget, testUserId } from "../support/integration";
import { imageBytes, imageForm, png as pngImage } from "../support/page-assets";

/* An app's logo and its address (`docs/flows.md § Editing an app`), through the product's own
   Server Actions, the snapshot and the image route, on the real database: the logo lands in
   `app_logos` and is served by the status page images' route, the import of a site's icon never
   replaces a logo already there, a replacement retires the old address, deleting the app takes
   the logo, another workspace's member writes nothing, and the table refuses on its own what the
   action would. Faked, as in `actions.test.ts`: the caller and the same-origin request headers. */

vi.mock("next/headers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/headers")>();
  return { ...actual, headers: async () => new Headers({ "sec-fetch-site": "same-origin", host: "localhost" }) };
});

const target = readTarget();
const NOT_FOUND = { ok: false, reason: "That isn't here any more. Reload the page." };
const UNPREPARED = { ok: false, reason: "This image wasn't resized for the app. Reload Settings and choose it again." };
const PATH = /^\/page-assets\/(asset_[0-9a-f]{32})$/;

describeTarget("app logos: uploaded, imported, served, replaced and removed, and only by the app's own workspace", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);
  let actions: typeof import("@/app/(app)/app/actions");
  let workspace: typeof import("@/lib/workspace");
  let route: typeof import("@/app/page-assets/[id]/route");

  let caller: Caller | null = null;
  let callerA: Caller, callerB: Caller;
  let A: { id: string; clerk_org_id: string };
  let app = "";

  const as = async <T>(who: Caller, run: () => Promise<T>): Promise<T> => {
    caller = who;
    try {
      return await run();
    } finally {
      caller = null;
    }
  };
  const rows = async () => {
    const r = await db.from("app_logos").select("id, app_id, mime, workspace_id").eq("app_id", app);
    if (r.error) throw new Error(r.error.message);
    return r.data;
  };
  const serve = (id: string) => route.GET(new Request(`http://localhost/page-assets/${id}`), { params: Promise.resolve({ id }) });
  const idOf = (url: string | null) => PATH.exec(url ?? "")?.[1] ?? "";
  const snapshotApp = async () => {
    const snap = await workspace.loadSnapshot({ caller: callerA, workspace: A, entitlements: FREE });
    return snap.apps.find((a) => a.id === app);
  };

  beforeAll(async () => {
    const session = await import("@/lib/session");
    actions = await import("@/app/(app)/app/actions");
    workspace = await import("@/lib/workspace");
    route = await import("@/app/page-assets/[id]/route");
    session.setSessionVerifier({ current: async () => caller, entitlements: async () => FREE });

    A = await fx.workspace();
    const B = await fx.workspace();
    callerA = { userId: testUserId(), orgId: A.clerk_org_id, orgRole: "org:admin" };
    callerB = { userId: testUserId(), orgId: B.clerk_org_id, orgRole: "org:admin" };
    const added = await as(callerA, () => actions.addApp({ name: `itest logo ${hex(3)}`, url: "" }));
    if (!added.ok) throw new Error(`addApp: ${added.reason}`);
    app = added.id;
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("refuses Free's second app, and the first is still there", async () => {
    expect(await as(callerA, () => actions.addApp({ name: "itest second", url: "" }))).toEqual({
      ok: false,
      reason: "Free includes 1 app. Builder includes 10, each with its own monitors and status page.",
    });
    expect((await db.from("apps").select("id").eq("workspace_id", A.id)).data).toEqual([{ id: app }]);
  });

  it("stores a logo's pixels, carries its address in the snapshot, and serves exactly what it stored", async () => {
    const up = await as(callerA, () => actions.uploadAppLogo(app, imageForm(imageBytes("png"), "logo.html", "text/html")));
    expect(up).toMatchObject({ ok: true, url: expect.stringMatching(PATH) });
    const url = up.ok ? up.url : null;
    expect(await rows()).toEqual([{ id: idOf(url), app_id: app, mime: "image/png", workspace_id: A.id }]);
    expect((await snapshotApp())?.logoUrl).toBe(url);

    const res = await serve(idOf(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const png = imageBytes("png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.concat([png.subarray(0, 33), png.subarray(54)]));
  });

  it("never lets an imported icon replace a logo already there", async () => {
    const [before] = await rows();
    expect(await as(callerA, () => actions.uploadAppLogo(app, imageForm(imageBytes("webp"), "icon.webp", "image/webp"), { keep: true }))).toEqual({ ok: true, url: null });
    expect(await rows()).toEqual([before]);
  });

  it("gives a chosen replacement a new address and retires the old one", async () => {
    const [before] = await rows();
    const again = await as(callerA, () => actions.uploadAppLogo(app, imageForm(imageBytes("webp"), "logo.webp", "image/webp")));
    expect(again.ok).toBe(true);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ mime: "image/webp" });
    expect(after[0].id).not.toBe(before.id);
    expect((await serve(before.id)).status).toBe(404);
    expect((await serve(after[0].id)).status).toBe(200);
  });

  it("refuses what only a client that skipped the picker sends, and writes nothing", async () => {
    const before = await rows();
    for (const form of [
      imageForm(imageBytes("ico"), "icon.ico", "image/x-icon"),
      imageForm(imageBytes("jpg"), "logo.jpg", "image/jpeg"),
      imageForm(pngImage({ width: 97, height: 96 })),
      imageForm(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "logo.svg", "image/svg+xml"),
    ]) {
      expect(await as(callerA, () => actions.uploadAppLogo(app, form))).toEqual(UNPREPARED);
    }
    expect(await rows()).toEqual(before);
  });

  it("refuses another workspace's member, and writes nothing", async () => {
    const before = await rows();
    expect(await as(callerB, () => actions.uploadAppLogo(app, imageForm()))).toEqual(NOT_FOUND);
    expect(await as(callerB, () => actions.removeAppLogo(app))).toEqual(NOT_FOUND);
    expect(await as(callerB, () => actions.updateApp(app, { name: "B renames A", url: "" }))).toEqual(NOT_FOUND);
    expect(await rows()).toEqual(before);
  });

  it("refuses a non-raster MIME, an oversized file, or an app of another workspace", async () => {
    const insert = (over: Record<string, unknown>) =>
      db.from("app_logos").insert({ id: `asset_${hex(16)}`, workspace_id: A.id, app_id: app, mime: "image/png", content: `\\x${imageBytes("png").toString("hex")}`, ...over });
    await db.from("app_logos").delete().eq("app_id", app);
    // Legacy page JPEGs can now be copied into app logos; HTML/SVG still cannot be stored.
    expect((await insert({ mime: "image/svg+xml" })).error?.code).toBe("23514");
    expect((await insert({ content: `\\x${"00".repeat(512 * 1024 + 1)}` })).error?.code).toBe("23514");
    expect((await insert({ id: "asset_nope" })).error?.code).toBe("23514");
    const other = await fx.workspace();
    expect((await insert({ workspace_id: other.id })).error?.code).toBe("23503");
    expect(await rows()).toEqual([]);
  });

  it("imports an icon where the app has no logo", async () => {
    const r = await as(callerA, () => actions.uploadAppLogo(app, imageForm(), { keep: true }));
    expect(r).toMatchObject({ ok: true, url: expect.stringMatching(PATH) });
  });

  it("keeps a favicon copy beside the logo, and a new status page starts with both and the app's brand colour", async () => {
    const withCopy = (favicon: Buffer) => {
      const form = imageForm();
      form.set("favicon", new Blob([new Uint8Array(favicon)], { type: "image/png" }), "favicon.png");
      return form;
    };
    expect(await as(callerA, () => actions.uploadAppLogo(app, withCopy(pngImage({ width: 48, height: 48 }))))).toMatchObject({ ok: true });
    const stored = await db.from("app_logos").select("content, favicon_mime, favicon_content").eq("app_id", app).single();
    expect(stored.data).toMatchObject({ favicon_mime: "image/png", favicon_content: expect.stringMatching(/^\\x89504e47/) });
    // A copy the picker couldn't have made is refused with its logo, and nothing changes.
    expect(await as(callerA, () => actions.uploadAppLogo(app, withCopy(pngImage({ width: 96, height: 96 }))))).toEqual(UNPREPARED);
    expect((await db.from("app_logos").select("content, favicon_mime, favicon_content").eq("app_id", app).single()).data).toEqual(stored.data);

    // The suggestion run keeps the colour it found on the app (`suggestChecks`).
    expect((await db.from("apps").update({ accent: "#635bff" }).eq("id", app)).error).toBeNull();
    const page = await as(callerA, () => actions.addPage(app));
    if (!page.ok) throw new Error(`addPage: ${page.reason}`);
    expect((await db.from("status_pages").select("accent").eq("id", page.id).single()).data).toEqual({ accent: "#635bff" });
    const assets = await db.from("page_assets").select("kind, mime, content").eq("page_id", page.id).order("kind");
    expect(assets.data).toEqual([
      { kind: "favicon", mime: "image/png", content: stored.data!.favicon_content },
      { kind: "logo", mime: "image/png", content: stored.data!.content },
    ]);
    // They are the page's own from here: a new logo for the app leaves them as they are, and
    // without a copy of its own clears the app's old one.
    expect(await as(callerA, () => actions.uploadAppLogo(app, imageForm(imageBytes("webp"), "logo.webp", "image/webp")))).toMatchObject({ ok: true });
    expect((await db.from("app_logos").select("favicon_mime, favicon_content").eq("app_id", app).single()).data).toEqual({ favicon_mime: null, favicon_content: null });
    expect((await db.from("page_assets").select("kind").eq("page_id", page.id).order("kind")).data).toEqual([{ kind: "favicon" }, { kind: "logo" }]);
    expect(await as(callerA, () => actions.deletePage(page.id))).toEqual({ ok: true });
  });

  it("changes an app's name and address with the rules adding one has, and no monitor with them", async () => {
    expect(await as(callerA, () => actions.updateApp(app, { name: "  ", url: "ftp://example.com" }))).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String), url: expect.any(String) } });
    expect(await as(callerA, () => actions.updateApp(app, { name: " AFK Pilot ", url: "https://afkpilot.com/" }))).toEqual({ ok: true });
    expect((await db.from("apps").select("name, url").eq("id", app).single()).data).toEqual({ name: "AFK Pilot", url: "https://afkpilot.com/" });
    expect(await as(callerA, () => actions.updateApp(app, { name: "AFK Pilot", url: "" }))).toEqual({ ok: true });
    expect((await db.from("apps").select("url").eq("id", app).single()).data).toEqual({ url: null });
    expect((await db.from("monitors").select("id").eq("app_id", app)).data).toEqual([]);
  });

  it("removes the logo, and deleting the app takes a logo with it", async () => {
    expect(await as(callerA, () => actions.removeAppLogo(app))).toEqual({ ok: true });
    expect(await rows()).toEqual([]);
    expect((await snapshotApp())?.logoUrl).toBeNull();

    const up = await as(callerA, () => actions.uploadAppLogo(app, imageForm()));
    const id = idOf(up.ok ? up.url : null);
    expect(await as(callerA, () => actions.deleteApp(app))).toEqual({ ok: true });
    expect(await rows()).toEqual([]);
    expect((await serve(id)).status).toBe(404);
  });
});
