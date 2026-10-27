import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewScreen } from "@/app/(app)/app/OverviewScreen";
import { MonitorsScreen } from "@/app/(app)/app/monitors/MonitorsScreen";
import { AppLine, AppRow, AppSwitcher } from "@/components/AppSwitcher";
import { MonitorTable } from "@/components/MonitorTable";
import { firstCount } from "@/lib/app-selection";
import { PERMISSIONS } from "@/lib/authz";
import { demoLimits, limits } from "@/lib/plans";
import type { Workspace } from "@/lib/workspace-store";
import { monitor, NOW, sim } from "./fixtures";

// Real screens and summaries; only the workspace feed and Next navigation are faked.
const feed = vi.hoisted(() => ({ workspace: null as Workspace | null, search: "", app: "all" }));
vi.mock("@/lib/workspace-store", () => ({
  useWorkspace: () => feed.workspace,
  useAppSelection: () => ({ app: feed.app, setApp: vi.fn() }),
  usePoll: vi.fn(),
  useEagerPoll: vi.fn(),
}));
// With the real add-app form the first visit renders empty in this test; a stub lets its sentence be read.
vi.mock("@/components/AddApp", () => ({ AddApp: () => null }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(feed.search),
  usePathname: () => "/app",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const app = (id: string) => ({ id, name: id, url: "", logoUrl: null, blurb: "", channelIds: [] });
const checking = monitor({ id: "checking", appId: "Harbor", state: "unchecked", checked: true });
const fresh = monitor({ id: "fresh", appId: "Harbor", state: "unchecked", checked: false });
const heartbeat = monitor({
  id: "heartbeat", appId: "Harbor", type: "heartbeat", state: "unchecked", checked: false,
  hb: {
    token: "", schedule: "interval", scheduleLabel: "Every hour", periodMin: 60, tz: "UTC",
    graceMin: 5, maxRunMin: 10, lastPingAt: 0, lastKind: null, summary: null, runningSince: null, expectedAt: null,
  },
});
const workspace = (monitors: Workspace["monitors"]): Workspace => ({
  ...sim({ apps: [app("Harbor")], monitors }),
  loadedAt: NOW, features: [],
  can: Object.fromEntries(PERMISSIONS.map((p) => [p, false])) as Workspace["can"],
});
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const monitorIds = (html: string) => [...html.matchAll(/href="\/app\/monitors\/([^"?]+)"/g)].map((m) => m[1]);

beforeEach(() => { feed.workspace = workspace([checking]); feed.search = ""; feed.app = "all"; });

describe("one unsettled monitor, the same words on every app surface", () => {
  it("says Checking on its row, Overview app heading, rail and phone bar", () => {
    const s = feed.workspace!;
    const overview = renderToStaticMarkup(createElement(OverviewScreen));
    expect(text(overview.match(/<h2 id="app-Harbor">([\s\S]*?)<\/h2>/)![1])).toContain("HarborChecking…");
    for (const component of [AppRow, AppLine]) {
      const html = renderToStaticMarkup(createElement(component, { s }));
      expect(text(html)).toContain("Checking…");
      expect(text(html)).not.toContain("Not checked yet");
    }
    const row = renderToStaticMarkup(createElement(MonitorTable, { s, monitors: s.monitors }));
    expect(text(row)).toContain("Checking…");
    expect(text(row)).not.toContain("Not checked yet");
  });

  it("uses the same words in the switcher's accessible option name", () => {
    const s = { ...feed.workspace!, apps: [app("Harbor"), app("Other")] };
    expect(renderToStaticMarkup(createElement(AppSwitcher, { s }))).toContain('aria-label="Harbor, Checking…"');
  });

  it("keeps a never-pinged heartbeat's current words, even beside a checking monitor", () => {
    const s = workspace([checking, heartbeat]);
    const row = text(renderToStaticMarkup(createElement(MonitorTable, { s, monitors: [heartbeat] })));
    expect(row).toContain("Not checked yet");
    expect(row).toContain("No ping yet");
    expect(row).not.toContain("Checking");
    for (const component of [AppRow, AppLine]) {
      expect(text(renderToStaticMarkup(createElement(component, { s })))).toContain("Checking 1… and 1 not checked yet");
    }
  });

  it("the Checking count links to exactly its monitors, without fresh monitors or unpinged heartbeats", () => {
    feed.workspace = workspace([checking, fresh, heartbeat]);
    const tile = firstCount(feed.workspace.monitors);
    feed.search = new URL(tile.href, "https://example.com").search;
    const html = renderToStaticMarkup(createElement(MonitorsScreen));
    expect(monitorIds(html)).toEqual([checking.id]);
    expect(monitorIds(html)).toHaveLength(tile.n);
    expect(html).toContain('<option value="checking" selected="">Checking…</option>');
  });

  it("the Not checked yet filter lists fresh monitors and unpinged heartbeats only", () => {
    feed.workspace = workspace([checking, fresh, heartbeat]);
    feed.search = "state=unchecked";
    const html = renderToStaticMarkup(createElement(MonitorsScreen));
    expect(monitorIds(html)).toEqual([fresh.id, heartbeat.id]);
  });
});

describe("the first visit names the session's app count", () => {
  const empty = (over: Partial<Workspace>): Workspace => ({
    ...workspace([]), apps: [], plan: "builder",
    can: Object.fromEntries(PERMISSIONS.map((p) => [p, true])) as Workspace["can"], ...over,
  });

  it("says Builder's 10 on Builder, and the demo plan's 100 when the session holds it", () => {
    feed.workspace = empty({});
    expect(text(renderToStaticMarkup(createElement(OverviewScreen)))).toContain(`Builder includes ${limits.builder.apps} apps`);
    feed.workspace = empty({ limits: demoLimits });
    expect(text(renderToStaticMarkup(createElement(OverviewScreen)))).toContain(`Builder includes ${demoLimits.apps} apps`);
  });
});
