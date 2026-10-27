import { describe, expect, it } from "vitest";
import {
  NO_HISTORY,
  dailySeries,
  datedSeries,
  measuredById,
  monitorHistoryDto,
  monitorHistoryOf,
  noNumber,
  nothingMeasured,
  recoveryNote,
  reportResult,
  reportState,
  reportedWhen,
  reportsOf,
  sinceLastEdit,
  stateLabel,
  transitionEvent,
  uptimeOf,
  workspaceHistoryDto,
  type WorkspaceHistory,
} from "@/lib/history";
import { lastLine } from "@/components/MonitorTable";
import { hourly } from "@/components/charts";
import { DAY, monitor, NOW } from "./fixtures";

/* What the probes measured, as the dashboard reads it (`src/lib/history.ts`). The SQL in
   migration 014 does the sums; this is where each value lands on its day and gets its words.
   A day, a location or a stretch with no window is no data, never 100% (`AGENTS.md § 2.8`). */

const TODAY = "2026-10-21"; // NOW's UTC day
const at = (iso: string) => new Date(iso).toISOString();

/** One monitor as `workspace_history` returns it. */
function row(over: Partial<WorkspaceHistory["monitors"][number]> = {}): WorkspaceHistory["monitors"][number] {
  return { id: "mon_1", days: [], month: { covered: 0, down: 0 }, day: { covered: 0, down: 0 }, p95: null, latest: [], ...over };
}

describe("dailySeries, the 90 bars", () => {
  it("is 90 days of no data when no day had a window", () => {
    const d = dailySeries([], TODAY, NOW);
    expect(d).toHaveLength(90);
    expect(d.every((v) => v === -1)).toBe(true);
  });

  it("puts each day at its age, oldest first, and leaves the days between as no data", () => {
    const d = dailySeries([[0, 99.5], [2, 100], [89, 97]], TODAY, NOW);
    expect(d[89]).toBe(99.5);
    expect(d[88]).toBe(-1);
    expect(d[87]).toBe(100);
    expect(d[0]).toBe(97);
    expect(d.filter((v) => v !== -1)).toHaveLength(3);
  });

  it("moves every day one bar back when the page renders on the UTC day after the read", () => {
    // Read at 23:59:59 UTC, rendered just after midnight: the database's today is yesterday.
    const d = dailySeries([[0, 99.5], [89, 97]], TODAY, NOW + DAY);
    expect(d[88]).toBe(99.5);
    expect(d[89]).toBe(-1);
    expect(d.includes(97)).toBe(false); // day 90 fell off the start
  });

  it("drops a day outside the 90", () => {
    expect(dailySeries([[90, 50], [400, 1]], TODAY, NOW).every((v) => v === -1)).toBe(true);
  });

  it("reads the public snapshot's dated days the same way", () => {
    const d = datedSeries([{ d: "2026-10-21", up: 99 }, { d: "2026-10-19", up: 100 }, { d: "2026-10-22", up: 1 }], NOW);
    expect(d[89]).toBe(99);
    expect(d[87]).toBe(100);
    expect(d.includes(1)).toBe(false); // a day ahead of this clock has no bar
  });
});

describe("uptimeOf", () => {
  it("is null with nothing covered: no check is no uptime to claim", () => {
    expect(uptimeOf(0, 0)).toEqual({ pct: null, coveredMs: 0 });
    expect(uptimeOf(0, 300)).toEqual({ pct: null, coveredMs: 0 });
  });

  it("is the share of the covered time no outage took", () => {
    expect(uptimeOf(86_400, 0)).toEqual({ pct: 100, coveredMs: 86_400_000 });
    expect(uptimeOf(3_600, 900).pct).toBe(75);
  });

  it("never goes below 0 or above 100", () => {
    expect(uptimeOf(600, 1_200).pct).toBe(0);
    expect(uptimeOf(600, -5).pct).toBe(100);
  });
});

