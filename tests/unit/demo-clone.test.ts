import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cloneDemo } from "@/app/(app)/app/clone/[slug]/actions";
import { uploadAppLogo } from "@/app/(app)/app/actions";
import ClonePage from "@/app/(app)/app/clone/[slug]/page";
import { CloneScreen } from "@/app/(app)/app/clone/[slug]/CloneScreen";
import { CloneReceipt } from "@/components/CloneReceipt";
import { AppLogo } from "@/components/AppLogo";
import { MonitorTable } from "@/components/MonitorTable";
import { loadDemoPreview } from "@/lib/demo-clone-data";
import { demoPreviewSchema, type CloneReceipt as Receipt } from "@/lib/demo-clone";
import { cloneReturnPath } from "@/lib/clone-return-path";
import SignIn from "@/app/(public)/sign-in/[[...sign-in]]/page";
import SignUp from "@/app/(public)/sign-up/[[...sign-up]]/page";
import { FREE, entitlementsFrom } from "@/lib/plans";
import { PERMISSIONS } from "@/lib/authz";
import { monitor, sim } from "./fixtures";
import { imageForm } from "../support/page-assets";

const fake = vi.hoisted(() => ({ member: vi.fn(), require: vi.fn(), snapshot: vi.fn(), rpc: vi.fn(), origin: vi.fn(), logoUpsert: vi.fn(), workspace: {} as unknown, receipt: null as unknown, organization: undefined as { name: string } | null | undefined }));
vi.mock("@/lib/db", () => ({ db: () => ({ rpc: fake.rpc, from: (table: string) => ({
  upsert: (row: unknown, options: unknown) => ({ select: () => fake.logoUpsert(table, row, options) }),
  select: () => ({ eq: async () => { expect(table).toBe("page_domains"); return { data: [], error: null }; } }),
}) }) }));
vi.mock("@/lib/request", async original => ({ ...await original<typeof import("@/lib/request")>(), assertSameOrigin: fake.origin }));
vi.mock("@/lib/workspace", async original => ({ ...await original<typeof import("@/lib/workspace")>(), memberOrNull: fake.member, requireMember: fake.require, loadSnapshot: fake.snapshot,
  resolveApp: async (id: string) => ({ id, workspace: { id: "ws_a", clerk_org_id: "org_a" } }) }));
vi.mock("@/lib/workspace-store", () => ({ useWorkspace: () => fake.workspace, useActs: () => ({}), useCloneReceipt: () => fake.receipt, useEagerPoll: vi.fn(), WorkspaceSnapshot: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), notFound: () => { throw new Error("404"); } }));
vi.mock("@clerk/nextjs", () => ({ useOrganization: () => ({ organization: fake.organization }), SignIn: (props: object) => createElement("pre", null, JSON.stringify(props)), SignUp: (props: object) => createElement("pre", null, JSON.stringify(props)) }));
vi.mock("@/components/Tags", () => ({ BuilderTag: () => createElement("span", null, "Builder offer") }));

const member = { caller: { userId: "user_a", orgId: "org_a", orgRole: "org:admin" }, workspace: { id: "ws_a", clerk_org_id: "org_a" }, entitlements: FREE };
const id = `app_${"a".repeat(24)}`, pageId = `page_${"b".repeat(24)}`;
const source = { app: { id: "SOURCE_APP", name: "Poteto", url: "https://poteto.example", accent: "#123456", logoUrl: `/page-assets/asset_${"c".repeat(32)}` }, page: { name: "Poteto status" },
  monitors: [{ id: "source_mon", name: "Website", type: "http", copyable: true, target: "https://poteto.example/health", config: { method: "HEAD" } },
    { name: "Supabase", type: "supabase", copyable: false, target: "NEVER_SEND_TARGET", config: { key: "NEVER_SEND_CONFIG" } }] };
