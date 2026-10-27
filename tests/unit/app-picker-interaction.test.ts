import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPicker } from "@/components/AppPicker";

// The real component handlers/effects over the repo's hook-store pattern. DOM focus, geometry
// and native popover events are the boundary fakes; the authenticated suite covers the browser.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useId: () => "picker-list",
  useRef: (initial: unknown) => hooks.slots[hooks.cursor++] ??= { current: initial },
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = initial;
    return [hooks.slots[slot], (value: unknown) => { hooks.slots[slot] = value; }];
  },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));
type Element = ReactElement<Record<string, any>>;
const elements = (node: ReactNode): Element[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
};
class FakeNode {}
const doc = { activeElement: null as unknown, addEventListener: vi.fn(), removeEventListener: vi.fn() };
const win = { innerHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn() };
const apps = ["Alpha", "Beacon", "Brook", "Zulu"].map((name, i) => ({ id: `app_${i}`, name, logoUrl: null }));
beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = [];
  vi.clearAllMocks(); doc.activeElement = null;
  vi.stubGlobal("Node", FakeNode); vi.stubGlobal("document", doc); vi.stubGlobal("window", win);
});
afterEach(() => vi.unstubAllGlobals());

function mount(overrides: Partial<Parameters<typeof AppPicker>[0]> = {}) {
  const onChange = vi.fn();
  let props = { id: "app", apps, value: "app_1", onChange, allApps: true, ...overrides };
  let tree: Element[];
  let opened = false;
  const trigger = Object.assign(new FakeNode(), {
    focus: vi.fn(() => { doc.activeElement = trigger; }),
    getBoundingClientRect: vi.fn(() => ({ left: 16, top: 480, bottom: 520, width: 240 })),
  });
  const options = () => tree.filter(el => el.props.role === "option");
  const optionNodes = () => options().map(el => nodes.get(el.key));
  const nodes = new Map<React.Key | null, FakeNode>();
  const list = Object.assign(new FakeNode(), {
    style: {},
    matches: () => opened,
    querySelectorAll: () => optionNodes(),
    contains: (target: unknown) => target === list || optionNodes().includes(target as FakeNode),
    showPopover: vi.fn(() => {
      const preventDefault = vi.fn();
      listProps().onBeforeToggle({ newState: "open", currentTarget: list, preventDefault });
      if (preventDefault.mock.calls.length) return;
      opened = true;
      listProps().onToggle({ newState: "open" });
    }),
    hidePopover: vi.fn(() => { opened = false; listProps().onToggle({ newState: "closed" }); }),
  });
  const triggerProps = () => tree.find(el => el.props.id === "app")!.props;
  const listProps = () => tree.find(el => el.props.role === "listbox")!.props;
  const paint = (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next }; hooks.cursor = 0; hooks.effects = [];
    tree = elements(AppPicker(props));
    triggerProps().ref.current = trigger; listProps().ref.current = list;
    options().forEach(el => {
      if (nodes.has(el.key)) return;
      const node = Object.assign(new FakeNode(), {
        focus: vi.fn(() => { doc.activeElement = node; }), scrollIntoView: vi.fn(),
      });
      nodes.set(el.key, node);
    });
  };
  paint();
  function key(key: string, inList = true, modifiers = {}) {
    const event = { key, nativeEvent: {}, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...modifiers };
    (inList ? listProps() : triggerProps()).onKeyDown(event);
    return event;
  }
  const open = () => triggerProps().onClick({ preventDefault: vi.fn() });
  return { onChange, trigger, list, paint, key, triggerProps, listProps, options, open,
    isOpen: () => opened, focused: () => optionNodes().indexOf(doc.activeElement as FakeNode) };
}

