import { describe, expect, it } from "vitest";
import { appState, componentState, hostCount, openIncidents, pageHost, pageUrl, workspaceState, worst } from "@/lib/derive";
import type { State } from "@/lib/model";
import { incident, monitor, NOW, page, sim } from "./fixtures";

/* What every screen derives from a workspace (`src/lib/derive.ts`). A monitor
   nobody has checked has no state (`AGENTS.md § 2.8`); its uptime is the
   probes' and is tested with `history.ts`. */

describe("worst", () => {
  it.each([
    [["up", "degraded", "down", "paused", "unchecked"], "down"],
    [["up", "degraded", "paused", "unchecked"], "degraded"],
    [["up", "paused", "unchecked"], "up"],
    [["up", "unchecked"], "up"],
    [["paused", "paused"], "paused"],
    [["paused", "unchecked"], "unchecked"],
    [["unchecked"], "unchecked"],
    [[], "unchecked"],
  ] as [State[], State][])("worst(%j) is %s", (states, expected) => {
    expect(worst(states)).toBe(expected);
  });

  it("is the same whatever the order", () => {
    expect(worst(["unchecked", "down", "up"])).toBe("down");
    expect(worst(["paused", "up"])).toBe("up");
  });
});

describe("app, workspace and component states", () => {
  const s = sim({
    monitors: [
      monitor({ id: "m1", appId: "a1", state: "up" }),
      monitor({ id: "m2", appId: "a1", state: "degraded" }),
      monitor({ id: "m3", appId: "a2", state: "paused" }),
      monitor({ id: "m4", appId: "a3", state: "unchecked", checked: false }),
    ],
  });

  it("takes the worst of an app's own monitors only", () => {
    expect(appState(s, "a1")).toBe("degraded");
    expect(appState(s, "a2")).toBe("paused");
    expect(appState(s, "a3")).toBe("unchecked");
    expect(appState(s, "no_such_app")).toBe("unchecked");
  });

  it("takes the worst across the workspace", () => {
    expect(workspaceState(s)).toBe("degraded");
    expect(workspaceState(sim())).toBe("unchecked");
  });

  it("never lets a paused monitor make a component look down", () => {
    expect(componentState(s, ["m1", "m3"])).toBe("up");
    expect(componentState(s, ["m3"])).toBe("paused");
    expect(componentState(s, [])).toBe("unchecked");
  });
});

describe("hostCount", () => {
  it("counts the monitors that send checks to a host, by type", () => {
    const s = sim({
      monitors: [
        monitor({ id: "h1", type: "http", target: "https://api.example.com/health" }),
        monitor({ id: "h2", type: "http", target: "https://api.example.com/ready" }),
        monitor({ id: "t1", type: "tcp", target: "api.example.com:5432", tcp: { host: "api.example.com", port: 5432, tls: false } }),
        monitor({ id: "d1", type: "dns", target: "A api.example.com", dns: { record: "A", name: "api.example.com", expected: "1.1.1.1" } }),
        monitor({ id: "s1", type: "ssl", target: "api.example.com" }),
        monitor({ id: "b1", type: "heartbeat", target: "api.example.com" }),
        monitor({ id: "x1", type: "stripe", target: "api.example.com" }),
        monitor({ id: "o1", type: "http", target: "https://other.example.com/" }),
      ],
    });
    expect(hostCount(s, "api.example.com")).toBe(4);
    expect(hostCount(s, "other.example.com")).toBe(1);
    expect(hostCount(s, "nobody.example.com")).toBe(0);
  });
});

describe("openIncidents and pageHost", () => {
  it("lists only unresolved incidents", () => {
    const s = sim({ incidents: [incident({ id: "i1", monitorId: "m1" }), incident({ id: "i2", monitorId: "m1", resolvedAt: NOW })] });
    expect(openIncidents(s).map((i) => i.id)).toEqual(["i1"]);
  });

  it("serves a page on its own domain only once the domain is live", () => {
    expect(pageHost(page({ slug: "askone" }))).toBe("status.staygreen.io/askone");
    expect(pageHost(page({ slug: "askone", domain: { host: "status.askone.org", name: "status", cnameTarget: `${"a".repeat(32)}.domains.staygreen.io`, step: 3, startedAt: NOW } }))).toBe("status.staygreen.io/askone");
    expect(pageHost(page({ slug: "askone", domain: { host: "status.askone.org", name: "status", cnameTarget: `${"a".repeat(32)}.domains.staygreen.io`, step: 4, startedAt: NOW } }))).toBe("status.askone.org");
  });

  it("copies the address the screens show, as a link", () => {
    expect(pageUrl(page({ slug: "askone" }))).toBe("https://status.staygreen.io/askone");
    expect(pageUrl(page({ slug: "askone", domain: { host: "status.askone.org", name: "status", cnameTarget: `${"a".repeat(32)}.domains.staygreen.io`, step: 4, startedAt: NOW } }))).toBe("https://status.askone.org");
    expect(pageUrl(page({ slug: "askone", membersOnly: true }))).toBe("https://staygreen.io/s/askone");
  });
});
