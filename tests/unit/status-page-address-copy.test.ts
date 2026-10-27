import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StatusPagesScreen } from "@/app/(app)/app/status-pages/StatusPagesScreen";
import { PERMISSIONS } from "@/lib/authz";
import type { Workspace } from "@/lib/workspace-store";
import { NOW, page, sim } from "./fixtures";

// The list is real; the workspace feed, navigation and the button's clipboard call are faked, so
// the address each row hands to Copy can be read from the markup.
const feed = vi.hoisted(() => ({ workspace: null as Workspace | null }));
vi.mock("@/lib/workspace-store", () => ({
  useWorkspace: () => feed.workspace,
  useAppSelection: () => ({ app: "all", setApp: vi.fn() }),
  useActs: () => ({}),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/Copy", () => ({
  Copy: ({ text, label }: { text: string; label: string }) => createElement("button", { "data-copies": text }, label),
}));

const app = (id: string) => ({ id, name: id, url: "", logoUrl: null, blurb: "", channelIds: [] });

describe("status pages list", () => {
  it("offers each page's public address to copy, beside the address on either layout", () => {
    feed.workspace = {
      ...sim({
        apps: [app("app_1"), app("app_2")],
        pages: [
          page({ id: "page_1", appId: "app_1", slug: "harbor" }),
          page({ id: "page_2", appId: "app_2", slug: "lighthouse", domain: { host: "status.lighthouse.dev", name: "status", cnameTarget: `${"a".repeat(32)}.domains.staygreen.io`, step: 4, startedAt: NOW } }),
        ],
      }),
      loadedAt: NOW, features: [],
      can: Object.fromEntries(PERMISSIONS.map((p) => [p, false])) as Workspace["can"],
    };
    const html = renderToStaticMarkup(createElement(StatusPagesScreen));
    // Each row carries the address twice, under the name for phones and in its own column for
    // desktops, and each copy of it is followed by its icon.
    const pairs = [...html.matchAll(/<span class="addr(?: spl-addr)?">([^<]+)<\/span><button data-copies="([^"]+)">Copy address</g)].map((m) => [m[1], m[2]]);
    expect(pairs).toEqual([
      ["status.staygreen.io/harbor", "https://status.staygreen.io/harbor"],
      ["status.staygreen.io/harbor", "https://status.staygreen.io/harbor"],
      ["status.lighthouse.dev", "https://status.lighthouse.dev"],
      ["status.lighthouse.dev", "https://status.lighthouse.dev"],
    ]);
  });
});

describe("Copy as an icon", () => {
  it("is a quiet icon button named by its label, with no visible text", async () => {
    const { Copy } = await vi.importActual<typeof import("@/components/Copy")>("@/components/Copy");
    const html = renderToStaticMarkup(createElement(Copy, { text: "https://status.staygreen.io/harbor", label: "Copy address", icon: true }));
    expect(html).toContain('class="btn btn-sm btn-quiet btn-icon"');
    expect(html).toContain('aria-label="Copy address"');
    expect(html.replace(/<[^>]+>/g, "")).toBe("");
  });
});
