import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { installWidget } from "../../widget/client";
class Node {
  children: Node[] = []; private content = ""; mutations = 0; parent: Node | null = null;
  attrs: Record<string, string> = {}; events: Record<string, () => void> = {};
  dataset: Record<string, string> = {}; shadowRoot: Node | null = null; href = ""; target = ""; rel = "";
  constructor(public tag = "div") {}
  get textContent() { return this.content; }
  set textContent(value: string) { this.mutations++; this.content = value; this.children = []; }
  append(...nodes: Node[]) { this.mutations++; for (const node of nodes) node.parent = this; this.children.push(...nodes); }
  replaceChildren(...nodes: Node[]) { this.mutations++; this.children = nodes; }
  remove() { if (this.parent) { this.parent.mutations++; this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  attachShadow() { this.shadowRoot = new Node("shadow"); return this.shadowRoot; }
  setAttribute(key: string, value: string) { this.mutations++; this.attrs[key] = value; }
  addEventListener(key: string, fn: () => void) { this.events[key] = fn; }
  all(): Node[] { return [this, ...this.children.flatMap(c => c.all())]; }
}
const summary = () => ({ page: "test", status: "down", headline: "Outage: API", components: [{ in_app: true, status: "down" }], incident: { note: '<img src=x onerror="steal()"> Published update', update_id: "note1" }, branding: { mark: true } });
function fixture(storageFails = false, src = "https://status.staygreen.io/w.js") {
  const banner = new Node(); banner.dataset.staygreen = "banner"; const pill = new Node(); pill.dataset.staygreen = "pill";
  const fetch = vi.fn(async () => Response.json(summary()));
  const store = new Map<string, string>();
  const storage = { getItem: vi.fn((k: string) => { if (storageFails) throw Error(); return store.get(k); }), setItem: vi.fn((k: string, v: string) => { if (storageFails) throw Error(); store.set(k, v); }) };
  const doc = { currentScript: { src, dataset: { page: "test" } }, readyState: "complete", visibilityState: "visible", querySelectorAll: () => [banner, pill], createElement: (tag: string) => new Node(tag), get cookie() { throw Error("Cookies must never be read"); } };
  const win = { fetch, localStorage: storage, setTimeout, clearTimeout };
  installWidget(doc as unknown as Document, win as unknown as Window);
  return { banner, pill, doc, fetch, store, storage };
}
const text = (node: Node) => node.shadowRoot?.all().map(n => n.textContent).join(" ") ?? "";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it("uses its own script origin for summary requests and both status links", async () => {
  const f = fixture(false, "https://status-dev.example.com/w.js?v=1");
  await vi.advanceTimersByTimeAsync(1);
  expect(f.fetch).toHaveBeenCalledWith("https://status-dev.example.com/test/summary.json", expect.any(Object));
  for (const host of [f.banner, f.pill]) {
    expect(host.shadowRoot?.all().find(n => n.tag === "a")?.href).toBe("https://status-dev.example.com/test");
  }
});
it.each(["", "data:text/javascript,test", "https://user:pass@example.com/w.js"])("ignores an invalid script URL %s", async src => {
  const f = fixture(false, src); await vi.advanceTimersByTimeAsync(1);
  expect(f.fetch).not.toHaveBeenCalled(); expect(text(f.pill)).toBe("");
});
it("renders nothing until JSON, uses text nodes, polite status, a safe link and cookie-free fetch", async () => {
  const f = fixture(); expect(text(f.banner)).toBe(""); await vi.advanceTimersByTimeAsync(1);
  expect(text(f.banner)).toContain('<img src=x onerror="steal()">');
  expect(f.banner.shadowRoot?.all().some(n => n.tag === "img")).toBe(false);
  expect(f.banner.shadowRoot?.all().find(n => n.tag === "section")?.attrs).toEqual({ role: "status", "aria-live": "polite" });
  expect(f.pill.shadowRoot?.all().find(n => n.tag === "a")?.href).toBe("https://status.staygreen.io/test");
  expect(f.fetch).toHaveBeenCalledWith("https://status.staygreen.io/test/summary.json", expect.objectContaining({ credentials: "omit", referrerPolicy: "no-referrer" }));
});
it("leaves the controls and live region untouched across unchanged polls, including irrelevant summary changes", async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(1);
  const roots = [f.banner.shadowRoot!, f.pill.shadowRoot!];
  const nodes = roots.flatMap(root => root.all()); const mutations = nodes.map(node => node.mutations);
  f.fetch.mockImplementation(async () => Response.json({ ...summary(), checked_at: new Date().toISOString(), components: [{ ...summary().components[0], uptime: 98 }] }));
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.fetch).toHaveBeenCalledTimes(4);
  const current = roots.flatMap(root => root.all());
  expect(current).toHaveLength(nodes.length);
  current.forEach((node, i) => expect(node).toBe(nodes[i]));
  expect(nodes.map(node => node.mutations)).toEqual(mutations);
});
it("updates just the changed text in place, retaining the pill link, banner link, dismiss button and live region", async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(1);
  const nodes = [f.banner.shadowRoot!, f.pill.shadowRoot!].flatMap(root => root.all());
  const note = f.banner.shadowRoot!.all().find(n => n.tag === "span")!;
  const pillLink = f.pill.shadowRoot!.all().find(n => n.tag === "a")!;
  const mutations = nodes.map(node => node.mutations);
  f.fetch.mockImplementation(async () => Response.json({ ...summary(), headline: "Degraded: API", incident: { ...summary().incident, note: "Recovery in progress" } }));
  await vi.advanceTimersByTimeAsync(5000);
  const current = [f.banner.shadowRoot!, f.pill.shadowRoot!].flatMap(root => root.all());
  expect(current).toHaveLength(nodes.length);
  current.forEach((node, i) => expect(node).toBe(nodes[i]));
  expect(note.textContent).toBe("Recovery in progress"); expect(pillLink.textContent).toBe("Degraded: API");
  nodes.forEach((node, i) => expect(node.mutations).toBe(mutations[i] + (node === note || node === pillLink ? 1 : 0)));
});
it("dismisses the latest note id from the retained button, even when its text is unchanged", async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(1);
  const close = f.banner.shadowRoot!.all().find(n => n.tag === "button")!;
  const pillLink = f.pill.shadowRoot!.all().find(n => n.tag === "a")!;
  f.fetch.mockImplementation(async () => Response.json({ ...summary(), incident: { ...summary().incident, update_id: "note2" } }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.banner.shadowRoot!.all().find(n => n.tag === "button")).toBe(close);
  close.events.click();
  expect(f.storage.setItem).toHaveBeenLastCalledWith("staygreen:test:dismissed", "note2");
  await vi.advanceTimersByTimeAsync(5000); expect(text(f.banner)).toBe("");
  expect(f.pill.shadowRoot!.all().find(n => n.tag === "a")).toBe(pillLink);
});
it("updates colours and branding without replacing controls, and clears only a withdrawn banner", async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(1);
  const close = f.banner.shadowRoot!.all().find(n => n.tag === "button")!;
  const pillLink = f.pill.shadowRoot!.all().find(n => n.tag === "a")!;
  const style = f.pill.shadowRoot!.all().find(n => n.tag === "style")!;
  f.fetch.mockImplementation(async () => Response.json({ ...summary(), branding: { mark: false, link_light: "#123ABC", link_dark: "#ABC123" } }));
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.banner.shadowRoot!.all().find(n => n.tag === "button")).toBe(close);
  expect(f.pill.shadowRoot!.all().find(n => n.tag === "style")).toBe(style);
  expect(style.textContent).toContain("a{color:#123abc}"); expect(style.textContent).toContain("a{color:#abc123}");
  expect(text(f.banner)).not.toContain("Powered by Staygreen"); expect(text(f.pill)).not.toContain("Powered by Staygreen");
  f.fetch.mockImplementation(async () => Response.json({ ...summary(), incident: null }));
  await vi.advanceTimersByTimeAsync(5000); expect(text(f.banner)).toBe(""); expect(text(f.pill)).toContain("Powered by Staygreen");
  expect(f.pill.shadowRoot!.all().find(n => n.tag === "a")).toBe(pillLink);
  const mutations = f.banner.shadowRoot!.mutations;
  await vi.advanceTimersByTimeAsync(5000); expect(f.banner.shadowRoot!.mutations).toBe(mutations);
  f.fetch.mockImplementation(async () => Response.json(summary()));
  await vi.advanceTimersByTimeAsync(5000); expect(text(f.banner)).toContain("Published update");
});
it.each([false, true])("dismisses only this update and works when localStorage is blocked (%s)", async blocked => {
  const f = fixture(blocked); await vi.advanceTimersByTimeAsync(1);
  f.banner.shadowRoot!.all().find(n => n.tag === "button")!.events.click();
  expect(text(f.banner)).toBe(""); await vi.advanceTimersByTimeAsync(5000); expect(text(f.banner)).toBe("");
  f.fetch.mockImplementation(async () => Response.json({ ...summary(), incident: { ...summary().incident, update_id: "note2" } }));
  await vi.advanceTimersByTimeAsync(5000); expect(text(f.banner)).toContain("Published update");
  expect(f.storage.setItem).toHaveBeenCalledWith("staygreen:test:dismissed", "note1");
});
it("clears existing UI on failure, hides members-only responses and pauses while hidden", async () => {
  const f = fixture(); await vi.advanceTimersByTimeAsync(1); expect(text(f.pill)).toContain("Outage");
  f.fetch.mockResolvedValue(new Response(null, { status: 404 })); await vi.advanceTimersByTimeAsync(5000);
  expect(text(f.banner)).toBe(""); expect(text(f.pill)).toBe("");
  const calls = f.fetch.mock.calls.length; f.doc.visibilityState = "hidden"; await vi.advanceTimersByTimeAsync(15000); expect(f.fetch).toHaveBeenCalledTimes(calls);
  f.doc.visibilityState = "visible"; f.fetch.mockImplementation(async () => Response.json(summary()));
  await vi.advanceTimersByTimeAsync(5000); expect(text(f.banner)).toContain("Published update"); expect(text(f.pill)).toContain("Outage");
});
it("requires an affected in-app component and a published update; takes the public headline verbatim", async () => {
  const f = fixture(); f.fetch.mockImplementation(async () => Response.json({ ...summary(), headline: "No problems found", status: "unchecked", components: [{ status: "operational", in_app: true }, { status: "paused", in_app: true }], incident: null }));
  await vi.advanceTimersByTimeAsync(5001); expect(text(f.banner)).toBe(""); expect(text(f.pill)).toContain("No problems found"); expect(text(f.pill)).not.toContain("All systems operational");
});
it("rejects a wrong page and an oversized JSON body, without surfacing errors to the host", async () => {
  const f = fixture(); f.fetch.mockImplementation(async () => Response.json({ ...summary(), page: "someone-else" })); await vi.advanceTimersByTimeAsync(5001); expect(text(f.banner)).toBe("");
  f.fetch.mockImplementation(async () => new Response("x".repeat(65537))); await vi.advanceTimersByTimeAsync(5000); expect(text(f.pill)).toBe("");
});
// esbuild's first bundle in a fresh checkout can take longer than the default 5 s on a loaded machine.
it("ships a self-contained script under 4 KiB gzipped", async () => {
  const bundle = await build({ entryPoints: ["widget/client.ts"], bundle: true, minify: true, platform: "browser", target: "es2020", write: false });
  expect(gzipSync(bundle.outputFiles[0].contents).length).toBeLessThan(4096);
  expect(bundle.outputFiles[0].text).not.toMatch(/document\.cookie|Clerk|Supabase/);
  const kit = readFileSync("design/tokens.css", "utf8").toLowerCase();
  for (const colour of readFileSync("widget/client.ts", "utf8").match(/#[a-f0-9]{6}\b/gi) ?? []) expect(kit).toContain(colour.toLowerCase());
}, 30_000);
