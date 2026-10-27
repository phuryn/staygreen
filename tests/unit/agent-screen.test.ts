import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { sim, NOW } from "./fixtures";
import { PERMISSIONS } from "@/lib/authz";
import type { Workspace } from "@/lib/workspace-store";
const hook = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace-store", () => ({ useWorkspace: hook, useActs: () => ({}), useHoldPoll: vi.fn() }));
import { AgentsScreen } from "@/app/(app)/app/agents/AgentsScreen";
const render = (manage: boolean, active: boolean) => {
  const s: Workspace = { ...sim(), loadedAt: NOW, features: [], can: Object.fromEntries(PERMISSIONS.map(p => [p, p !== "tokens:manage" || manage])) as Workspace["can"] };
  hook.mockReturnValue(s);
  return renderToStaticMarkup(createElement(AgentsScreen, { mcpUrl: "https://staygreen.test/mcp", tokens: active ? [{ id: "tok", name: "CI", kid: "a".repeat(24), scope: "read", created_at: "2026-10-23T00:00:00Z", last_used_at: null, revoked_at: null }] : [], activity: active ? [{ id: "act", client: "Build pipeline", tool: "pause", resource_id: "mon", created_at: "2026-10-23T00:00:00Z" }] : [] }));
};
it.each([false,true])("gates token controls and promises on tokens:manage in every state (populated=%s)", active => {
  expect(render(false,active)).not.toMatch(/Create token|API tokens for CI|Revoke/);
  expect(render(true,active)).toContain("Create token");
});
it("shows the live URL, eleven tools, scan and activity", () => {
  const html = render(true,true);
  expect(html).toContain("https://staygreen.test/mcp"); expect(html).toContain("scan_app"); expect(html).toContain("uses read access and creates no monitors");
  expect(html).toContain("Build pipeline"); expect(html).toContain('class="set-row"'); expect(html).not.toContain("connect-link");
});
