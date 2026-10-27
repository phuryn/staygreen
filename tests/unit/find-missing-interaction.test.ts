import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { AppAddressForm } from "@/app/(app)/app/apps/[id]/checks/ChecksScreen";
import { SuggestedChecks, SuggestedChecksResult } from "@/components/SuggestedChecks";
import type { Suggestions } from "@/lib/suggestions";

// Component handlers/effects are real; a tiny hook store stands in for React's browser renderer.
// These tests prove save/scan ordering and selections, not native navigation or layout.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
const acts = vi.hoisted(() => ({ updateApp: vi.fn(), suggestChecks: vi.fn(), addSuggestedChecks: vi.fn(), toast: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const slot = hooks.cursor++;
    if (!(slot in hooks.slots)) hooks.slots[slot] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[slot], (value: unknown) => { hooks.slots[slot] = typeof value === "function" ? value(hooks.slots[slot]) : value; }];
  },
  useRef: (initial: unknown) => {
    const slot = hooks.cursor++;
    return hooks.slots[slot] ??= { current: initial };
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
vi.mock("@/lib/workspace-store", () => ({ useActs: () => acts }));
vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));
const app = { id: "app_a", name: "Harbor", url: "", logoUrl: null, blurb: "", channelIds: [] };
const found: Suggestions = {
  address: "https://example.com/", reached: true,
  http: [{ kind: "http", url: "https://example.com/", root: true, name: "Website", ok: true, ticked: true }],
  ssl: null, icon: null, accent: null, supabase: null,
};
const render = (component: () => ReactNode) => { hooks.cursor = 0; hooks.effects = []; return component(); };
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const get = (tree: ReactNode, match: (el: Element) => boolean) => {
  const el = elements(tree).find(match);
  if (!el) throw new Error("Control not found");
  return el;
};
const submit = async (tree: ReactNode) => {
  const form = get(tree, el => el.type === "form");
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: vi.fn() });
};
const changeUrl = (tree: ReactNode, value: string) => {
  const input = get(tree, el => el.type === "input");
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
};

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = [];
  vi.clearAllMocks();
  acts.updateApp.mockResolvedValue({ ok: true });
  acts.suggestChecks.mockResolvedValue({ ok: true, suggestions: found });
  acts.addSuggestedChecks.mockResolvedValue({ ok: true, added: 1 });
});

it("saves a valid address before offering checks, and blocks a second submit while saving", async () => {
  const onSaved = vi.fn();
  const paint = () => render(() => AppAddressForm({ app, onSaved }));
  let finish!: (result: { ok: true }) => void;
  acts.updateApp.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  changeUrl(paint(), " https://example.com/ ");
  const saving = submit(paint());
  expect(acts.updateApp).toHaveBeenCalledWith(app.id, { name: app.name, url: "https://example.com/" });
  expect(onSaved).not.toHaveBeenCalled();
  expect(get(paint(), el => el.type === "button").props.disabled).toBe(true);
  await submit(paint());
  expect(acts.updateApp).toHaveBeenCalledOnce();
  finish({ ok: true });
  await saving;
  expect(onSaved).toHaveBeenCalledWith("https://example.com/");
});

it.each(["", "not a url", "https://user:secret@example.com/"])("refuses %j without saving or starting checks", async value => {
  const onSaved = vi.fn();
  const paint = () => render(() => AppAddressForm({ app, onSaved }));
  changeUrl(paint(), value);
  await submit(paint());
  expect(get(paint(), el => el.type === "input").props["aria-invalid"]).toBe(true);
  expect(acts.updateApp).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
});

it("keeps a server save refusal on the address form without scanning", async () => {
  const onSaved = vi.fn();
  const paint = () => render(() => AppAddressForm({ app, onSaved }));
  acts.updateApp.mockResolvedValue({ ok: false, reason: "That isn't here any more. Reload the page." });
  changeUrl(paint(), "https://example.com/");
  await submit(paint());
  expect(get(paint(), el => el.props.role === "alert").props.children).toContain("Reload");
  expect(onSaved).not.toHaveBeenCalled();
  expect(acts.suggestChecks).not.toHaveBeenCalled();
});

it("requests a scan by app id only, once even when the mounting effect is repeated", async () => {
  render(() => SuggestedChecks({ appId: app.id, address: "https://browser.example/", skip: null, onDone: vi.fn() }));
  hooks.effects[0](); hooks.effects[0]();
  await Promise.resolve();
  expect(acts.suggestChecks).toHaveBeenCalledExactlyOnceWith(app.id);
});

it("adds only ticked missing checks, excluding covered and unticked ones; DNS starts unticked and is added once ticked", async () => {
  const assertion = { path: "$.status", op: "==" as const, value: "ok" };
  const s: Suggestions = { ...found, http: [
    { ...found.http[0], watched: true, assertions: [assertion] },
    { ...found.http[0], url: "https://example.com/health", root: false, assertions: [assertion] },
    { ...found.http[0], url: "https://example.com/up", root: false, ticked: false, assertions: [assertion] },
  ], dns: [{ kind: "dns", record: "NS", recordName: "example.com", expected: "ns.example.net", name: "Nameservers", purpose: "DNS changes" }] };
  const onDone = vi.fn();
  const paint = () => render(() => SuggestedChecksResult({ appId: app.id, s, skip: null, onDone }));
  const dns = get(get(paint(), el => el.key === "NS example.com"), el => el.type === "input" && el.props.type === "checkbox");
  expect(dns.props.checked).toBe(false);
  (dns.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  const add = get(paint(), el => el.type === "button");
  (add.props.onClick as () => void)();
  await Promise.resolve();
  expect(acts.addSuggestedChecks).toHaveBeenCalledExactlyOnceWith(app.id, {
    urls: ["https://example.com/health"], ssl: false, dependencies: [],
    http: [{ url: "https://example.com/health", name: "Website" }], tcp: [],
    dns: [{ record: "NS", recordName: "example.com", expected: "ns.example.net", name: "Nameservers" }],
    assertions: { "https://example.com/health": [assertion] },
  });
  expect(onDone).toHaveBeenCalledOnce();
});

it("starts SMTP unticked and carries its chosen port and the API gateway status into saving", async () => {
  const s: Suggestions = { ...found, http: [{ ...found.http[0], name: "API reachable", url: "https://api.example.com/", discovered: true, expect: "404" }], tcp: [{ kind: "tcp", host: "smtp.example.com", port: 465, tls: true, name: "SMTP", ms: 2 }] };
  const paint = () => render(() => SuggestedChecksResult({ appId: app.id, s, skip: null, onDone: vi.fn() }));
  const smtp = get(get(paint(), el => el.key === "tcp smtp.example.com:465"), el => el.type === "input");
  expect(smtp.props.checked).toBe(false);
  (smtp.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
  (get(paint(), el => el.type === "button").props.onClick as () => void)();
  await Promise.resolve();
  expect(acts.addSuggestedChecks).toHaveBeenCalledWith(app.id, expect.objectContaining({ http: [{ url: "https://api.example.com/", name: "API reachable", expect: "404" }], tcp: [{ host: "smtp.example.com", port: 465, tls: true }] }));
});