describe("reportsOf, each location's newest window", () => {
  const latest = [
    { loc: "fra1", end: "2026-10-21T11:55:00Z", checks: 5, failures: 0, p50: 210 },
    { loc: "mars9", end: "2026-10-21T11:59:00Z", checks: 5, failures: 5, p50: null },
    { loc: "tor1", end: "2026-10-21T11:58:00Z", checks: 3, failures: 1, p50: 120 },
    { loc: "sfo3", end: "2026-10-21T11:55:00Z", checks: 3, failures: 0, p50: 180 },
  ];

  it("drops a location the plan module doesn't know", () => {
    expect(reportsOf(latest).map((r) => r.loc)).not.toContain("mars9");
  });

  it("puts the newest first, and a tie in the locations' own order", () => {
    expect(reportsOf(latest).map((r) => r.loc)).toEqual(["tor1", "sfo3", "fra1"]);
  });

  it("has no entry for a location that never reported", () => {
    expect(reportsOf([latest[2]]).map((r) => r.loc)).toEqual(["tor1"]);
  });
});

describe("measuredById", () => {
  const h: WorkspaceHistory = {
    today: TODAY,
    monitors: [row({ id: "mon_1", days: [[0, 99.9]], day: { covered: 43_200, down: 0 }, month: { covered: 86_400, down: 864 }, p95: 480, latest: [{ loc: "tor1", end: at("2026-10-21T11:55:00Z"), checks: 5, failures: 0, p50: 120 }] })],
  };

  it("maps a monitor's numbers onto the dashboard's", () => {
    const m = measuredById(h, NOW).get("mon_1")!;
    expect(m.uptime.day).toEqual({ pct: 100, coveredMs: 43_200_000 });
    expect(m.uptime.month.pct).toBe(99);
    expect(m.p95).toBe(480);
    expect(m.daily[89]).toBe(99.9);
    expect(m.reports).toEqual([{ loc: "tor1", end: Date.parse("2026-10-21T11:55:00Z"), checks: 5, failures: 0, p50: 120 }]);
  });

  it("has nothing for a monitor the function didn't return", () => {
    expect(measuredById(h, NOW).has("mon_2")).toBe(false);
  });

  it("has every number absent, none zero, for a monitor nothing measured", () => {
    const m = nothingMeasured();
    expect(m.reports).toEqual([]);
    expect(m.p95).toBeNull();
    expect(m.uptime.day.pct).toBeNull();
    expect(m.uptime.month.pct).toBeNull();
    expect(m.daily).toHaveLength(90);
    expect(m.daily.every((v) => v === -1)).toBe(true);
  });
});

describe("sinceLastEdit, after a changed address", () => {
  const all = measuredById(
    {
      today: TODAY,
      monitors: [
        row({
          days: [[0, 50], [1, 100]],
          day: { covered: 86_400, down: 43_200 },
          p95: 900,
          latest: [
            { loc: "tor1", end: at("2026-10-21T11:55:00Z"), checks: 3, failures: 3, p50: null },
            { loc: "sfo3", end: at("2026-10-21T10:00:00Z"), checks: 3, failures: 0, p50: 100 },
          ],
        }),
      ],
    },
    NOW,
  ).get("mon_1")!;

  it("keeps only the windows that ended after the edit", () => {
    const m = sinceLastEdit(all, Date.parse("2026-10-21T11:00:00Z"));
    expect(m.reports.map((r) => r.loc)).toEqual(["tor1"]);
  });

  it("shows no uptime, p95 or day from before it", () => {
    const m = sinceLastEdit(all, Date.parse("2026-10-21T11:00:00Z"));
    expect(m.uptime.day.pct).toBeNull();
    expect(m.p95).toBeNull();
    expect(m.daily.every((v) => v === -1)).toBe(true);
  });
});

