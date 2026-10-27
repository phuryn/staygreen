import { describe, expect, it, vi } from "vitest";
import { appRow, appSelectionDestination, calmHeadline, checkedSoFar, firstCount, readAppSelection, scopeToApp, summarize, validAppSelection, writeAppSelection } from "@/lib/app-selection";
import { workspaceState } from "@/lib/derive";
import { incident, monitor, page, sim } from "./fixtures";

const app = (id: string) => ({ id, name: id, url: "", logoUrl: null, blurb: "", channelIds: [] });
const s = sim({
  apps: [app("a1"), app("a2")],
  monitors: [monitor({ id: "m1", appId: "a1", state: "up" }), monitor({ id: "m2", appId: "a2", state: "down" })],
  incidents: [incident({ id: "i1", monitorId: "m1", appId: "a1" }), incident({ id: "i2", monitorId: "m2", appId: "a2" })],
  pages: [page({ id: "p1", appId: "a1" }), page({ id: "p2", appId: "a2" })],
});

describe("the dashboard app choice", () => {
  it("scopes each collection without mutating the workspace or losing plan context", () => {
    const view = scopeToApp(s, "a1");
    expect(view.apps.map((x) => x.id)).toEqual(["a1"]);
    expect(view.monitors.map((x) => x.id)).toEqual(["m1"]);
    expect(view.incidents.map((x) => x.id)).toEqual(["i1"]);
    expect(view.pages.map((x) => x.id)).toEqual(["p1"]);
    expect(view.plan).toBe(s.plan);
    expect(s.apps).toHaveLength(2);
    expect(s.monitors).toHaveLength(2);
    expect(s.pages).toHaveLength(2);
    expect(workspaceState(s)).toBe("down");
    expect(workspaceState(view)).toBe("up");
  });

  it("All apps and a stale or foreign id show the whole workspace", () => {
    for (const id of ["all", "deleted", "foreign"]) expect(scopeToApp(s, id)).toBe(s);
  });

  it("cannot leave a hidden filter when the last other app is removed", () => {
    expect(validAppSelection([app("a1")], "a1")).toBe("all");
    expect(validAppSelection([], "a1")).toBe("all");
    expect(validAppSelection(s.apps, "a1")).toBe("a1");
    expect(validAppSelection(s.apps, "missing")).toBe("all");
  });

  it.each(["/app", "/app/monitors", "/app/incidents", "/app/status-pages"])("stays on the filtered collection %s", (path) => {
    expect(appSelectionDestination(path)).toBe(path);
  });

  it.each(["/app/alerts", "/app/widget", "/app/agents", "/app/billing", "/app/settings", "/app/monitors/m1", "/app/monitors/m1/edit", "/app/incidents/i1", "/app/status-pages/p1", "/app/monitors/new"])("choosing on %s lands on Overview", (path) => {
    expect(appSelectionDestination(path)).toBe("/app");
  });
});