const receipt: Receipt = { appId: id, pageId, copied: ["Website"], added: [], skipped: [{ name: "Supabase", reason: "needs_key" }, { name: "DNS", reason: "monitor_limit" }] };
beforeEach(() => {
  vi.clearAllMocks(); fake.origin.mockResolvedValue(undefined); fake.member.mockResolvedValue(member); fake.require.mockResolvedValue(member);
  fake.workspace = { ...sim(), loadedAt: 1, can: Object.fromEntries(PERMISSIONS.map(p => [p, true])), features: [] };
  fake.snapshot.mockResolvedValue(fake.workspace); fake.receipt = receipt;
  fake.organization = { name: "My Organization" };
  fake.logoUpsert.mockResolvedValue({ data: [], error: null });
  fake.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === "demo_clone_source" ? source : name === "spend_budget" ? { ok: true } : receipt }));
});

describe("clone action", () => {
  it("takes only a slug, passing the member's destination and exact Free quotas to one transaction", async () => {
    expect(await cloneDemo("poteto")).toEqual({ ok: true, ...receipt });
    expect(fake.rpc).toHaveBeenLastCalledWith("clone_demo_page", { p_workspace_id: "ws_a", p_source_slug: "poteto", p_slug: "poteto",
      p_max_apps: 1, p_max_pages: 1, p_max_monitors: 50, p_max_assertions: 3, p_per_host: 5, p_http_interval_sec: 180, p_white_label: false });
    expect(fake.origin.mock.invocationCallOrder[0]).toBeLessThan(fake.member.mock.invocationCallOrder[0]);
  });
  it("uses Builder's own counts and interval; names every partial-fit omission", async () => {
    fake.member.mockResolvedValue({ ...member, entitlements: entitlementsFrom(s => s !== "scale_demo") });
    expect(await cloneDemo("poteto")).toMatchObject({ ok: true, skipped: receipt.skipped });
    expect(fake.rpc).toHaveBeenLastCalledWith("clone_demo_page", expect.objectContaining({ p_max_apps: 10, p_max_monitors: 100, p_per_host: 100, p_http_interval_sec: 60, p_white_label: true }));
  });
  it("words the Free app refusal with the existing sentence and enables the offer", async () => {
    fake.rpc.mockImplementation(async (name: string) => name === "clone_demo_page" ? { data: null, error: { code: "P0001", message: "app_limit" } } : { data: name === "spend_budget" ? { ok: true } : source });
    expect(await cloneDemo("poteto")).toEqual({ ok: false, appLimit: true, reason: "Free includes 1 app. Builder includes 10, each with its own monitors and status page." });
  });
  it("returns the duplicate's destination and never calls another write", async () => {
    fake.rpc.mockImplementation(async (name: string) => ({ data: name === "demo_clone_source" ? source : name === "spend_budget" ? { ok: true } : { duplicateAppId: id } }));
    expect(await cloneDemo("poteto")).toMatchObject({ ok: false, duplicateAppId: id, reason: expect.stringContaining("already have an app") });
    expect(fake.rpc.mock.calls.filter(([name]) => name === "clone_demo_page")).toHaveLength(1);
  });
  it("retries only a rolled-back slug collision with the normal random tail", async () => {
    let attempt = 0;
    fake.rpc.mockImplementation(async (name: string) => name !== "clone_demo_page" ? { data: name === "spend_budget" ? { ok: true } : source }
      : attempt++ === 0 ? { error: { code: "23505", message: 'constraint "status_pages_slug_key"' } } : { data: receipt });
    expect(await cloneDemo("poteto")).toMatchObject({ ok: true });
    expect(fake.rpc).toHaveBeenLastCalledWith("clone_demo_page", expect.objectContaining({ p_slug: expect.stringMatching(/^poteto-[a-f0-9]{4}$/) }));
  });
  it.each(["signed-out", "foreign", "forbidden"])("refuses %s before the source read or write", async kind => {
    fake.member.mockResolvedValue(kind === "signed-out" ? null : { ...member, caller: { ...member.caller, ...(kind === "foreign" ? { orgId: "org_b" } : { orgRole: "org:member" }) } });
    expect(await cloneDemo("poteto")).toMatchObject({ ok: false }); expect(fake.rpc).not.toHaveBeenCalled();
  });
  it("does not copy when its member budget refuses", async () => {
    fake.rpc.mockImplementation(async (name: string) => ({ data: name === "demo_clone_source" ? source : { ok: false, retryAfterSec: 31 } }));
    expect(await cloneDemo("poteto")).toMatchObject({ ok: false, retryAfterSec: 31 });
    expect(fake.rpc.mock.calls.map(([name]) => name)).not.toContain("clone_demo_page");
  });
});

