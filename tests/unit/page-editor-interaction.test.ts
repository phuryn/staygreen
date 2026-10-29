import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { PageEditorScreen } from "@/app/(app)/app/status-pages/[id]/PageEditorScreen";
import { Copy } from "@/components/Copy";
import { PERMISSIONS } from "@/lib/authz";
import type { Workspace } from "@/lib/workspace-store";
import { component, NOW, page, sim } from "./fixtures";

// The existing interaction harness's hook-store seam: real editor handlers and draft,
// fake React rendering/navigation/actions. Native focus and hiding belong to the auth E2E.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));
const fake = vi.hoisted(() => ({ workspace: null as Workspace | null, savePage: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[slot], (value: unknown) => { hooks.slots[slot] = typeof value === "function" ? value(hooks.slots[slot]) : value; }];
  },
  useRef: (initial: unknown) => hooks.slots[hooks.cursor++] ??= { current: initial },
  useMemo: (run: () => unknown) => run(), useEffect: vi.fn(), useLayoutEffect: vi.fn(),
}));
vi.mock("@/lib/workspace-store", () => ({ useWorkspace: () => fake.workspace, useActs: () => ({ savePage: fake.savePage }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const get = (tree: ReactNode, match: (el: Element) => boolean) => {
  const found = elements(tree).find(match);
  if (!found) throw new Error("Control not found");
  return found;
};
const invoke = (el: Element): ReactNode => (el.type as (p: Record<string, unknown>) => ReactNode)(el.props);
const render = () => {
  hooks.cursor = 0;
  // Follow the workspace and permission wrappers into the form without reimplementing it.
  return invoke(invoke(PageEditorScreen({ id: "page_1" }) as Element) as Element);
};
const part = (name: string) => get(render(), el => typeof el.type === "function" && el.type.name === name);
const setDraft = (patch: unknown) => (part("Address").props.set as (patch: unknown) => void)(patch);
const toggle = (name: string) => (part(name).props.onToggle as () => void)();
const save = async () => {
  const button = get(render(), el => el.type === "button" && el.props.children === "Save changes");
  await (button.props.onClick as () => Promise<void>)();
};

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; vi.clearAllMocks();
  fake.savePage.mockResolvedValue({ ok: true });
  fake.workspace = { ...sim({ pages: [page({ components: [component({ id: "c1", name: "API" }), component({ id: "c2", name: "Website" })] })] }),
    loadedAt: NOW, features: [], can: Object.fromEntries(PERMISSIONS.map(p => [p, true])) as Workspace["can"] };
});

it("shows Demo page only for scale_demo, keeps demo/private mutually exclusive, and lets Free publish its private copy", () => {
  const options = () => invoke(part("Options"));
  expect(elements(options()).some(el => el.props["aria-describedby"] === "pe-sw-demo")).toBe(false);
  fake.workspace!.demoAllowed = true;
  expect(get(options(), el => el.props["aria-describedby"] === "pe-sw-demo").props.checked).toBe(false);
  setDraft({ demo: true });
  expect(get(options(), el => el.props["aria-describedby"] === "pe-sw-members").props.disabled).toBe(true);
  setDraft({ demo: false, membersOnly: true });
  expect(get(options(), el => el.props["aria-describedby"] === "pe-sw-demo").props.disabled).toBe(true);
  fake.workspace!.demoAllowed = false;
  const members = get(options(), el => el.props["aria-describedby"] === "pe-sw-members");
  expect(members.props.disabled).toBe(false);
  (members.props.onChange as (e: unknown) => void)({ target: { checked: false } });
  expect(get(options(), el => el.props["aria-describedby"] === "pe-sw-members").props.checked).toBe(false);
});

it("retains unsaved edits through collapse, reveals local field errors and makes no invalid save", async () => {
  setDraft({ name: "", slug: "new-address", components: [{ key: "stable", name: "", monitorIds: [], inApp: true }] });
  for (const name of ["Branding", "Address", "Components", "Options"]) toggle(name);
  expect(part("Address").props.expanded).toBe(false);
  await save();
  expect(fake.savePage).not.toHaveBeenCalled();
  expect(part("Branding").props.expanded).toBe(true);
  expect(part("Components").props.expanded).toBe(true);
  expect(part("Address").props.expanded).toBe(false);
  expect(part("Options").props.expanded).toBe(false);
  expect(part("Address").props.draft).toMatchObject({ slug: "new-address" });
});

it("opens server field errors even if their sections were collapsed during the save", async () => {
  let finish!: (answer: unknown) => void;
  fake.savePage.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  setDraft({ slug: "taken-address" });
  const pending = save();
  toggle("Address"); toggle("Options");
  finish({ ok: false, reason: "Check fields", fieldErrors: { slug: "Taken", membersOnly: "Unavailable" } });
  await pending;
  expect(part("Address").props.expanded).toBe(true);
  expect(part("Options").props.expanded).toBe(true);
  expect(part("Address").props.errors).toMatchObject({ slug: "Taken" });
});

it("hides Copy for an unsaved slug and changes its destination only after a successful save", async () => {
  const address = () => invoke(part("Address"));
  const copies = () => elements(address()).filter(el => el.type === Copy);
  expect(copies()[0].props.text).toBe("https://status.staygreen.io/example");
  setDraft({ slug: "new-address" });
  expect(copies()).toHaveLength(0);
  fake.savePage.mockResolvedValueOnce({ ok: false, reason: "Try again" });
  await save();
  expect(copies()).toHaveLength(0);
  await save();
  expect(copies()[0].props.text).toBe("https://status.staygreen.io/new-address");
});

it("saves a reordered draft in order and discards a later move back to that saved order", async () => {
  const components = [{ key: "c2", name: "Website", monitorIds: [], inApp: true }, { key: "c1", name: "API", monitorIds: [], inApp: false }];
  setDraft({ components });
  await save();
  expect(fake.savePage).toHaveBeenCalledWith("page_1", expect.objectContaining({ components: components.map(({ key: _key, ...c }) => c) }));
  setDraft({ components: [...components].reverse() });
  const discard = get(render(), el => el.type === "button" && el.props.children === "Discard");
  (discard.props.onClick as () => void)();
  expect(part("Components").props.draft).toMatchObject({ components });
});
