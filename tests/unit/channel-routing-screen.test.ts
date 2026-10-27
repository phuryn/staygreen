import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoutingSettings } from "@/app/(app)/app/alerts/ChannelSettings";
import type { AlertsView } from "@/lib/alerts/server";
import type { Workspace } from "@/lib/workspace-store";
import { PERMISSIONS } from "@/lib/authz";
import { NOW, sim } from "./fixtures";

// Real routing form and React rendering; only navigation and server actions are faked.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/app/alerts/actions", () => ({ addWebhookChannel: vi.fn(), connectSlack: vi.fn(), saveAlertRouting: vi.fn() }));

const s: Workspace = {
  ...sim({ apps: [{ id: "app_a", name: "Main", url: "", logoUrl: null, blurb: "", channelIds: [] }] }),
  loadedAt: NOW, features: [],
  can: Object.fromEntries(PERMISSIONS.map((p) => [p, true])) as Workspace["can"],
};
const view: AlertsView = {
  appUrl: "https://staygreen.test", email: { ready: false, redirectTo: null },
  telegram: { ready: false }, slack: { ready: false }, members: [], deliveries: [], routes: [],
  channels: [{ id: "chan_a", label: "Ops", kind: "slack", audience: null, state: "on", waitingSince: null, createdByYou: true, appsOff: [] }],
};
const render = (channelIds: string[]) => renderToStaticMarkup(createElement(RoutingSettings, {
  s, manage: true, view: { ...view, routes: [{ appId: "app_a", monitorId: null, severity: "all", channelIds }] },
}));

describe("routing after its last channel is removed", () => {
  it("shows inheritance for a leftover empty rule, and an explicit selection for a populated rule", () => {
    const empty = render([]);
    expect(empty).toContain("Choose channels for this rule");
    expect(empty).toContain("Uses all channels except any previously turned off for this app. New channels are included.");
    expect(empty).not.toContain('checked=""');
    expect(empty).not.toContain("No alerts will be sent");
    const populated = render(["chan_a"]);
    expect(populated).toContain("Send to");
    expect(populated.match(/checked=""/g)).toHaveLength(2);
  });
});