describe("the words for what was measured", () => {
  it("never says Not checked yet about a monitor a probe checked", () => {
    expect(noNumber(monitor({ id: "m1", checked: true }))).toBe("No data yet");
    expect(noNumber(monitor({ id: "m1", checked: false, state: "unchecked" }))).toBe("Not checked yet");
  });

  it("distinguishes a paused Supabase project from a manually paused monitor", () => {
    expect(stateLabel({ state: "down", checked: true, serviceStatus: "paused_or_deleted" })).toBe("Paused or deleted");
    expect(stateLabel({ state: "paused", checked: true, serviceStatus: "paused_or_deleted" })).toBeUndefined();
    expect(stateLabel({ state: "up", checked: true, serviceStatus: "paused_or_deleted" })).toBeUndefined();
  });

  it("calls a checked monitor whose state is unsettled Checking…", () => {
    expect(stateLabel(monitor({ id: "m1", checked: true, state: "unchecked" }))).toBe("Checking…");
    expect(stateLabel(monitor({ id: "m1", checked: false, state: "unchecked" }))).toBeUndefined();
    expect(stateLabel(monitor({ id: "m1", checked: true, state: "up" }))).toBeUndefined();
  });

  it.each([
    [1, 0, "Passed", "up"],
    [5, 0, "5 checks passed", "up"],
    [1, 1, "Failed", "down"],
    [3, 3, "3 checks failed", "down"],
    [5, 2, "2 of 5 checks failed", "degraded"],
  ] as const)("words %i checks with %i failed as %j", (checks, failures, words, state) => {
    expect(reportResult({ checks, failures })).toBe(words);
    expect(reportState({ checks, failures })).toBe(state);
  });

  it("says when a down checked monitor turns green, as the rule and never as the newest check's result", () => {
    const down = monitor({ id: "m1", type: "dns", state: "down", intervalSec: 600, reports: [{ loc: "tor1", end: NOW, checks: 1, failures: 0, p50: 11 }] });
    expect(recoveryNote(down)).toBe("Green after two passing checks in a row. Checks run every 10 min.");
    expect(recoveryNote({ ...down, intervalSec: 21600 })).toBe("Green after two passing checks in a row. Checks run every 6 h.");
    expect(lastLine(down, NOW).main).toBe("Passed");
    expect(recoveryNote({ ...down, state: "up" })).toBeNull();
    expect(recoveryNote({ ...down, type: "heartbeat" })).toBeNull();
    expect(recoveryNote({ ...down, type: "stripe" })).toBeNull();
  });

  it.each([
    [null, "down", "down", "Down from its first checks. An incident opened."],
    ["up", "down", "down", "Down. An incident opened."],
    ["up", "degraded", "degraded", "Slow: three checks in a row took longer than the threshold."],
    ["down", "degraded", "recovered", "Up again after two passing checks, but slow. The incident closed."],
    [null, "up", "pass", "First check passed."],
    ["down", "up", "recovered", "Up again after two passing checks. The incident closed."],
    ["degraded", "up", "recovered", "Responses are fast again."],
  ] as const)("words a change from %s to %s", (from, to, kind, text) => {
    expect(transitionEvent(from, to)).toEqual({ kind, text });
  });
});

describe("lastLine, the Latest checks cell", () => {
  it("says No data yet, never Not checked yet, for an up monitor with no window", () => {
    const line = lastLine(monitor({ id: "m1", state: "up", checked: true, reports: [] }), NOW);
    expect(line.main).toBe("No data yet");
    expect(line.main).not.toContain("Not checked");
  });

  it("says Not checked yet only before any check", () => {
    expect(lastLine(monitor({ id: "m1", state: "unchecked", checked: false }), NOW).main).toBe("Not checked yet");
  });

  it("names the newest window, when it reported and from where", () => {
    const line = lastLine(
      monitor({
        id: "m1",
        reports: [
          { loc: "sfo3", end: NOW - 120_000, checks: 3, failures: 1, p50: 150 },
          { loc: "tor1", end: NOW - 400_000, checks: 3, failures: 0, p50: 100 },
        ],
      }),
      NOW,
    );
    expect(line).toEqual({ main: "1 of 3 checks failed", sub: "2 min ago from San Francisco" });
  });

  it("dates a window still open, a new monitor's first check, by when its checks ran, not as just now", () => {
    const local = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const start = NOW - 120_000; // the window began two minutes ago and ends in three
    const created = NOW - 40_000;
    const line = lastLine(monitor({ id: "m1", createdAt: created, reports: [{ loc: "tor1", end: start + 300_000, checks: 1, failures: 0, p50: 120 }] }), NOW);
    expect(line).toEqual({ main: "Passed", sub: `since ${local(created)} from Toronto` });
    expect(line.sub).not.toContain("just now");
  });

  it("dates an open window after an edit from the edit, which started that window over (020)", () => {
    const local = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const start = NOW - 120_000;
    const edited = NOW - 40_000;
    const line = lastLine(monitor({ id: "m1", createdAt: NOW - 30 * DAY, updatedAt: edited, reports: [{ loc: "tor1", end: start + 300_000, checks: 1, failures: 0, p50: 120 }] }), NOW);
    expect(line.sub).toBe(`since ${local(edited)} from Toronto`);
  });
});

