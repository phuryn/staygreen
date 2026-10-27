import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewScreen } from "@/app/(app)/app/OverviewScreen";
import { AppRow } from "@/app/(app)/app/settings/AppSettings";
import { PERMISSIONS } from "@/lib/authz";
import type { Workspace } from "@/lib/workspace-store";
import { NOW, sim } from "./fixtures";

// Real screen markup with only workspace/actions/navigation faked; no browser layout claim.
const feed = vi.hoisted(() => ({ workspace: null as Workspace | null }));
vi.mock("@/lib/workspace-store", () => ({
  useWorkspace: () => feed.workspace,
  useAppSelection: () => ({ app: "all", setApp: vi.fn() }),
  useActs: () => ({}), usePoll: vi.fn(), useEagerPoll: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const app = { id: "app_a", name: "Harbor", url: "https://harbor.example/", logoUrl: null, blurb: "", channelIds: [] };
const all = () => Object.fromEntries(PERMISSIONS.map((p) => [p, true])) as Workspace["can"];
beforeEach(() => {
  feed.workspace = { ...sim({ apps: [app], monitors: [] }), loadedAt: NOW, features: [], can: all() };
});
const overview = () => renderToStaticMarkup(createElement(OverviewScreen));
const row = (onDelete: (() => void) | null) => renderToStaticMarkup(createElement(AppRow, { s: feed.workspace!, app, onDelete }));
/** The markup outside the "…" menu's popover and the closed confirmation it opens. */
const outsideMenu = (html: string) => html.replace(/<div[^>]*role="menu"[^>]*>[\s\S]*?<\/div>/g, "").replace(/<dialog[\s\S]*?<\/dialog>/g, "");

describe("deleting an app sits behind a … menu (owner, 2026-10-26)", () => {
  it.each([["the overview", overview], ["Settings", () => row(() => {})]])("on %s: the menu holds Delete app, and nothing outside it deletes", (_, render) => {
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"[^>]*aria-label="More for Harbor"/);
    expect(html).toMatch(/role="menu"[^>]*aria-label="More for Harbor"[\s\S]*role="menuitem"[\s\S]*Delete app/);
    expect(outsideMenu(html)).not.toMatch(/Delete/);
  });
  it("shows no menu to a member who may not delete the app", () => {
    feed.workspace!.can = { ...all(), "monitors:delete": false };
    expect(overview()).not.toContain("More for Harbor");
    expect(row(null)).not.toContain("More for Harbor");
  });
  it("keeps the overview's other app actions when only deleting is allowed", () => {
    feed.workspace!.can = { ...all(), "monitors:write": false };
    const html = overview();
    expect(html).toContain("More for Harbor");
    expect(html).not.toContain("Find missing checks");
  });
});
