import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PageEditorScreen } from "@/app/(app)/app/status-pages/[id]/PageEditorScreen";
import { WidgetScreen } from "@/app/(app)/app/widget/WidgetScreen";
import { CollapsibleSection } from "@/components/CollapsibleSection";
import { StatusPageView } from "@/components/status/StatusPageView";
import { PERMISSIONS } from "@/lib/authz";
import { snapshotDto, viewFromDto, viewFromSim } from "@/lib/public-page";
import { summaryFor } from "@/lib/status-summary";
import type { Workspace } from "@/lib/workspace-store";
import { component, incident, monitor, note, NOW, page, sim } from "./fixtures";

// Real screen markup and public transforms; only workspace/actions/navigation/clipboard are fake.
const feed = vi.hoisted(() => ({ workspace: null as Workspace | null }));
vi.mock("@/lib/workspace-store", () => ({ useWorkspace: () => feed.workspace, useActs: () => ({}) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/components/Copy", () => ({ Copy: ({ text, label }: { text: string; label: string }) => createElement("button", { "data-copies": text }, label) }));
const names = ["Website", "Database", "API"];
beforeEach(() => {
  feed.workspace = {
    ...sim({
      monitors: [monitor({ id: "mon_0123456789abcdef01234567" })],
      pages: [page({ components: names.map((name, i) => component({ id: `c${i}`, name, inApp: true, monitorIds: ["mon_0123456789abcdef01234567"] })) })],
    }), loadedAt: NOW, features: [], can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"],
  };
});
const widget = () => renderToStaticMarkup(createElement(WidgetScreen, { origin: "https://staygreen.io" }));
const editor = () => renderToStaticMarkup(createElement(PageEditorScreen, { id: "page_1" }));

describe("widget preview", () => {
  it("starts with a visible example, puts each preview before its explanation and installation last", () => {
    const html = widget();
    expect(html).toMatch(/panel panel-flush"><div class="wd-piece"><div class="stack-sm"><div class="host-frame/);
    expect(html.indexOf('class="sg-banner degraded"')).toBeLessThan(html.indexOf("In-app incident banner</h3>"));
    expect(html).toContain("Example banner only, with a made-up update.");
    expect(html).toContain("All is well, so your users see no banner.");
    expect(html).not.toContain("Live: the banner");
    expect(html.indexOf('class="wd-readme"')).toBeLessThan(html.indexOf("README badge</h3>"));
    expect(html.indexOf('class="sg-pill"')).toBeLessThan(html.indexOf("Status pill</h3>"));
    expect(html.indexOf("Status pill</h3>")).toBeLessThan(html.indexOf("Add to your app</h3>"));
    expect(html.match(/Add to your app<\/h3>/g)).toHaveLength(1);
    expect(html.indexOf("Your users see a banner")).toBeLessThan(html.indexOf("Put the banner slot"));
    expect(html).toContain("Banner enabled for: Website, Database, API.");
  });
  it("groups the picker on the left, before the Preview heading", () => {
    feed.workspace!.pages.push(page({ id: "page_2", slug: "second" }));
    expect(widget()).toMatch(/class="section-head"><div class="cluster grow"><div class="field wd-pick">[\s\S]*<\/select><\/div><h2 id="pv-h"/);
  });
  it("uses a published live banner when there is one and never offers private-page previews", () => {
    feed.workspace!.monitors[0].state = "down";
    feed.workspace!.incidents = [incident({ id: "inc_1", monitorId: feed.workspace!.monitors[0].id, notes: [note({ id: "note_1", text: "Published recovery update" })] })];
    expect(widget()).toContain("Published recovery update");
    expect(widget()).toContain("Live: the banner");
    expect(widget()).not.toContain("made-up update");
    feed.workspace!.pages[0].membersOnly = true;
    const privateHtml = widget();
    expect(privateHtml).toContain("Members-only page");
    expect(privateHtml).not.toContain('class="sg-banner');
    expect(privateHtml).not.toContain("Copy embed");
  });
});

describe("editor controls", () => {
  it("copies the saved Staygreen address separately from the custom-domain page head", () => {
    feed.workspace!.pages[0].domain = { host: "status.example.com", name: "status", cnameTarget: `${"a".repeat(32)}.domains.staygreen.io`, step: 4, startedAt: NOW };
    const html = editor();
    expect(html).toContain('data-copies="https://status.example.com">Copy address');
    expect(html).toContain('data-copies="https://status.staygreen.io/example">Copy Staygreen address');
  });
  it("copies the members-only address, which the status host does not serve", () => {
    feed.workspace!.pages[0].membersOnly = true;
    const html = editor();
    expect(html).toContain('data-copies="https://staygreen.io/s/example">Copy Staygreen address');
    expect(html).not.toContain('data-copies="https://status.staygreen.io/example">Copy Staygreen address');
  });
  it("starts every section expanded with a named toggle right after its heading", () => {
    const html = editor();
    for (const [id, title] of [["pe-brand", "Branding"], ["pe-addr", "Address"], ["pe-domain", "Your own domain"], ["pe-comps", "Components"], ["pe-opts", "Options"]]) {
      expect(html).toContain(`<h2 id="${id}" class="t-section">${title}</h2><button`);
      expect(html).toContain(`aria-label="Collapse ${title}" aria-expanded="true" aria-controls="${id}-content"`);
    }
    expect(html).toContain('aria-label="Move Website up" aria-disabled="true"');
    expect(html).toContain('aria-label="Move Database up" aria-disabled="false"');
    expect(html).toContain('aria-label="Move API down" aria-disabled="true"');
  });
  it("keeps collapsed children mounted but hidden, without hiding the toggle", () => {
    const html = renderToStaticMarkup(createElement(CollapsibleSection, { id: "section", title: "Branding", expanded: false, onToggle: vi.fn(), children: createElement("input", { defaultValue: "unsaved" }) }));
    expect(html).toContain('aria-label="Expand Branding" aria-expanded="false" aria-controls="section-content"');
    expect(html).toContain('<div id="section-content" hidden=""><input value="unsaved"/></div>');
  });
});

it("keeps saved order through the public DTO, HTML and summary; preview and widget use the same order", () => {
  const p = feed.workspace!.pages[0];
  const raw = { page: { ...p, historyDays: p.showHistoryDays }, components: names.map((name, i) => ({ key: i, name, inApp: true, states: ["up"], daily: [] })), incidents: [] };
  for (const view of [viewFromDto(snapshotDto.parse(raw), NOW), viewFromSim(feed.workspace!, p)]) {
    expect(summaryFor(view).components.map(c => c.name)).toEqual(names);
    const html = renderToStaticMarkup(createElement(StatusPageView, { view }));
    const orderedNames = [...html.matchAll(/class="sp-comp-name">([^<]+)</g)].map(match => match[1]);
    expect(orderedNames).toEqual(names);
  }
  expect(widget()).toContain("Banner enabled for: Website, Database, API.");
});
