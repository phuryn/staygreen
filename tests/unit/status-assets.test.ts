import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/page-assets/[id]/route";
import { imageBytes } from "../support/page-assets";

const fake = vi.hoisted(() => ({ row: vi.fn(), caller: vi.fn(), resolve: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => ({ from: (table: string) => {
  const q = { select: () => q, eq: () => q, maybeSingle: () => fake.row(table) }; return q;
} }) }));
vi.mock("@/lib/session", () => ({ currentCaller: fake.caller }));
vi.mock("@/lib/workspace", () => ({ resolvePage: fake.resolve }));
const asset = { page_id: "page_a", content: `\\x${imageBytes("png").toString("hex")}`, mime: "image/png" };
const get = () => GET(new Request("https://staygreen.io/page-assets/test"), { params: Promise.resolve({ id: `asset_${"a".repeat(32)}` }) });
function rows(members_only: boolean, edge_withdrawn = false) {
  fake.row.mockImplementation(async (table: string) => ({ data: table === "page_assets" ? asset : { members_only, edge_withdrawn }, error: null }));
}
beforeEach(() => {
  vi.clearAllMocks(); fake.caller.mockResolvedValue(null);
  fake.resolve.mockResolvedValue({ workspace: { id: "ws_a", clerk_org_id: "org_a" } });
});
describe("private status page images", () => {
  it("serves a public image without reading a session and without a reusable browser cache", async () => {
    rows(false); const response = await get();
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fake.caller).not.toHaveBeenCalled();
  });
  it.each([[true, false], [false, true]])("denies both private and withdrawn images before returning bytes (%s, %s)", async (privatePage, withdrawn) => {
    rows(privatePage, withdrawn);
    for (const caller of [null, { userId: "foreign", orgId: "org_b", orgRole: "org:admin" }]) {
      fake.caller.mockResolvedValue(caller); const response = await get();
      expect(response.status).toBe(404); expect(await response.text()).toBe("");
    }
    fake.caller.mockResolvedValue({ userId: "member", orgId: "org_a", orgRole: "org:admin" });
    const response = await get(); expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(imageBytes("png"));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