describe("the row under the logo", () => {
  const three = sim({
    apps: [app("a1"), app("a2"), app("a3")],
    monitors: [
      monitor({ id: "m1", appId: "a1", state: "up" }),
      monitor({ id: "m2", appId: "a2", state: "down" }),
      monitor({ id: "m3", appId: "a2", state: "down" }),
      monitor({ id: "m4", appId: "a3", state: "degraded" }),
    ],
  });

  it("is nothing before the first app: there is nothing to name", () => {
    expect(appRow(sim(), "all")).toBeNull();
  });

  it("names the one app and its own state, with nothing else to warn about", () => {
    const one = sim({ apps: [app("a1")], monitors: [monitor({ id: "m1", appId: "a1", state: "unchecked", checked: false })] });
    expect(appRow(one, "all")).toEqual({ label: "a1", status: { state: "unchecked", text: "Not checked yet" }, others: null });
    expect(appRow(sim({ apps: [app("a1")] }), "a1")).toEqual({ label: "a1", status: { state: "unchecked", text: "No monitors yet" }, others: null });
  });

  it("on All apps, says the worst across every app", () => {
    expect(appRow(three, "all")).toEqual({ label: "All apps", status: { state: "down", text: "2 down" }, others: null });
    expect(appRow(three, "deleted")?.label).toBe("All apps");
  });

  it("on one app, says its state and what is wrong in the others, so the choice hides no outage", () => {
    expect(appRow(three, "a1")).toEqual({ label: "a1", status: { state: "up", text: "All up" }, others: { state: "down", text: "Other apps: 1 down, 1 degraded" } });
    expect(appRow(three, "a3")?.others).toEqual({ state: "down", text: "Other apps: 1 down" });
    expect(appRow(three, "a2")).toEqual({ label: "a2", status: { state: "down", text: "2 down" }, others: { state: "degraded", text: "Other apps: 1 degraded" } });
    // Healthy, paused or unchecked elsewhere is nothing to warn about.
    expect(appRow(s, "a2")?.others).toBeNull();
  });

  it.each<[string, Parameters<typeof summarize>[0], ReturnType<typeof summarize>]>([
    ["no monitors", [], { state: "unchecked", text: "No monitors yet" }],
    ["one down beside one up", [monitor({ id: "x", state: "down" }), monitor({ id: "y", state: "up" })], { state: "down", text: "1 down" }],
    ["two degraded", [monitor({ id: "x", state: "degraded" }), monitor({ id: "y", state: "degraded" })], { state: "degraded", text: "2 degraded" }],
    ["all paused", [monitor({ id: "x", state: "paused" })], { state: "paused", text: "All paused" }],
    ["one up beside one never checked", [monitor({ id: "x", state: "up" }), monitor({ id: "y", state: "unchecked", checked: false })], { state: "unchecked", text: "Not checked yet" }],
    ["one checked without a settled state", [monitor({ id: "x", state: "unchecked", checked: true })], { state: "unchecked", text: "Checking…" }],
    ["one up beside one checking", [monitor({ id: "x", state: "up" }), monitor({ id: "y", state: "unchecked", checked: true })], { state: "unchecked", text: "Checking…" }],
    ["a heartbeat before its first ping", [monitor({ id: "h", type: "heartbeat", state: "unchecked", checked: false })], { state: "unchecked", text: "Not checked yet" }],
    ["checking beside a fresh monitor and an unpinged heartbeat", [monitor({ id: "x", state: "unchecked", checked: true }), monitor({ id: "y", state: "unchecked", checked: false }), monitor({ id: "h", type: "heartbeat", state: "unchecked", checked: false })], { state: "unchecked", text: "Checking 1… and 2 not checked yet" }],
    ["all up", [monitor({ id: "x", state: "up" })], { state: "up", text: "All up" }],
  ])("summarizes %s", (_name, monitors, line) => {
    expect(summarize(monitors)).toEqual(line);
  });
});

describe("the tab's app preference", () => {
  const storage = () => {
    const data = new Map<string, string>();
    return {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); },
      removeItem: (key: string) => { data.delete(key); },
    };
  };

  it.each(["reload", "back_forward"])("restores on %s only for the same workspace", (navigation) => {
    const store = storage();
    writeAppSelection(store, "w1", "a1");
    expect(readAppSelection(store, "w1", navigation)).toBe("a1");
    expect(readAppSelection(store, "w2", navigation)).toBe("all");
  });

  it.each(["navigate", undefined])("clears on a fresh visit (%s), including storage copied by an opener", (navigation) => {
    const store = storage();
    writeAppSelection(store, "w1", "a1");
    expect(readAppSelection(store, "w1", navigation)).toBe("all");
    expect(readAppSelection(store, "w1", "reload")).toBe("all");
  });

  it.each(["bad json", "null", "[]", '"a1"', '{"workspaceId":"w1","app":3}'])("ignores malformed storage: %s", (raw) => {
    expect(readAppSelection({ getItem: () => raw, removeItem: vi.fn() }, "w1", "reload")).toBe("all");
  });

  it("keeps the app usable if storage reads or writes throw", () => {
    const fail = () => { throw new Error("Storage disabled"); };
    expect(readAppSelection({ getItem: fail, removeItem: fail }, "w1", "reload")).toBe("all");
    expect(readAppSelection({ getItem: fail, removeItem: fail }, "w1", "navigate")).toBe("all");
    expect(() => writeAppSelection({ setItem: fail }, "w1", "a1")).not.toThrow();
  });
});