describe("reportedWhen", () => {
  const local = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  it("says a closed window is as old as its end", () => {
    expect(reportedWhen({ end: NOW - 120_000 }, NOW)).toBe("2 min ago");
  });

  it("says an open window's checks ran since it began, or since the monitor was created when later", () => {
    const end = NOW + 180_000;
    expect(reportedWhen({ end }, NOW)).toBe(`since ${local(end - 300_000)}`);
    expect(reportedWhen({ end }, NOW, NOW - 30_000)).toBe(`since ${local(NOW - 30_000)}`);
    expect(reportedWhen({ end }, NOW, NOW - 30 * DAY)).toBe(`since ${local(end - 300_000)}`);
  });
});

describe("monitorHistoryOf, one monitor's page", () => {
  const raw = {
    points: [
      { t: "2026-10-21T11:00:00Z", checks: 6, failures: 0, p50: 120, p95: 300 },
      { t: "2026-10-21T11:05:00Z", checks: 6, failures: 6, p50: null, p95: null },
    ],
    failures: [
      { at: "2026-10-21T11:06:00Z", loc: "tor1", kind: "status", message: "Returned 503", status: 503, ms: 80, snippet: "<h1>503</h1>" },
      { at: "2026-10-21T11:04:00Z", loc: "tor1", kind: "timeout", message: "Timed out", status: null, ms: 15_000, snippet: null },
      { at: "2026-10-21T11:05:00Z", loc: "pluto1", kind: "status", message: "Returned 500", status: 500, ms: 90, snippet: null },
    ],
    transitions: [{ at: "2026-10-21T11:07:00Z", from: "up", to: "down" }],
  };
  const h = monitorHistoryOf(monitorHistoryDto.parse(raw));

  it("has nothing for a monitor outside the workspace", () => {
    expect(monitorHistoryOf(monitorHistoryDto.parse(null))).toBe(NO_HISTORY);
  });

  it("keeps a window whose checks all failed, with no response time", () => {
    expect(h.points[1]).toEqual({ t: Date.parse("2026-10-21T11:05:00Z"), p50: null, p95: null, fails: 6, checks: 6 });
  });

  it("merges failed checks and state changes, newest first", () => {
    expect(h.events.map((e) => e.kind)).toEqual(["down", "fail", "fail", "fail"]);
    expect(h.events[1]).toMatchObject({ kind: "fail", text: "Failed in Toronto: Returned 503", loc: "tor1", snippet: "<h1>503</h1>" });
    // A location the plan module doesn't know keeps its own name and gets no `loc`.
    expect(h.events.find((e) => e.text.includes("pluto1"))).not.toHaveProperty("loc");
  });

  it("keeps each location's newest failure for its card", () => {
    expect(h.lastFailure).toEqual({ tor1: { t: Date.parse("2026-10-21T11:06:00Z"), message: "Returned 503" } });
  });

  it("drops any key the function might add", () => {
    const parsed = monitorHistoryDto.parse({ ...raw, failures: [{ ...raw.failures[0], detail: { headers: "secret" } }] });
    expect(parsed?.failures[0]).not.toHaveProperty("detail");
  });
});

describe("the DTOs refuse a shape they don't know", () => {
  const good = { today: TODAY, monitors: [row({ days: [[0, 99.5]] })] };

  it("takes the function's own shape", () => {
    expect(workspaceHistoryDto.safeParse(good).success).toBe(true);
  });

  it.each([
    ["an uptime above 100", { ...good, monitors: [row({ days: [[0, 100.1]] })] }],
    ["a day in the future", { ...good, monitors: [row({ days: [[-1, 99]] })] }],
    ["a malformed today", { ...good, today: "21/10/2026" }],
    ["negative covered time", { ...good, monitors: [row({ day: { covered: -1, down: 0 } })] }],
  ])("refuses %s", (_name, bad) => {
    expect(workspaceHistoryDto.safeParse(bad).success).toBe(false);
  });
});

describe("hourly, the chart's table view", () => {
  it("weights the median by passing checks and gives an hour of failures no times", () => {
    const h = Date.parse("2026-10-21T10:00:00Z");
    const rows = hourly([
      { t: h, p50: 100, p95: 200, fails: 0, checks: 3 },
      { t: h + 300_000, p50: 400, p95: 900, fails: 2, checks: 3 },
      { t: h + 3_600_000, p50: null, p95: null, fails: 3, checks: 3 },
    ]);
    expect(rows).toEqual([
      { t: h + 3_600_000, p50: null, p95: null, fails: 3 },
      { t: h, p50: (100 * 3 + 400 * 1) / 4, p95: 900, fails: 2 },
    ]);
  });
});
