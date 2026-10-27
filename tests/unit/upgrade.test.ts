import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BuilderTag } from "@/components/Tags";
import { demoLimits, limits, locations } from "@/lib/plans";
import { addAppGate, offers, upgradeAction } from "@/lib/upgrade";

/* The Builder mark (`design/README.md`, principle 8): what each offer says, where it leads, and
   how the one primitive draws a tag, a held feature and a gated control. Every number an offer
   names is read here from the plan module, so a change of limits that leaves a sentence behind
   fails. */

const F = limits.free;
const B = limits.builder;
const render = (props: Parameters<typeof BuilderTag>[0]) => renderToStaticMarkup(createElement(BuilderTag, props));

describe("offers", () => {
  it("names Free's and Builder's own numbers", () => {
    expect(offers.apps.body).toBe(`Free includes one app. Builder includes ${B.apps}, each with its own monitors and status page.`);
    expect(F.apps).toBe(1);
    expect(offers.statusPages.body).toContain(`Builder includes ${B.statusPages}`);
    expect(offers.assertions.body).toBe(`Free checks up to ${F.assertions} assertions on an HTTP monitor. Builder checks up to ${B.assertions}.`);
    expect(offers.heartbeatAssertions.body).toContain(`Builder checks up to ${B.heartbeatAssertions}`);
    expect(offers.api.body).toContain(`${B.apiPerMin} calls a minute`);
    expect(offers.api.body).toContain(`Free allows ${F.apiPerMin}`);
    expect(offers.history.body).toContain(B.historyLabel);
    expect(offers.history.body).toContain(F.historyLabel);
    expect(offers.builder.body).toContain(`${B.apps} apps`);
    expect(offers.builder.body).toContain(`${B.monitors} monitors`);
  });

  it("names every location each plan checks from, and how often each plan checks", () => {
    for (const id of B.locations) expect(offers.location.body).toContain(locations[id].city);
    expect(offers.location.body).toMatch(/^Builder adds .+, and checks every minute instead of every 3 minutes\.$/);
    expect([F.httpIntervalMin, B.httpIntervalMin]).toEqual([3, 1]);
    // Frankfurt's probe runs, so neither offer calls it Coming soon.
    expect(offers.location.body).toContain("Frankfurt, in Europe, to Toronto and San Francisco");
    expect(offers.builder.body).toContain("a third location in Europe, routing");
  });

  it("offers live severity routing separately from pending alert timing and maintenance", () => {
    expect(offers.alertRules.body).toContain("Builder adds routing by severity.");
    expect(offers.alertRules.body).toContain("Alert delay and repeat while down (Coming soon)");
    expect(offers.alertRules.body).toContain("maintenance windows (Coming soon)");
    expect(offers.alertRules.body).not.toContain("They come after the channels");
  });

  it("offers history retention without promising that CSV export runs", () => {
    expect(offers.history.body).toContain(`Builder keeps ${B.historyLabel} of daily uptime.`);
    expect(offers.history.body).toContain("CSV export is Coming soon.");
    expect(offers.history.body).not.toContain("exports it as CSV");
  });

  it("gives every offer a title that says Builder and a body that ends a sentence", () => {
    for (const [key, o] of Object.entries(offers)) {
      expect(o.title, key).toMatch(/Builder/);
      expect(o.body, key).toMatch(/[.]$/);
    }
  });
});

describe("upgradeAction", () => {
  it("leads to the billing page, and says nothing charges until billing ships", () => {
    expect(upgradeAction(false)).toEqual({ label: "See Builder", href: "/app/billing", note: "Builder isn’t on sale yet, so nothing here charges you." });
    expect(upgradeAction(true)).toEqual({ label: "Upgrade to Builder", href: "/app/billing", note: null });
  });
});

describe("addAppGate", () => {
  const apps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `app_${i}` }));
  it("is open below the plan's limit", () => {
    expect(addAppGate({ plan: "free", apps: [] })).toBe("open");
    expect(addAppGate({ plan: "builder", apps: apps(B.apps - 1) })).toBe("open");
  });
  it("is Builder's to lift on Free at its one app, and on a Free workspace past it", () => {
    expect(addAppGate({ plan: "free", apps: apps(F.apps) })).toBe("builder");
    expect(addAppGate({ plan: "free", apps: apps(3) })).toBe("builder");
  });
  it("is full on Builder at its own limit, which nothing lifts", () => {
    expect(addAppGate({ plan: "builder", apps: apps(B.apps) })).toBe("full");
  });
  it("follows the session's limits when the snapshot carries them, as the owner's demo plan does", () => {
    expect(addAppGate({ plan: "builder", limits: demoLimits, apps: apps(B.apps) })).toBe("open");
    expect(addAppGate({ plan: "builder", limits: demoLimits, apps: apps(demoLimits.apps) })).toBe("full");
  });
});

describe("BuilderTag", () => {
  it("draws a cobalt tag with the crown that opens what Builder adds there", () => {
    const html = render({ offer: "location", id: "o" });
    expect(html).toMatch(/<button type="button" class="tag tag-builder" popoverTarget="o" aria-haspopup="dialog"><svg[^>]*builder-mark[^>]*>.*<\/svg>Builder<\/button>/);
    expect(html).toContain(`popover="auto" role="dialog" aria-labelledby="o-title"`);
    expect(html).toContain(`<strong id="o-title" class="builder-offer-title">${offers.location.title}</strong>`);
    expect(html).toContain(offers.location.body);
    expect(html).toContain(`href="/app/billing"`);
    expect(html).toContain("Not now");
  });

  it("keeps a gated control's own class and label, with the crown before the label", () => {
    const html = render({ offer: "apps", control: "btn", children: "Add another app" });
    expect(html).toMatch(/<button type="button" class="btn builder-control" popoverTarget="[^"]+" aria-haspopup="dialog"><svg[^>]*builder-mark[^>]*>.*<\/svg>Add another app<span class="sr-only"> \(Builder\)<\/span><\/button>/);
    expect(html).toContain(offers.apps.body);
  });

  it("says only where a held feature came from: a quiet tag, no crown, nothing to open", () => {
    expect(render({ locked: false, offer: "history" })).toBe(`<span class="tag">Builder</span>`);
  });

  it("is built of spans, so it can sit inside a heading or a sentence", () => {
    const html = render({ offer: "history" });
    expect(html).not.toMatch(/<(div|p)\b/);
  });

  it("falls back to the general offer where a place names none", () => {
    expect(render({})).toContain(offers.builder.body);
  });
});
