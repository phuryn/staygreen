import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Caller } from "@/lib/authz";
import { FREE } from "@/lib/plans";
import { clientFor, describeTarget, Fixtures, hex, readTarget, testUserId } from "../support/integration";
import { imageBytes, imageForm, png as pngImage, pngChunks, SECRET, secretPngChunks } from "../support/page-assets";

/* A status page's logo and favicon (`spec.md § 6`), through the product's own Server
   Actions, the public snapshot and the image route, on the real database. What the unit
   tests can't show: the bytes land in `page_assets` and nowhere else, only the pixels of
   them, what a client that skipped the picker sends writes nothing, a replacement retires
   the old address, removing or deleting the page leaves nothing behind, another workspace's
   member writes nothing, and the table refuses what the action would, on its own.

   Faked, as in `actions.test.ts`: the caller (the verifier) and the request headers a
   same-origin browser sends. */

vi.mock("next/headers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/headers")>();
  return { ...actual, headers: async () => new Headers({ "sec-fetch-site": "same-origin", host: "localhost" }) };
});

const target = readTarget();
const NOT_FOUND = { ok: false, reason: "That isn't here any more. Reload the page." };
const UNPREPARED = { ok: false, reason: "This image wasn't resized for the page. Reload the editor and choose it again." };
const PATH = /^\/page-assets\/(asset_[0-9a-f]{32})$/;