describe("clone screen and source boundary", () => {
  it("drops configuration and source ids before rendering, and names both lists and the destination workspace", async () => {
    const preview = await loadDemoPreview("poteto");
    expect(JSON.stringify(preview)).not.toMatch(/SOURCE_APP|source_mon|NEVER_SEND|HEAD/);
    expect(preview?.monitors[0]).toHaveProperty("target", source.monitors[0].target);
    expect(preview?.monitors[1]).toEqual({ name: "Supabase", type: "supabase", copyable: false });
    const html = renderToStaticMarkup(createElement(CloneScreen, { slug: "poteto", demo: demoPreviewSchema.parse(source) }));
    for (const text of ["Poteto", "https://poteto.example", "Copy into My Organization.", "Checks to copy", "Website", "Checks not copied", "needs your own key", "members-only", ">Clone</button>"]) expect(html).toContain(text);
    expect(html).not.toContain("<strong>");
    expect(html.match(/btn-primary/g)).toHaveLength(1);
  });
  it.each([undefined, null, { name: "" }, { name: "   " }])("uses a complete sentence when Clerk has no name: %j", organization => {
    fake.organization = organization;
    const html = renderToStaticMarkup(createElement(CloneScreen, { slug: "poteto", demo: demoPreviewSchema.parse(source) }));
    expect(html).toContain("Copy this demo into your workspace.");
    expect(html).not.toContain("Copy into .");
  });
  it("shows the copied app's logo, or the same accented initial as the dashboard, inside the padded card", () => {
    for (const logoUrl of [source.app.logoUrl, null]) {
      const demo = demoPreviewSchema.parse({ ...source, app: { ...source.app, logoUrl } });
      const html = renderToStaticMarkup(createElement(CloneScreen, { slug: "poteto", demo }));
      const logo = renderToStaticMarkup(createElement(AppLogo, { app: demo.app, size: 32 })).replace(/<link[^>]*\/>/g, "");
      expect(html).toContain(logo);
      expect(html).toMatch(/<form[^>]*class="panel stack"/);
      if (logoUrl) expect(html).toContain(`src="${logoUrl}"`);
      else { expect(html).toContain("--app-logo-fill:"); expect(html).toContain(">P</span>"); }
    }
  });
  it("keeps a copied logo when the scan imports an icon, while an explicit replacement can still replace it", async () => {
    expect(await uploadAppLogo(id, imageForm(), { keep: true })).toEqual({ ok: true, url: null });
    expect(fake.logoUpsert).toHaveBeenLastCalledWith("app_logos", expect.objectContaining({ app_id: id, workspace_id: "ws_a" }), { onConflict: "app_id", ignoreDuplicates: true });
    await uploadAppLogo(id, imageForm());
    expect(fake.logoUpsert).toHaveBeenLastCalledWith("app_logos", expect.anything(), { onConflict: "app_id", ignoreDuplicates: false });
  });
  it("carries a copied app's accent and logo through the real workspace snapshot to its first dashboard render", async () => {
    const { loadSnapshot } = await vi.importActual<typeof import("@/lib/workspace")>("@/lib/workspace");
    const rows = Object.fromEntries(["monitors", "monitor_secrets", "incidents", "incident_notes", "status_pages",
      "page_components", "component_monitors", "page_assets", "heartbeat_latest", "domains", "alert_channels", "alert_deliveries"].map(key => [key, []]));
    fake.rpc.mockResolvedValue({ data: { ...rows,
      apps: [{ id, name: "Poteto", url: "https://poteto.example", accent: "#123456" }],
      app_logos: [{ app_id: id, id: `asset_${"c".repeat(32)}` }], history: { today: "2026-10-29", monitors: [] },
    }, error: null });
    const snapshot = await loadSnapshot(member);
    expect(snapshot.apps[0]).toMatchObject({ accent: "#123456", logoUrl: source.app.logoUrl });
    expect(renderToStaticMarkup(createElement(AppLogo, { app: { ...snapshot.apps[0], logoUrl: null } }))).toContain("--app-logo-fill:#123456");
  });
  it("uses the dashboard monitor identity for public targets and withholds targets from every excluded type", () => {
    const demo = demoPreviewSchema.parse({ ...source, monitors: [
      ...["http", "ssl", "dns", "tcp"].map(type => ({ name: `${type} check`, type, copyable: true, target: type === "http" ? "https://poteto.example/health" : "poteto.example" })),
      ...["http", "ssl", "dns", "tcp", "heartbeat", "supabase", "stripe", "mcp"].map(type => ({ name: `${type} private`, type, copyable: false, target: "NEVER_SEND", config: { key: "NEVER_SEND" } })),
    ] });
    const html = renderToStaticMarkup(createElement(CloneScreen, { slug: "poteto", demo }));
    const table = renderToStaticMarkup(createElement(MonitorTable, { s: sim(), monitors: [monitor({ id: "mon_example", name: "http check", type: "http", target: "https://poteto.example/health" })] }));
    expect(html.match(/class="mon-name"/g)).toHaveLength(12);
    expect(html.match(/class="mon-target addr"/g)).toHaveLength(4);
    expect(table).toContain('class="mon-target addr">poteto.example/health</span>');
    expect(html).toContain('class="mon-target addr">poteto.example/health</span>');
    expect(html).not.toMatch(/NEVER_SEND|Not checked yet|href="\/app\/monitors\//);
  });
  it.each([
    [[], [], "No checks were copied."],
    [["API health"], ["askone.org"], "Copied API health. Staygreen also added askone.org, the certificate check every HTTPS address gets. They&#x27;re listed under Already covered below."],
    [["Website", "API health check", "Authentication"], [], "Copied Website, API health check and Authentication. They&#x27;re listed under Already covered below."],
    [["Website"], ["a.example", "b.example"], "Copied Website. Staygreen also added a.example and b.example, the certificate checks every HTTPS address gets."],
  ])("names every monitor the copy made: copied %j, added %j", (copied, added, sentence) => {
    fake.receipt = { ...receipt, copied, added };
    const html = renderToStaticMarkup(createElement(CloneReceipt, { appId: id }));
    expect(html.replace(/<!-- -->/g, "")).toContain(sentence);
    expect(html).toContain('class="callout callout-info"');
    expect(html).not.toContain("<strong>");
  });
  it("keeps private-page guidance and every omission readable at the suggested-checks landing", () => {
    const html = renderToStaticMarkup(createElement(CloneReceipt, { appId: id }));
    expect(html).toContain("members-only"); expect(html).toContain(`/app/status-pages/${pageId}`);
    expect(html).toContain("Supabase: needs your own key"); expect(html).toContain("DNS: monitor limit reached");
  });
  it.each(["non-demo", "private", "missing"])("returns the same 404 for a %s source and reads no destination snapshot", async () => {
    fake.rpc.mockResolvedValue({ data: null, error: null });
    await expect(ClonePage({ params: Promise.resolve({ slug: "poteto" }) })).rejects.toThrow("404");
    expect(fake.snapshot).not.toHaveBeenCalled();
  });
  it("requires the clone's own return path at sign-in", async () => {
    await ClonePage({ params: Promise.resolve({ slug: "poteto" }) });
    expect(fake.require).toHaveBeenCalledWith("/app/clone/poteto");
  });
  it("carries the local destination through both Clerk cards, including sign-up's fallback", async () => {
    for (const page of [SignIn, SignUp]) {
      const html = renderToStaticMarkup(await page({ searchParams: Promise.resolve({ redirect_url: "/app/clone/poteto" }) }));
      expect(html).toContain("%2Fapp%2Fclone%2Fpoteto"); expect(html).toContain("/app/clone/poteto");
      expect(html).toContain("fallbackRedirectUrl");
    }
    for (const bad of ["https://evil.example", "//evil.example", "/app/clone/a?next=bad", "/app/clone/../x", ["/app/clone/poteto"]]) expect(cloneReturnPath(bad)).toBeUndefined();
  });
});
