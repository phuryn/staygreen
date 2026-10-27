import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadStatusIncident, loadStatusPage } from "@/lib/status-access";
import { GET as ask } from "@/app/api/edge/ask/route";

const fake = vi.hoisted(() => ({ rpc: vi.fn(), caller: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => ({ rpc: fake.rpc }) }));
vi.mock("@/lib/session", () => ({ currentCaller: fake.caller }));
vi.mock("next/navigation", () => ({ notFound: () => { throw Error("404"); }, redirect: (url: string) => { throw Error(url); } }));
const raw = { page: { slug: "harbor", name: "Secret workspace name", logoText: "Harbor", homepage: null, accent: "#1F2DE6", theme: "visitor", poweredBy: true, noindex: false, historyDays: 90 }, components: [], incidents: [] };
const access = { id: "page_a", slug: "harbor", workspaceId: "ws_a", orgId: "org_a" };
beforeEach(() => { vi.clearAllMocks(); fake.rpc.mockResolvedValue({ data: null, error: null }); fake.caller.mockResolvedValue(null); });
function privatePage() { fake.rpc.mockImplementation(async (name: string) => ({ data: name === "status_page_access" ? access : name === "status_page_snapshot" ? raw : null, error: null })); }

describe("status access before content and metadata", () => {
  it("never reads a session for public or missing pages", async () => {
    fake.rpc.mockResolvedValueOnce({ data: raw, error: null });
    expect((await loadStatusPage("harbor"))?.membersOnly).toBe(false);
    expect(await loadStatusPage("missing")).toBeNull();
    expect(fake.caller).not.toHaveBeenCalled();
  });
  it("sends a signed-out private visitor to sign-in and back before reading private content", async () => {
    privatePage();
    await expect(loadStatusPage("harbor")).rejects.toThrow("/sign-in?redirect_url=%2Fs%2Fharbor");
    expect(fake.rpc.mock.calls.map(c => c[0])).not.toContain("status_page_snapshot");
  });
  it("returns the same 404 for a foreign member and an unrecognized role", async () => {
    privatePage();
    for (const caller of [{ userId: "user_b", orgId: "org_b", orgRole: "org:admin" }, { userId: "user_a", orgId: "org_a", orgRole: "org:unknown" }]) {
      fake.caller.mockResolvedValue(caller);
      await expect(loadStatusPage("harbor")).rejects.toThrow("404");
    }
    expect(fake.rpc.mock.calls.map(c => c[0])).not.toContain("status_page_snapshot");
  });
  it("admits the owning member on the page and published incident only after authorization", async () => {
    privatePage(); fake.caller.mockResolvedValue({ userId: "user_a", orgId: "org_a", orgRole: "org:admin" });
    expect((await loadStatusPage("harbor"))?.view.page.name).toBe("Secret workspace name");
    expect(await loadStatusIncident("inc_0123456789abcdef01234567")).toMatchObject({ incidentId: "inc_0123456789abcdef01234567" });
    expect(fake.rpc).toHaveBeenCalledWith("status_page_snapshot", { p_slug: "harbor", p_workspace_id: "ws_a" });
  });
});
describe("Caddy permission endpoint", () => {
  it("accepts only a verified public domain and fails closed on errors", async () => {
    for (const [data, error, status] of [[true, null, 200], [false, null, 403], [true, { code: "42501" }, 403]] as const) {
      fake.rpc.mockResolvedValue({ data, error });
      const result = await ask(new Request("https://staygreen.io/api/edge/ask?domain=status.example.com"));
      expect(result.status).toBe(status); expect(result.headers.get("cache-control")).toBe("no-store");
    }
    fake.rpc.mockRejectedValue(Error("secret error"));
    expect((await ask(new Request("https://staygreen.io/api/edge/ask?domain=status.example.com"))).status).toBe(503);
    expect(fake.caller).not.toHaveBeenCalled();
  });
});
