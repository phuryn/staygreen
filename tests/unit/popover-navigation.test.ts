import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuilderTag } from "@/components/Tags";

// The real component's effects, with the browser's frame queue and elements substituted.
// Native dismissal and the actual route handoff are covered by journeys.auth.spec.ts.
const hooks = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  refs: [] as { current: unknown }[],
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useRef: (current: unknown) => { const ref = { current }; hooks.refs.push(ref); return ref; },
}));

let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  hooks.effects = []; hooks.refs = [];
  frames = new Map();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());
const paint = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach((f) => f(0)); };

function mount(props: Parameters<typeof BuilderTag>[0]) {
  renderToStaticMarkup(createElement(BuilderTag, props));
  const trigger = { scrollIntoView: vi.fn() };
  const pop = { matches: vi.fn(() => false), showPopover: vi.fn() };
  hooks.refs[0].current = trigger;
  hooks.refs[1].current = pop;
  const cleanup = hooks.effects[0]();
  return { trigger, pop, cleanup };
}

describe("a Builder offer requested by navigation", () => {
  it("opens after the old interaction and layout, with its control in view first", () => {
    const { trigger, pop } = mount({ open: true });
    expect(pop.showPopover).not.toHaveBeenCalled();
    paint();
    expect(trigger.scrollIntoView).toHaveBeenCalledOnce();
    expect(pop.showPopover).toHaveBeenCalledOnce();
    expect(trigger.scrollIntoView.mock.invocationCallOrder[0]).toBeLessThan(pop.showPopover.mock.invocationCallOrder[0]);
  });

  it("does not open an offer after leaving the screen or withdrawing the request", () => {
    const { pop, cleanup } = mount({ open: true });
    cleanup?.();
    paint();
    expect(pop.showPopover).not.toHaveBeenCalled();
  });

  it("does not reopen an offer the member already opened", () => {
    const { trigger, pop } = mount({ open: true });
    pop.matches.mockReturnValue(true);
    paint();
    expect(trigger.scrollIntoView).not.toHaveBeenCalled();
    expect(pop.showPopover).not.toHaveBeenCalled();
  });

  it.each([{ open: false }, { open: true, locked: false }])("does nothing without a gated request: %j", (props) => {
    const { pop } = mount(props);
    paint();
    expect(pop.showPopover).not.toHaveBeenCalled();
  });
});
