import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/authz";
import type { Workspace } from "@/lib/workspace-store";
import { isSameOrigin } from "@/lib/origin";
import { pageHost } from "@/lib/derive";
import { page, sim, NOW } from "./fixtures";

const fake = vi.hoisted(() => ({ workspace: null as Workspace | null, load: vi.fn() }));
vi.mock("@/lib/workspace-store", () => ({ useWorkspace: () => fake.workspace, useActs: () => ({}),
  useAppSelection: () => ({ app: "all" }), useHoldPoll: vi.fn() }));
vi.mock("@/lib/status-access", () => ({ loadStatusPage: fake.load }));
vi.mock("@/lib/env", () => ({ env: () => ({ STATUS_EDGE_ENABLED: "on" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }),
  redirect: (url: string) => { throw Error(url); }, notFound: () => { throw Error("404"); } }));

import PublicStatusPage from "@/app/(status)/s/[slug]/page";
import { PageEditorScreen } from "@/app/(app)/app/status-pages/[id]/PageEditorScreen";
import { StatusPagesScreen } from "@/app/(app)/app/status-pages/StatusPagesScreen";
import { WidgetScreen } from "@/app/(app)/app/widget/WidgetScreen";

afterEach(() => vi.unstubAllEnvs());

it.each([undefined, "status-dev.example.com"])("uses the configured host in app links, editor and embed (%s)", value => {
  vi.stubEnv("NEXT_PUBLIC_STATUS_HOST", value);
  const host = value ?? "status.staygreen.io";
  const p = page();
  fake.workspace = { ...sim({ pages: [p] }), loadedAt: NOW, features: [],
    can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"] };
  expect(pageHost(p)).toBe(`${host}/example`);
  const editor = renderToStaticMarkup(createElement(PageEditorScreen, { id: p.id }));
  expect(editor).toContain(`>${host}/</span>`);
  expect(renderToStaticMarkup(createElement(StatusPagesScreen))).toContain(`>${host}</span>`);
  const widget = renderToStaticMarkup(createElement(WidgetScreen, { origin: "https://dev.example.com" }));
  expect(widget).toContain(`src=&quot;https://${host}/w.js&quot;`);
  expect(widget).toContain(`Allow https://${host} in your Content Security Policy&#x27;s script-src and connect-src`);
  expect(isSameOrigin({ secFetchSite: null, origin: `https://${host}`, host })).toBe(true);
  expect(isSameOrigin({ secFetchSite: null, origin: "https://unrelated.example.com", host })).toBe(false);
});

it.each([undefined, "status-dev.example.com"])("redirects public /s pages to the configured edge (%s), leaving private pages here", async value => {
  vi.stubEnv("NEXT_PUBLIC_STATUS_HOST", value);
  fake.load.mockResolvedValue({ membersOnly: false, view: { page: { slug: "example" } } });
  await expect(PublicStatusPage({ params: Promise.resolve({ slug: "example" }) })).rejects.toThrow(`https://${value ?? "status.staygreen.io"}/example`);
  fake.load.mockResolvedValue({ membersOnly: true, view: { page: { slug: "example" } } });
  expect(await PublicStatusPage({ params: Promise.resolve({ slug: "example" }) })).toBeTruthy();
});

it("reserves the configured host's label in the shared browser/server slug validator", async () => {
  vi.stubEnv("NEXT_PUBLIC_STATUS_HOST", "status-dev.example.com");
  vi.resetModules();
  const { pageDraftSchema, RESERVED_SLUGS } = await import("@/lib/page-input");
  expect(RESERVED_SLUGS).toContain("status-dev");
  expect(pageDraftSchema.shape.slug.safeParse("status-dev").success).toBe(false);
  expect(pageDraftSchema.shape.slug.safeParse("customer-page").success).toBe(true);
});