describe("AppPicker's keyboard and focus model", () => {
  it("opens on the selection, moves without committing, and clamps arrows at the ends", () => {
    const p = mount(); p.open(); p.paint();
    expect(p.triggerProps()["aria-expanded"]).toBe(true);
    expect(p.focused()).toBe(2);
    p.key("ArrowDown"); expect(p.focused()).toBe(3);
    p.key("End"); p.key("ArrowDown"); expect(p.focused()).toBe(4);
    p.key("Home"); p.key("ArrowUp"); expect(p.focused()).toBe(0);
    expect(p.onChange).not.toHaveBeenCalled();
    p.key("Enter");
    expect(p.onChange).toHaveBeenCalledExactlyOnceWith("all");
    expect(p.isOpen()).toBe(false);
    expect(doc.activeElement).toBe(p.trigger);
  });

  it.each([["ArrowDown", 3], ["ArrowUp", 1], ["Home", 0], ["End", 4], ["b", 3]] as const)("%s opens from the trigger at option %i", (key, index) => {
    const p = mount(); expect(p.key(key, false).preventDefault).toHaveBeenCalledOnce();
    expect(p.isOpen()).toBe(true); expect(p.focused()).toBe(index);
  });

  it("cycles first letters case-insensitively and leaves unmatched/modified keys alone", () => {
    const p = mount(); p.open();
    p.key("b"); expect(p.focused()).toBe(3);
    p.key("B"); expect(p.focused()).toBe(2);
    expect(p.key("x").preventDefault).not.toHaveBeenCalled(); expect(p.focused()).toBe(2);
    expect(p.key("End", true, { ctrlKey: true }).preventDefault).not.toHaveBeenCalled();
    expect(p.key("a", true, { nativeEvent: { isComposing: true } }).preventDefault).not.toHaveBeenCalled();
    expect(p.focused()).toBe(2);
  });

  it.each(["Escape", "Tab"])("%s dismisses without changing the value and restores the trigger", key => {
    const p = mount(); p.open(); p.key("End"); const event = p.key(key);
    expect(p.isOpen()).toBe(false); expect(doc.activeElement).toBe(p.trigger);
    expect(p.onChange).not.toHaveBeenCalled();
    if (key === "Escape") expect(event.stopPropagation).toHaveBeenCalledOnce();
    else expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("closes without a change when the app already shown is chosen again", () => {
    const p = mount(); p.open(); p.key("Enter");
    expect(p.onChange).not.toHaveBeenCalled();
    p.open(); p.options()[2].props.onClick();
    expect(p.onChange).not.toHaveBeenCalled();
    expect(p.isOpen()).toBe(false);
    expect(doc.activeElement).toBe(p.trigger);
  });

  it("commits Space and pointer selections exactly once", () => {
    const p = mount(); p.open(); p.key("End"); p.key(" ");
    expect(p.onChange).toHaveBeenCalledExactlyOnceWith("app_3");
    p.onChange.mockClear(); p.open(); p.options()[1].props.onClick();
    expect(p.onChange).toHaveBeenCalledExactlyOnceWith("app_0");
    expect(doc.activeElement).toBe(p.trigger);
  });

  it.each([{ disabled: true }, { apps: [], allApps: false }])("refuses an unavailable picker: %j", overrides => {
    const p = mount(overrides); p.open(); p.key("End", false);
    expect(p.triggerProps().disabled).toBe(true); expect(p.isOpen()).toBe(false);
    p.options()[0]?.props.onClick(); expect(p.onChange).not.toHaveBeenCalled();
  });

  it("closes when it becomes disabled, and syncs ARIA after native light dismissal", () => {
    const p = mount(); p.open(); p.paint({ disabled: true }); hooks.effects[1]();
    expect(p.isOpen()).toBe(false); p.paint(); expect(p.triggerProps()["aria-expanded"]).toBe(false);
  });

  it("focuses before a queued toggle event and never pulls focus back after Tab", () => {
    const p = mount();
    // Do not deliver toggle yet: this is the browser's asynchronous notification boundary.
    p.list.showPopover.mockImplementation(() => {});
    p.open(); expect(p.focused()).toBe(2);
    p.key("Tab"); expect(doc.activeElement).toBe(p.trigger);
    const nextControl = new FakeNode(); doc.activeElement = nextControl;
    p.listProps().onToggle({ newState: "open" });
    expect(doc.activeElement).toBe(nextControl);
  });

  it("keeps the list open through trigger focus so a second trigger click closes it", () => {
    const p = mount(); p.open();
    p.listProps().onBlur({ relatedTarget: p.trigger, currentTarget: p.list });
    expect(p.isOpen()).toBe(true);
    p.triggerProps().onClick({ preventDefault: vi.fn() });
    expect(p.isOpen()).toBe(false); expect(doc.activeElement).toBe(p.trigger);
    expect(p.onChange).not.toHaveBeenCalled();
  });

  it("positions above a low trigger and preserves scrolling inside the list or under an unmoved anchor", () => {
    const p = mount(); const cleanup = hooks.effects[0](); p.open();
    expect(p.list.style).toMatchObject({ left: "16px", width: "240px", top: "auto", bottom: "120px" });
    const scroll = doc.addEventListener.mock.calls.find(([type]) => type === "scroll")![1];
    scroll({ type: "scroll", target: p.list }); expect(p.isOpen()).toBe(true);
    scroll({ type: "scroll", target: doc }); expect(p.isOpen()).toBe(true);
    p.trigger.getBoundingClientRect.mockReturnValue({ left: 16, top: 440, bottom: 480, width: 240 });
    scroll({ type: "scroll", target: doc }); expect(p.isOpen()).toBe(false);
    cleanup?.(); expect(doc.removeEventListener).toHaveBeenCalledWith("scroll", scroll, true);
  });
});
