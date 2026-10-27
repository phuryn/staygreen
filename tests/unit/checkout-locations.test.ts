import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { PERMISSIONS } from "@/lib/authz";
import { NO_HISTORY } from "@/lib/history";
import type { Workspace } from "@/lib/workspace-store";
import { monitor, NOW, sim } from "./fixtures";

const feed = vi.hoisted(() => ({ workspace: null as Workspace | null }));
vi.mock("@/lib/workspace-store", () => ({
  useWorkspace: () => feed.workspace,
  useAppSelection: () => ({ app: "app_1" }),
  useActs: () => ({}),
  usePoll: vi.fn(),
  useEagerPoll: vi.fn(),
  useHoldPoll: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { AddMonitorScreen } from "@/app/(app)/app/monitors/new/AddMonitorScreen";
import { MonitorScreen } from "@/app/(app)/app/monitors/[id]/MonitorScreen";

it.each(["free", "builder"] as const)("names Frankfurt in the %s monitor flow as a running location, and Builder's alone", plan => {
  feed.workspace = {
    ...sim({ plan, monitors: [monitor({ id: "mon_1" })], apps: [
      { id: "app_1", name: "Example", url: "https://example.com", logoUrl: null, blurb: "", channelIds: [] },
    ] }),
    loadedAt: NOW, features: [],
    can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"],
  };
  const add = renderToStaticMarkup(createElement(AddMonitorScreen));
  const detail = renderToStaticMarkup(createElement(MonitorScreen, { id: "mon_1", pingUrl: null, history: NO_HISTORY, latest: null }));
  for (const html of [add, detail]) {
    const row = [...html.matchAll(/<li[\s>][\s\S]*?<\/li>/g)].map(([li]) => li).find(li => li.includes("Frankfurt"));
    expect(row).toBeDefined();
    expect(row).not.toContain("Coming soon");
    // Free sees it as Builder's; Builder sees it as one of its own.
    if (plan === "free") expect(row).toContain("Builder");
    else expect(row).not.toContain("tag-builder");
  }
  expect(add).toContain(plan === "free" ? "from Toronto and San Francisco." : "from Toronto, San Francisco and Frankfurt.");
  expect(add).not.toContain("and San Francisco and Frankfurt");
});
