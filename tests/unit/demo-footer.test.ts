import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusPageView } from "@/components/status/StatusPageView";
import { snapshotDto, viewFromDto, viewFromSim } from "@/lib/public-page";
import { EdgeCache } from "../../edge/cache";
import { page, sim } from "./fixtures";

describe("demo footer in both renderers", () => {
  it.each([false, true])("renders the owner's exact copy when demo=%s and leaves badge/summary alone", demo => {
    const snapshot = { page: { ...viewFromSim(sim(), page()).page, demo }, components: [], incidents: [] };
    const view = viewFromDto(snapshotDto.parse(snapshot), 0);
    const cache = new EdgeCache("status.staygreen.test", "https://staygreen.test");
    cache.replace([{ pageId: "page_demo", version: 0, domain: null, assets: [], snapshot }], 1);
    const html = renderToStaticMarkup(createElement(StatusPageView, { view, appUrl: "https://staygreen.test" }));
    const edge = String(cache.respond("status.staygreen.test", `/${view.page.slug}`, 1).body);
    for (const rendered of [html, edge]) {
      if (demo) {
        expect(rendered).toContain('A demo created by the <a href="https://staygreen.test/" class="link">Staygreen</a> team. Clone and manage it in your account:');
        expect(rendered).toContain(`href="https://staygreen.test/app/clone/${view.page.slug}">Clone status page`);
        expect(rendered).toContain("Next, you can add extra monitors (Supabase, Stripe, webhooks etc.)");
        expect(rendered).not.toContain("Powered by Staygreen");
      } else { expect(rendered).toContain("Powered by Staygreen"); expect(rendered).not.toContain("Clone status page"); }
    }
    for (const suffix of ["/summary.json", "/badge.svg"]) expect(String(cache.respond("status.staygreen.test", `/${view.page.slug}${suffix}`, 1).body)).not.toContain("Clone status page");
  });
  it("a demo footer takes precedence over white labelling; a non-demo without the mark has no CTA", () => {
    for (const demo of [false, true]) {
      const view = viewFromSim(sim({ plan: "builder" }), page({ demo, poweredBy: false }));
      const html = renderToStaticMarkup(createElement(StatusPageView, { view }));
      expect(html).not.toContain("Powered by Staygreen");
      expect(html.includes("Clone status page")).toBe(demo);
    }
    expect(viewFromSim(sim(), page({ demo: true, membersOnly: true })).page.demo).toBe(false);
  });
});