describe("the overview's headline with nothing open or degraded", () => {
  const up = monitor({ id: "u", state: "up", checked: true });
  it("is the all-clear only when every monitor is up or paused, and not all paused", () => {
    expect(calmHeadline([up, monitor({ id: "p", state: "paused", checked: true })])).toEqual({ state: "up", text: "Everything is working" });
    expect(calmHeadline([up], " in Harbor")).toEqual({ state: "up", text: "Everything in Harbor is working" });
  });
  it("a monitor added beside one that is up is not checked yet, not working", () => {
    expect(calmHeadline([up, monitor({ id: "n", state: "unchecked", checked: false })])).toEqual({ state: "unchecked", text: "1 monitor not checked yet" });
  });
  it("a failure no second location confirmed has a window but no state, and says so in its row's words", () => {
    expect(calmHeadline([monitor({ id: "f", state: "unchecked", checked: true })])).toEqual({ state: "unchecked", text: "Checking 1 monitor…" });
    expect(calmHeadline([up, monitor({ id: "f", state: "unchecked", checked: true }), monitor({ id: "g", state: "unchecked", checked: true })], " in Harbor"))
      .toEqual({ state: "unchecked", text: "Checking 2 monitors in Harbor…" });
    expect(calmHeadline([monitor({ id: "f", state: "unchecked", checked: true }), monitor({ id: "n", state: "unchecked", checked: false })]))
      .toEqual({ state: "unchecked", text: "Checking 1 monitor… and 1 not checked yet" });
  });
  it("the line under it says checked only when every monitor has been", () => {
    expect(checkedSoFar([up, up])).toBe("checked");
    expect(checkedSoFar([up, monitor({ id: "n", state: "unchecked", checked: false })])).toBe("1 checked so far");
    expect(checkedSoFar([monitor({ id: "n", state: "unchecked", checked: false })])).toBe("to be checked");
    expect(checkedSoFar([])).toBe("to be checked");
  });
  it("its first count counts only what its label says and its link lists", () => {
    const paused = monitor({ id: "p", state: "paused", checked: true });
    expect(firstCount([up, up, up, paused])).toEqual({ st: "up", n: 3, label: "Up", href: "/app/monitors?state=up" });
    expect(firstCount([paused, paused])).toEqual({ st: "paused", n: 2, label: "Paused", href: "/app/monitors?state=paused" });
    expect(firstCount([monitor({ id: "n", state: "unchecked", checked: false }), paused])).toMatchObject({ st: "unchecked", n: 1, label: "Not checked yet" });
    expect(firstCount([monitor({ id: "f", state: "unchecked", checked: true })])).toMatchObject({ st: "unchecked", n: 1, label: "Checking…" });
    expect(firstCount([])).toEqual({ st: "up", n: 0, label: "Up", href: "/app/monitors?state=up" });
  });
  it("counts only checked, unsettled monitors as Checking, leaving fresh monitors and unpinged heartbeats out", () => {
    const checking = monitor({ id: "c", state: "unchecked", checked: true });
    const fresh = monitor({ id: "n", state: "unchecked", checked: false });
    const heartbeat = monitor({ id: "h", type: "heartbeat", state: "unchecked", checked: false });
    expect(firstCount([checking, fresh, heartbeat])).toEqual({ st: "unchecked", n: 1, label: "Checking…", href: "/app/monitors?state=checking" });
    expect(firstCount([fresh, heartbeat])).toEqual({ st: "unchecked", n: 2, label: "Not checked yet", href: "/app/monitors?state=unchecked" });
    expect(firstCount([heartbeat])).toMatchObject({ n: 1, label: "Not checked yet" });
    expect(firstCount([up, checking, fresh, heartbeat])).toMatchObject({ st: "up", n: 1, label: "Up" });
  });
  it("before any check, and when every monitor is paused, it says so", () => {
    expect(calmHeadline([monitor({ id: "a", state: "unchecked", checked: false }), monitor({ id: "b", state: "unchecked", checked: false })])).toEqual({ state: "unchecked", text: "Nothing checked yet" });
    expect(calmHeadline([monitor({ id: "p1", state: "paused", checked: true }), monitor({ id: "p2", state: "paused", checked: true })])).toEqual({ state: "paused", text: "Every monitor is paused" });
  });
});
