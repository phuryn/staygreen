import { beforeEach, expect, it, vi } from "vitest";
import { PageDomain } from "@/components/PageDomain";
import { page } from "./fixtures";

// The hook-store seam of the editor's interaction test, with effects kept so the one that opens
// the panel can be run. The panel's error text lives inside content that is hidden when it is
// collapsed, so a refusal that arrives after the builder collapsed it must open it again.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as Array<() => void> }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[slot], (value: unknown) => { hooks.slots[slot] = typeof value === "function" ? value(hooks.slots[slot]) : value; }];
  },
  useRef: (initial: unknown) => hooks.slots[hooks.cursor++] ??= { current: initial },
  useEffect: (run: () => void) => { hooks.effects.push(run); },
}));
vi.mock("@/lib/workspace-store", () => ({ useActs: () => ({ verifyPageDomain: vi.fn() }) }));

// Hook slots in declaration order: the dialog ref, host, expanded, error.
const EXPANDED = 2, ERROR = 3;
const render = () => {
  hooks.cursor = 0; hooks.effects = [];
  return PageDomain({ page: page({}), canVerify: false });
};

beforeEach(() => { hooks.slots = []; hooks.cursor = 0; hooks.effects = []; });

it("opens a collapsed panel when a domain action is refused, and leaves it alone otherwise", () => {
  render();
  hooks.slots[EXPANDED] = false;
  render();
  hooks.effects[0]();
  expect(hooks.slots[EXPANDED]).toBe(false);

  hooks.slots[ERROR] = "Too many checks. Try again in a minute.";
  render();
  hooks.effects[0]();
  expect(hooks.slots[EXPANDED]).toBe(true);
});
