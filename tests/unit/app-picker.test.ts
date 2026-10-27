import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppPicker } from "@/components/AppPicker";
import { StatusPagesScreen } from "@/app/(app)/app/status-pages/StatusPagesScreen";
import { AddMonitorScreen } from "@/app/(app)/app/monitors/new/AddMonitorScreen";
import { MonitorsScreen } from "@/app/(app)/app/monitors/MonitorsScreen";
import { IncidentsScreen } from "@/app/(app)/app/incidents/IncidentsScreen";
import { RoutingSettings } from "@/app/(app)/app/alerts/ChannelSettings";
import type { Workspace } from "@/lib/workspace-store";
import { PERMISSIONS } from "@/lib/authz";
import { NOW, page, sim } from "./fixtures";

// Real components and server markup. Only the workspace, navigation and actions are substituted;
// native focus/dismissal and layout belong to the browser harness.
const feed = vi.hoisted(() => ({ workspace: null as Workspace | null, app: "app_a" }));
vi.mock("@/lib/workspace-store", () => ({
  useWorkspace: () => feed.workspace,
  useAppSelection: () => ({ app: feed.app, setApp: vi.fn() }),
  useActs: () => ({}), usePoll: vi.fn(), useEagerPoll: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(), usePathname: () => "/app",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/(app)/app/alerts/actions", () => ({ addWebhookChannel: vi.fn(), connectSlack: vi.fn(), saveAlertRouting: vi.fn() }));
const apps = [
  { id: "app_a", name: "Harbor", logoUrl: "/page-assets/harbor.png", url: "", blurb: "", channelIds: [] },
  { id: "app_b", name: "Beacon & its very long app name ".repeat(4), logoUrl: null, url: "", blurb: "", channelIds: [] },
];
const render = (props: Partial<Parameters<typeof AppPicker>[0]> = {}) => renderToStaticMarkup(createElement(AppPicker, {
  id: "app", apps, value: "app_a", onChange: vi.fn(), ...props,
}));
beforeEach(() => {
  feed.app = "app_a";
  feed.workspace = {
    ...sim({ apps, monitors: [], pages: [], incidents: [] }), loadedAt: NOW, features: [],
    can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"],
  };
});

describe("AppPicker markup", () => {
  it("is a labelled, non-submitting trigger controlling one native listbox with one selection", () => {
    const html = render({ "aria-labelledby": "app-label", "aria-describedby": "hint" });
    expect(html).toMatch(/id="app" type="button"[^>]+aria-haspopup="listbox" aria-expanded="false"/);
    const control = /aria-controls="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${control}" popover="auto" role="listbox"`);
    expect(html.match(/aria-labelledby="app-label"/g)).toHaveLength(2);
    expect(html).toContain(`aria-describedby="${control}-value hint"`);
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(html).not.toContain("<select");
  });

  it("shows the stored logo in the trigger and option, a decorative fallback, and the full escaped title", () => {
    const html = render();
    expect(html.match(/<img class="app-logo" src="\/page-assets\/harbor.png" alt=""/g)).toHaveLength(2);
    expect(html).toContain('class="app-logo app-logo-none" aria-hidden="true"');
    expect(html).toContain(`title="${apps[1].name.replaceAll("&", "&amp;")}"`);
  });

  it("gives All apps no logo, and lets it remain usable with no apps", () => {
    const html = render({ apps: [], allApps: true, value: "all" });
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("All apps");
    expect(html).not.toContain("app-logo");
    expect(html).not.toContain('disabled=""');
  });

  it("disables both an explicit refusal and an empty list while retaining their displayed value", () => {
    expect(render({ disabled: true })).toMatch(/disabled=""[^>]+aria-haspopup="listbox"/);
    const html = render({ apps: [], value: "", emptyMessage: "Every app has a page" });
    expect(html).toContain('disabled=""');
    expect(html).toContain("Every app has a page");
    expect(html).not.toContain('role="option"');
  });

  it("asks for a choice when the controlled app disappears, without claiming the list is empty", () => {
    const html = render({ value: "deleted" });
    expect(html).toContain("Choose an app");
    expect(html).not.toContain("No apps available");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('aria-selected="true"');
  });
});

describe("the five app fields", () => {
  it.each([
    ["New status page", StatusPagesScreen, "spl-app", "App"],
    ["Add monitor", AddMonitorScreen, "app", "Which app is it part of?"],
    ["Monitors", MonitorsScreen, "f-app", "App"],
    ["Incidents", IncidentsScreen, "i-app", "App"],
  ] as const)("%s retains its label and renders the chosen logo through the picker", (_name, Screen, id, label) => {
    const html = renderToStaticMarkup(createElement(Screen));
    expect(html).toContain(`for="${id}">${label}</label>`);
    expect(html).toMatch(new RegExp(`<button id="${id}"[^>]+aria-haspopup="listbox"`));
    expect(html).toContain('class="app-logo" src="/page-assets/harbor.png"');
    expect(html).not.toContain(`<select id="${id}"`);
  });

  it("routing has an explicit App label outside the listbox's buttons", () => {
    const html = renderToStaticMarkup(createElement(RoutingSettings, {
      s: feed.workspace!, manage: true,
      view: { appUrl: "https://staygreen.test", email: { ready: false, redirectTo: null }, telegram: { ready: false }, slack: { ready: false }, members: [], deliveries: [], routes: [], channels: [] },
    }));
    expect(html).toContain('<label class="label" for="routing-app">App</label>');
    expect(html).toMatch(/<button id="routing-app"[^>]+aria-haspopup="listbox"/);
    expect(html).toContain('class="app-logo" src="/page-assets/harbor.png"');
  });

  it("new-page choices exclude apps with a page and retain the scoped empty message", () => {
    feed.workspace!.plan = "builder";
    feed.workspace!.pages = [page({ appId: "app_a" })];
    feed.app = "all";
    const available = renderToStaticMarkup(createElement(StatusPagesScreen));
    expect(available.match(/role="option"/g)).toHaveLength(1);
    expect(available).not.toContain('title="Harbor"');
    feed.app = "app_a";
    const scoped = renderToStaticMarkup(createElement(StatusPagesScreen));
    expect(scoped).toContain("This app has a page");
    expect(scoped).toMatch(/id="spl-app"[^>]+disabled=""/);
    feed.app = "all";
    feed.workspace!.pages.push(page({ id: "page_2", appId: "app_b" }));
    const all = renderToStaticMarkup(createElement(StatusPagesScreen));
    expect(all).toContain("Every app has a page");
    expect(all).not.toContain('role="option"');
    expect(all).toMatch(/id="spl-app"[^>]+disabled=""/);
  });
});
