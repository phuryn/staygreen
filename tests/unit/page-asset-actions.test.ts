import { beforeEach, describe, expect, it, vi } from "vitest";
import { FREE } from "@/lib/plans";
import { PAGE_ASSET_LIMIT } from "@/lib/page-assets";
import { imageBytes, imageForm, png, pngChunks, SECRET, secretPngChunks } from "../support/page-assets";
import { removePageAsset, uploadPageAsset } from "@/app/(app)/app/actions";

// Real action, permission check, byte validation and return sentences. Fake identity and DB;
// integration/page-assets.test.ts covers the same actions on the development database.
const fake = vi.hoisted(() => ({ member: vi.fn(), resolve: vi.fn(), upsert: vi.fn(), remove: vi.fn(), origin: vi.fn() }));
vi.mock("@/lib/workspace", async (original) => ({
  ...await original<typeof import("@/lib/workspace")>(), memberOrNull: fake.member, resolvePage: fake.resolve,
}));
vi.mock("@/lib/request", async (original) => ({ ...await original<typeof import("@/lib/request")>(), assertSameOrigin: fake.origin }));
vi.mock("@/lib/db", () => ({ db: () => ({ from: () => ({ upsert: fake.upsert, delete: () => ({ eq: () => ({ eq: () => ({ eq: fake.remove }) }) }) }) }) }));

const ws = { id: "ws_a", clerk_org_id: "org_a" };
const admin = { caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" }, workspace: ws, entitlements: FREE };
const missing = { ok: false, reason: "That isn't here any more. Reload the page." };
beforeEach(() => {
  vi.clearAllMocks();
  fake.member.mockResolvedValue(admin);
  fake.resolve.mockResolvedValue({ id: "page_a", workspace: ws });
  fake.upsert.mockResolvedValue({ error: null });
  fake.remove.mockResolvedValue({ error: null });
  fake.origin.mockResolvedValue(undefined);
});

const UNPREPARED = { ok: false, reason: "This image wasn't resized for the page. Reload the editor and choose it again." };
const stored = () => fake.upsert.mock.calls[0][0] as { mime: string; content: string };

describe("uploadPageAsset", () => {
  it("ignores the name and MIME, stores the pixels, and generates a fresh unguessable address", async () => {
    const result = await uploadPageAsset("page_a", "logo", imageForm(imageBytes("png"), "attack.html", "text/html"));
    expect(result).toMatchObject({ ok: true, url: expect.stringMatching(/^\/page-assets\/asset_[0-9a-f]{32}$/) });
    // The fixture less its 21-byte density chunk, which follows the signature and IHDR.
    const fixture = imageBytes("png");
    expect(pngChunks(fixture)).toEqual(["IHDR", "pHYs", "IDAT", "IEND"]);
    const pixels = Buffer.concat([fixture.subarray(0, 33), fixture.subarray(54)]);
    expect(pngChunks(pixels)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(fake.upsert).toHaveBeenCalledWith(expect.objectContaining({
      page_id: "page_a", workspace_id: "ws_a", kind: "logo", mime: "image/png", content: `\\x${pixels.toString("hex")}`,
    }), { onConflict: "page_id,kind" });
    expect(await uploadPageAsset("page_a", "logo", imageForm())).not.toEqual(result);
  });
  it("stores none of what a camera or an editor wrote beside the pixels", async () => {
    const sent = png({ width: 120, height: 40, before: secretPngChunks() });
    expect(await uploadPageAsset("page_a", "logo", imageForm(sent))).toMatchObject({ ok: true });
    const content = Buffer.from(stored().content.slice(2), "hex");
    expect(content.includes(Buffer.from(SECRET, "latin1"))).toBe(false);
    expect(pngChunks(content)).toEqual(["IHDR", "IDAT", "IEND"]);
  });
  it.each([
    ["an SVG", Buffer.from("<svg></svg>"), UNPREPARED],
    ["renamed HTML", Buffer.from("<!doctype html><script>alert(1)</script>"), { ok: false, reason: "This file isn't a PNG, JPEG, WebP or SVG image." }],
    ["a JPEG", imageBytes("jpg"), UNPREPARED],
    ["an image larger than the logo's box", png({ width: 1000, height: 200 }), UNPREPARED],
  ])("refuses %s sent straight to the server, without writing", async (_, bytes, refusal) => {
    expect(await uploadPageAsset("page_a", "logo", imageForm(bytes, "logo.png", "image/png"))).toEqual(refusal);
    expect(fake.upsert).not.toHaveBeenCalled();
  });
  it("refuses an ICO straight to the server: the picker makes every favicon a PNG", async () => {
    expect(await uploadPageAsset("page_a", "favicon", imageForm(imageBytes("ico"), "favicon.ico", "image/x-icon"))).toEqual(UNPREPARED);
    expect(fake.upsert).not.toHaveBeenCalled();
  });
  it("refuses a file over 512 KB, what the table holds, without reading it", async () => {
    expect(await uploadPageAsset("page_a", "logo", imageForm(new Uint8Array(PAGE_ASSET_LIMIT + 1)))).toEqual(UNPREPARED);
    expect(fake.upsert).not.toHaveBeenCalled();
  });
  it.each(["logo", "favicon"])("refuses a foreign page's %s upload and removal with the missing-page sentence", async (kind) => {
    fake.resolve.mockResolvedValue({ id: "page_b", workspace: { id: "ws_b", clerk_org_id: "org_b" } });
    expect(await uploadPageAsset("page_b", kind, imageForm())).toEqual(missing);
    expect(await removePageAsset("page_b", kind)).toEqual(missing);
    expect(fake.upsert).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
  });
  it("refuses a resolved member without pages:manage", async () => {
    fake.member.mockResolvedValue({ ...admin, caller: { ...admin.caller, orgRole: "org:member" } });
    expect(await uploadPageAsset("page_a", "logo", imageForm())).toEqual(missing);
    expect(await removePageAsset("page_a", "logo")).toEqual(missing);
    expect(fake.upsert).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
  });
  it("requires a session and same-origin mutation", async () => {
    fake.member.mockResolvedValue(null);
    expect(await uploadPageAsset("page_a", "logo", imageForm())).toMatchObject({ ok: false, reason: expect.stringContaining("Sign in") });
    const { CrossOrigin } = await import("@/lib/request");
    fake.origin.mockRejectedValue(new CrossOrigin());
    expect(await uploadPageAsset("page_a", "logo", imageForm())).toEqual({ ok: false, reason: "This request didn't come from Staygreen, so it was refused." });
    expect(fake.upsert).not.toHaveBeenCalled();
  });
  it("refuses an invalid slot and a missing or multiple file value", async () => {
    expect(await uploadPageAsset("page_a", "background", imageForm())).toEqual({ ok: false, reason: "Choose a logo or a favicon." });
    expect(await uploadPageAsset("page_a", "logo", new FormData())).toEqual({ ok: false, reason: "Choose an image to upload." });
    const form = imageForm(); form.append("file", new Blob(["another"]));
    expect(await uploadPageAsset("page_a", "logo", form)).toEqual({ ok: false, reason: "Choose an image to upload." });
    expect(fake.upsert).not.toHaveBeenCalled();
  });
  it("returns a deletion race as missing, without a second write", async () => {
    fake.upsert.mockResolvedValue({ error: { code: "23503" } });
    expect(await uploadPageAsset("page_a", "logo", imageForm())).toEqual(missing);
    expect(fake.upsert).toHaveBeenCalledTimes(1);
  });
});