describeTarget("page assets: uploaded, served, replaced and removed, and only by the page's own workspace", target, (t) => {
  const db = clientFor(t.url, t.secretKey);
  const fx = new Fixtures(db);
  let actions: typeof import("@/app/(app)/app/actions");
  let route: typeof import("@/app/page-assets/[id]/route");

  let caller: Caller | null = null;
  let callerA: Caller, callerB: Caller;
  let A: { id: string; clerk_org_id: string };
  let page: { id: string; slug: string };

  const as = async <T>(who: Caller, run: () => Promise<T>): Promise<T> => {
    caller = who;
    try {
      return await run();
    } finally {
      caller = null;
    }
  };
  const rows = async () => {
    const r = await db.from("page_assets").select("id, kind, mime, workspace_id").eq("page_id", page.id).order("kind");
    if (r.error) throw new Error(r.error.message);
    return r.data;
  };
  const snapshot = async () => {
    const r = await db.rpc("public_status_snapshot", { p_slug: page.slug });
    if (r.error) throw new Error(r.error.message);
    return r.data as { page: Record<string, unknown> };
  };
  const serve = (id: string) => route.GET(new Request(`http://localhost/page-assets/${id}`), { params: Promise.resolve({ id }) });
  const idOf = (url: string) => PATH.exec(url)?.[1] ?? "";

  beforeAll(async () => {
    const session = await import("@/lib/session");
    actions = await import("@/app/(app)/app/actions");
    route = await import("@/app/page-assets/[id]/route");
    session.setSessionVerifier({ current: async () => caller, entitlements: async () => FREE });

    A = await fx.workspace();
    const B = await fx.workspace();
    callerA = { userId: testUserId(), orgId: A.clerk_org_id, orgRole: "org:admin" };
    callerB = { userId: testUserId(), orgId: B.clerk_org_id, orgRole: "org:admin" };
    await as(callerA, async () => {
      const app = await actions.addApp({ name: `itest assets ${hex(3)}`, url: "" });
      if (!app.ok) throw new Error(`addApp: ${app.reason}`);
      const added = await actions.addPage(app.id);
      if (!added.ok) throw new Error(`addPage: ${added.reason}`);
      const r = await db.from("status_pages").select("id, slug").eq("id", added.id).single();
      if (r.error) throw new Error(r.error.message);
      page = r.data;
    });
  });

  afterAll(async () => {
    await fx.cleanup();
  });

  it("stores an upload's pixels, carries its address in the snapshot, and serves exactly what it stored", async () => {
    const logo = await as(callerA, () => actions.uploadPageAsset(page.id, "logo", imageForm(imageBytes("png"), "logo.html", "text/html")));
    expect(logo).toMatchObject({ ok: true, url: expect.stringMatching(PATH) });
    const url = logo.ok ? logo.url : "";
    expect(await rows()).toEqual([{ id: idOf(url), kind: "logo", mime: "image/png", workspace_id: A.id }]);

    const snap = await snapshot();
    expect(snap.page).toMatchObject({ logoUrl: url, faviconUrl: null });
    // The snapshot carries the address, never the bytes.
    expect(JSON.stringify(snap)).not.toContain(imageBytes("png").toString("hex").slice(0, 64));

    const res = await serve(idOf(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // The fixture less its density chunk, which follows the signature and IHDR.
    const png = imageBytes("png");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.concat([png.subarray(0, 33), png.subarray(54)]));
  });

  it("stores none of what a camera or an editor wrote beside the pixels", async () => {
    const sent = pngImage({ width: 200, height: 60, before: secretPngChunks() });
    const logo = await as(callerA, () => actions.uploadPageAsset(page.id, "logo", imageForm(sent)));
    expect(logo.ok).toBe(true);
    const r = await db.from("page_assets").select("content").eq("page_id", page.id).eq("kind", "logo").single();
    if (r.error) throw new Error(r.error.message);
    const stored = Buffer.from(String(r.data.content).slice(2), "hex");
    expect(pngChunks(stored)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(stored.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(Buffer.from(await (await serve(idOf(logo.ok ? logo.url : ""))).arrayBuffer())).toEqual(stored);
  });

  it("gives a replacement a new address and retires the old one", async () => {
    const [before] = await rows();
    const again = await as(callerA, () => actions.uploadPageAsset(page.id, "logo", imageForm(imageBytes("webp"), "logo.webp", "image/webp")));
    expect(again.ok).toBe(true);
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ kind: "logo", mime: "image/webp" });
    expect(after[0].id).not.toBe(before.id);
    expect((await serve(before.id)).status).toBe(404);
    expect((await serve(after[0].id)).status).toBe(200);
  });

  it("refuses what only a client that skipped the picker sends, and writes nothing", async () => {
    const before = await rows();
    for (const [kind, form] of [
      ["favicon", imageForm(imageBytes("ico"), "favicon.ico", "image/x-icon")],
      ["logo", imageForm(imageBytes("jpg"), "logo.jpg", "image/jpeg")],
      ["logo", imageForm(pngImage({ width: 1200, height: 400 }))],
      ["logo", imageForm(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "logo.svg", "image/svg+xml")],
    ] as const) {
      expect(await as(callerA, () => actions.uploadPageAsset(page.id, kind, form))).toEqual(UNPREPARED);
    }
    expect(await rows()).toEqual(before);
  });

  it("takes a PNG favicon, and the snapshot carries both", async () => {
    const fav = await as(callerA, () => actions.uploadPageAsset(page.id, "favicon", imageForm(pngImage({ width: 48, height: 48 }), "favicon.png", "image/png")));
    expect(fav.ok).toBe(true);
    expect((await rows()).map((r) => [r.kind, r.mime])).toEqual([["favicon", "image/png"], ["logo", "image/webp"]]);
    const snap = await snapshot();
    expect(snap.page.faviconUrl).toBe(fav.ok ? fav.url : "");
    expect(snap.page.logoUrl).toMatch(PATH);
  });

  it("refuses another workspace's member, and writes nothing", async () => {
    const before = await rows();
    expect(await as(callerB, () => actions.uploadPageAsset(page.id, "logo", imageForm()))).toEqual(NOT_FOUND);
    expect(await as(callerB, () => actions.removePageAsset(page.id, "favicon"))).toEqual(NOT_FOUND);
    expect(await rows()).toEqual(before);
  });

  it("refuses on its own what the action refuses: an SVG, an ICO logo, an oversized file, another workspace", async () => {
    const insert = (over: Record<string, unknown>) =>
      db.from("page_assets").insert({ id: `asset_${hex(16)}`, workspace_id: A.id, page_id: page.id, kind: "favicon", mime: "image/png", content: `\\x${imageBytes("png").toString("hex")}`, ...over });
    await db.from("page_assets").delete().eq("page_id", page.id).eq("kind", "favicon");
    expect((await insert({ mime: "image/svg+xml" })).error?.code).toBe("23514");
    expect((await insert({ kind: "logo", mime: "image/vnd.microsoft.icon" })).error?.code).toBe("23514");
    expect((await insert({ content: `\\x${"00".repeat(512 * 1024 + 1)}` })).error?.code).toBe("23514");
    const other = await fx.workspace();
    expect((await insert({ workspace_id: other.id })).error?.code).toBe("23503");
    expect((await rows()).map((r) => r.kind)).toEqual(["logo"]);
  });

  it("removes an image, and deleting the page removes the rest", async () => {
    expect(await as(callerA, () => actions.uploadPageAsset(page.id, "favicon", imageForm()))).toMatchObject({ ok: true });
    expect(await as(callerA, () => actions.removePageAsset(page.id, "logo"))).toEqual({ ok: true });
    expect((await rows()).map((r) => r.kind)).toEqual(["favicon"]);
    expect((await snapshot()).page).toMatchObject({ logoUrl: null, faviconUrl: expect.stringMatching(PATH) });

    const [left] = await rows();
    expect(await as(callerA, () => actions.deletePage(page.id))).toMatchObject({ ok: true });
    expect(await rows()).toEqual([]);
    expect((await serve(left.id)).status).toBe(404);
  });
});
