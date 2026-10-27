import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StateBadge } from "@/components/State";
import type { State } from "@/lib/model";

/* The badge a visitor reads on a status page (`publicFacing`), and the one the dashboard shows.
   Green means up and nothing else (design/README.md § Principles): a paused component is not
   checked, so it can't be called operational. */

const badge = (state: State, publicFacing?: boolean) => renderToStaticMarkup(createElement(StateBadge, { state, publicFacing }));
const STATES: State[] = ["up", "degraded", "down", "paused", "unchecked"];

describe("StateBadge", () => {
  it.each(STATES)("draws %s with its own shape and colour, on a public page as on the dashboard", (state) => {
    for (const html of [badge(state), badge(state, true)]) {
      expect(html).toContain(`class="state ${state}"`);
      expect(html).toContain(`state-icon ${state}`);
    }
  });

  it("calls only an up component operational", () => {
    for (const state of STATES) expect(badge(state, true).includes("Operational")).toBe(state === "up");
  });

  it("says a paused component is paused", () => {
    expect(badge("paused", true)).toContain(">Paused<");
  });
});
