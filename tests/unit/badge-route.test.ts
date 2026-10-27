import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/(status)/s/[slug]/badge.svg/route";

/* The README badge's route, `/s/<slug>/badge.svg`. Like `public-data.test.ts`, the database is
   replaced at its own seam, `db()`, so what is real is everything the route does with what the
   snapshot function answers: the slug guard, the DTO, the badge and the response around it. The
   served file in a real browser, parsed as XML, is in `tests/e2e/public-pages.spec.ts`. */

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: () => ({ rpc }) }));

const snapshot = (poweredBy: boolean) => ({
  page: { slug: "harbor", name: "Harbor status", logoText: "Harbor", homepage: null, accent: "#1F2DE6", theme: "light", poweredBy, noindex: false, historyDays: 90 },
  components: [{ key: 0, name: "Website", inApp: false, states: ["down"], daily: [] }],
  incidents: [],
});

const get = (slug: string) => GET(new Request(`http://localhost:3101/s/${slug}/badge.svg`), { params: Promise.resolve({ slug }) });

beforeEach(() => {
  rpc.mockReset();
  vi.stubEnv("STATUS_EDGE_ENABLED", "off");
});
afterEach(() => vi.unstubAllEnvs());

describe("the badge route", () => {
  it("redirects the README badge to this environment's configured host", async () => {
    vi.stubEnv("STATUS_EDGE_ENABLED", "on"); vi.stubEnv("NEXT_PUBLIC_STATUS_HOST", "status-dev.example.com");
    rpc.mockResolvedValue({ data: snapshot(true), error: null });
    expect((await get("harbor")).headers.get("location")).toBe("https://status-dev.example.com/harbor/badge.svg");
  });
  it("serves the page's state as a standalone SVG, uncached at the app, sniffed by nobody", async () => {
    rpc.mockResolvedValue({ data: snapshot(true), error: null });
    const res = await get("harbor");
    expect(rpc).toHaveBeenCalledWith("public_status_snapshot", { p_slug: "harbor" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.text();
    expect(body).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(body).toContain("<title>Harbor status: outage</title>");
    expect(body).toContain(">Staygreen</text>");
  });

  it("shows only the page's own name when the page has no Powered by Staygreen", async () => {
    rpc.mockResolvedValue({ data: snapshot(false), error: null });
    const body = await (await get("harbor")).text();
    expect(body).toContain(">Harbor</text>");
    expect(body).not.toContain("Staygreen");
  });

  it("answers a slug no page has with the same 404 as the page, never cached", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const res = await get("no-such-page");
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });
  it("keeps the README URL after activation, but never redirects a private or withdrawn page", async () => {
    vi.stubEnv("STATUS_EDGE_ENABLED", "on");
    rpc.mockResolvedValueOnce({ data: snapshot(true), error: null });
    const publicBadge = await get("harbor");
    expect(publicBadge.status).toBe(307);
    expect(publicBadge.headers.get("location")).toBe("https://status.staygreen.io/harbor/badge.svg");
    expect(publicBadge.headers.get("cache-control")).toBe("no-store");
    rpc.mockResolvedValueOnce({ data: null, error: null });
    const privateBadge = await get("harbor");
    expect(privateBadge.status).toBe(404); expect(privateBadge.headers.has("location")).toBe(false);
  });

  it.each(["Harbor", "-x", "a_b", "a".repeat(41), "..", "x%2F..", ""])("answers the malformed slug %j as not found without a query", async (slug) => {
    const res = await get(slug);
    expect(res.status).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("fails like the page when the snapshot can't be read, rather than drawing a guess", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } });
    await expect(get("harbor")).rejects.toThrow(/public_status_snapshot.*57014/);
  });
});
