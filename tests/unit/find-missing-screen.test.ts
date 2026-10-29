import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OverviewScreen } from "@/app/(app)/app/OverviewScreen";
import { AppRow } from "@/app/(app)/app/settings/AppSettings";
import { ChecksScreen } from "@/app/(app)/app/apps/[id]/checks/ChecksScreen";
import { SuggestedChecksResult } from "@/components/SuggestedChecks";
import { PERMISSIONS } from "@/lib/authz";
import type { Suggestions } from "@/lib/suggestions";
import type { Workspace } from "@/lib/workspace-store";
import type { CloneReceipt } from "@/lib/demo-clone";
import { NOW, sim } from "./fixtures";

// Real screen markup with only workspace/actions/navigation faked; no browser layout claim.
const feed = vi.hoisted(() => ({ workspace: null as Workspace | null, receipt: null as CloneReceipt | null }));
vi.mock("@/lib/workspace-store", () => ({
  useWorkspace: () => feed.workspace,
  useAppSelection: () => ({ app: "all", setApp: vi.fn() }),
  useActs: () => ({}), usePoll: vi.fn(), useEagerPoll: vi.fn(),
  useCloneReceipt: () => feed.receipt,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

const app = { id: "app_a", name: "Harbor", url: "", logoUrl: null, blurb: "", channelIds: [] };
const root = { kind: "http" as const, url: "https://example.com/", name: "Website", root: true, ok: true, status: 200, ticked: true };
const found: Suggestions = {
  address: root.url, reached: true, http: [root], ssl: null, icon: null, accent: null, supabase: null,
};
const result = (s: Suggestions) => renderToStaticMarkup(createElement(SuggestedChecksResult, { appId: app.id, s, skip: null, onDone: vi.fn() }));
beforeEach(() => {
  feed.receipt = null;
  feed.workspace = { ...sim({ apps: [app], monitors: [] }), loadedAt: NOW, features: [],
    can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"],
  };
});

describe("finding missing checks from an existing app", () => {
  it("keeps the back link in the head and the clone notice below the description, spaced above content", () => {
    feed.receipt = { appId: app.id, pageId: `page_${"a".repeat(24)}`, copied: ["Website"], added: [], skipped: [] };
    const html = renderToStaticMarkup(createElement(ChecksScreen, { id: app.id }));
    const header = html.match(/<header class="page-head">[\s\S]*?<\/header>/)![0];
    expect(header).toMatch(/<a[^>]*class="back"[^>]*>Overview<\/a>/);
    expect(header).toContain("Suggested checks for Harbor");
    expect(header).toContain("Existing checks in this workspace");
    expect(header).not.toContain("Clone result");
    expect(html).toMatch(/<\/header><div class="stack"><section class="callout callout-info" aria-label="Clone result">[\s\S]*?<\/section><section class="panel" aria-label="Suggested checks for Harbor">/);
  });
  it.each(["", "https://example.com/"])("offers the action from overview and Settings with address %j", url => {
    const s = feed.workspace!;
    s.apps = [{ ...app, url }];
    for (const html of [renderToStaticMarkup(createElement(OverviewScreen)), renderToStaticMarkup(createElement(AppRow, { s, app: s.apps[0], onDelete: null }))]) {
      expect(html).toContain('href="/app/apps/app_a/checks"');
      expect(html).toContain("Find missing checks");
    }
    s.can["monitors:write"] = false;
    for (const html of [renderToStaticMarkup(createElement(OverviewScreen)), renderToStaticMarkup(createElement(AppRow, { s, app: s.apps[0], onDelete: null }))]) {
      expect(html).not.toContain("Find missing checks");
    }
  });

  it("asks for a missing address in place, preserves the heartbeat-only way out, and makes no premature scan claim", () => {
    const html = renderToStaticMarkup(createElement(ChecksScreen, { id: app.id }));
    expect(html).toContain('id="checks-address"');
    expect(html).toContain("Save and find checks");
    expect(html).toContain("job heartbeats can stay without one");
    expect(html).toContain("Skip for now");
    expect(html).not.toContain("tried the address");
    feed.workspace!.can["monitors:write"] = false;
    expect(renderToStaticMarkup(createElement(ChecksScreen, { id: app.id }))).toBe("");
  });

  it("keeps missing checks outside a collapsed covered group, with only missing selections counted", () => {
    const html = result({ ...found, http: [{ ...root, watched: true }, { ...root, root: false, name: "Health check", url: "https://example.com/health" }] });
    const disclosure = html.match(/<details[\s\S]*?<\/details>/)![0];
    expect(disclosure).toContain("Already covered (1)");
    expect(disclosure).not.toMatch(/<details[^>]*\bopen/);
    expect(disclosure).toContain("HTTP");
    expect(disclosure).not.toContain("Health check");
    expect(html.replace(disclosure, "")).toContain("Health check");
    expect(html.replace(disclosure, "")).not.toContain("Already watched");
    expect(html).toContain("Add 1 check");
  });

  it("folds HTTP dependencies, DNS, SSL and one Supabase project without promising they are healthy", () => {
    const ref = "abcdefghijklmnopqrst";
    const html = result({ ...found,
      http: [
        { ...root, watched: true },
        { ...root, root: false, url: "https://clerk.example.com/script.js", dependency: "Clerk", name: "Clerk frontend", watched: true },
        ...(["auth", "storage"] as const).map(supabase => ({ ...root, root: false, url: `https://${ref}.supabase.co/${supabase}`, supabase, watched: true })),
      ],
      dns: [{ kind: "dns", record: "NS", recordName: "example.com", expected: "ns.example.net", name: "Nameservers", purpose: "DNS changes", watched: true }],
      ssl: { kind: "ssl", host: "example.com", ok: false, watched: true },
      supabase: { ref, key: "not-rendered" },
    });
    expect(html).toContain("Already covered (5)");
    expect(html).toContain("No missing checks found.");
    expect(html).toContain("Every check suggested by this scan");
    expect(html).toContain("including paused monitors");
    expect(html).toContain("does not mean they are healthy");
    expect(html).not.toContain("Add checks");
    expect(html).not.toContain("not-rendered");
  });

  it("puts SSL right under the address's HTTP check, before the app and its health routes", () => {
    const html = result({ ...found,
      http: [root, { ...root, root: false, name: "App", url: "https://app.example.com/", discovered: true }, { ...root, root: false, name: "Health check", url: "https://example.com/health" }],
      ssl: { kind: "ssl", host: "example.com", ok: true, daysLeft: 90 },
    });
    const at = (text: string) => html.indexOf(text);
    expect(at("https://example.com/</code>")).toBeGreaterThan(-1);
    expect(at("SSL and domain")).toBeGreaterThan(at("https://example.com/</code>"));
    expect(at("SSL and domain")).toBeLessThan(at("app.example.com/"));
    expect(at("SSL and domain")).toBeLessThan(at("Health check"));
  });

  it("does not call a failed scan covered, or a failed unchecked suggestion nothing missing", () => {
    const unreachable = result({ ...found, reached: false, http: [{ ...root, ok: false }] });
    expect(unreachable).toContain("didn&#x27;t answer");
    expect(unreachable).not.toContain("No missing checks found");
    const failed = result({ ...found, http: [{ ...root, ok: false, ticked: false }] });
    expect(failed).not.toContain("No missing checks found");
    expect(failed).toMatch(/<button[^>]*disabled=""[^>]*>Add checks<\/button>/);
  });
});
