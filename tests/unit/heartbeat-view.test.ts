import { describe, expect, it } from "vitest";
import { heartbeatView, type HeartbeatReceived } from "@/lib/heartbeat-view";
import { expectedAfter } from "@/lib/cron";
import { monitorHistoryOf, transitionEvent } from "@/lib/history";

/* What a heartbeat's screens say about what arrived (`src/lib/heartbeat-view.ts`): the snapshot's
   last ping, open run, assertions and next expected run. The probe's judgement of the same row is
   `tests/unit/probe-heartbeat.test.ts`. */

const t = (iso: string) => Date.parse(iso);
const nothing: HeartbeatReceived = { pingAt: null, pingPayload: null, startAt: null, failAt: null, judgedAt: null, runAt: null };
const monitor = { schedule: "0 3 * * *", tz: "Europe/Warsaw", versionAt: t("2026-10-01T00:00:00Z"), paused: false, assertions: [{ path: "emails_sent", op: ">", value: "0" }] };

describe("heartbeatView", () => {
  it("says nothing arrived and expects nothing before the first ping", () => {
    expect(heartbeatView(nothing, monitor)).toEqual({ lastPingAt: 0, lastKind: null, summary: null, runningSince: null, expectedAt: null, results: null });
  });

  it("expects the next run after the last one, from the module the probe's deadlines use", () => {
    const pingAt = t("2026-10-22T01:00:20Z");
    const runAt = t("2026-10-22T01:00:00Z");
    const v = heartbeatView({ ...nothing, pingAt, pingPayload: { emails_sent: 12 }, judgedAt: pingAt, runAt }, monitor);
    expect(v.expectedAt).toBe(expectedAfter(monitor.schedule, monitor.tz, runAt, monitor.versionAt));
    expect(new Date(v.expectedAt!).toISOString()).toBe("2026-10-23T01:00:00.000Z");
    expect(v).toMatchObject({ lastPingAt: pingAt, lastKind: "ping", summary: ["emails_sent", "12"], runningSince: null });
  });

  it("follows a ping the home hasn't judged yet, and restarts from an edit", () => {
    const pingAt = t("2026-10-22T01:00:20Z");
    const judged = { judgedAt: t("2026-10-21T01:00:05Z"), runAt: t("2026-10-21T01:00:00Z") };
    expect(heartbeatView({ ...nothing, pingAt, pingPayload: {}, ...judged }, monitor).expectedAt).toBe(t("2026-10-23T01:00:00Z"));
    const edited = { ...monitor, versionAt: t("2026-10-22T12:00:00Z"), schedule: "0 13 * * *" };
    expect(heartbeatView({ ...nothing, pingAt, pingPayload: {}, ...judged }, edited).expectedAt).toBe(t("2026-10-22T11:00:00Z") + 86_400_000);
  });

  it("gives an unjudged finish its own run, as the home will: a long job never moves the expectation a run ahead", () => {
    const minutely = { ...monitor, schedule: "* * * * *", tz: "UTC" };
    // Judged up to the 10:00 run's finish at 10:00:40; the 10:01 run's finish is in, not judged yet.
    const v = heartbeatView({ ...nothing, pingAt: t("2026-10-22T10:01:40Z"), pingPayload: {}, judgedAt: t("2026-10-22T10:00:40Z"), runAt: t("2026-10-22T10:00:00Z") }, minutely);
    expect(v.expectedAt).toBe(t("2026-10-22T10:02:00Z"));
    // Every two minutes, a 130 s run that sent /start: its finish is its start's run.
    const twoMin = { ...minutely, schedule: "*/2 * * * *" };
    const started = { ...nothing, startAt: t("2026-10-22T10:02:00Z"), pingAt: t("2026-10-22T10:04:10Z"), pingPayload: {}, judgedAt: t("2026-10-22T10:01:40Z"), runAt: t("2026-10-22T10:00:00Z") };
    expect(heartbeatView(started, twoMin).expectedAt).toBe(t("2026-10-22T10:04:00Z"));
    // A retry hours after the day's run moves nothing.
    const retried = { ...nothing, pingAt: t("2026-10-22T05:00:00Z"), pingPayload: {}, judgedAt: t("2026-10-22T01:00:20Z"), runAt: t("2026-10-22T01:00:00Z") };
    expect(heartbeatView(retried, monitor).expectedAt).toBe(t("2026-10-23T01:00:00Z"));
  });

  it("expects nothing while paused, or for a schedule or time zone that never runs", () => {
    const pinged = { ...nothing, pingAt: t("2026-10-22T01:00:20Z"), pingPayload: {}, runAt: t("2026-10-22T01:00:20Z") };
    expect(heartbeatView(pinged, { ...monitor, paused: true }).expectedAt).toBeNull();
    expect(heartbeatView(pinged, { ...monitor, schedule: "0 0 30 2 *" }).expectedAt).toBeNull();
    expect(heartbeatView(pinged, { ...monitor, tz: "Mars/Olympus" }).expectedAt).toBeNull();
  });

  it("judges each assertion on the newest good ping, with what it got, through the code the probe uses", () => {
    const base = { ...nothing, pingAt: t("2026-10-22T01:00:20Z"), runAt: t("2026-10-22T01:00:20Z") };
    expect(heartbeatView({ ...base, pingPayload: { emails_sent: 0 } }, monitor).results).toEqual([{ path: "emails_sent", op: ">", expected: "0", got: "0", pass: false }]);
    expect(heartbeatView({ ...base, pingPayload: { rows: 3 } }, monitor).results).toEqual([{ path: "emails_sent", op: ">", expected: "0", pass: false }]);
    expect(heartbeatView({ ...base, pingPayload: { emails_sent: "4" } }, monitor).results?.[0].pass).toBe(true);
  });

  it("names the newest kind, and an open run only while no finish or edit came after its /start", () => {
    const startAt = t("2026-10-22T01:00:00Z");
    const open = heartbeatView({ ...nothing, pingAt: t("2026-10-21T01:20:00Z"), pingPayload: {}, startAt, runAt: t("2026-10-21T01:20:00Z") }, monitor);
    expect(open).toMatchObject({ lastKind: "start", lastPingAt: startAt, runningSince: startAt });
    expect(heartbeatView({ ...nothing, startAt, failAt: startAt + 60_000, runAt: null }, monitor)).toMatchObject({ lastKind: "fail", runningSince: null });
    expect(heartbeatView({ ...nothing, startAt }, { ...monitor, versionAt: startAt + 1 }).runningSince).toBeNull();
  });

  it("keeps a list row's field short", () => {
    const v = heartbeatView({ ...nothing, pingAt: 1, pingPayload: { note: "x".repeat(80), n: 1 } }, monitor);
    expect(v.summary?.[0]).toBe("note");
    expect(v.summary?.[1]).toHaveLength(40);
  });
});

describe("a heartbeat's history", () => {
  it("says what happened without a city, and recovers on a good ping", () => {
    const h = monitorHistoryOf({
      points: [],
      failures: [{ at: "2026-10-22T01:06:05Z", loc: "tor1", kind: "missed", message: "No ping by 2026-10-22 03:05 Europe/Warsaw", status: null, ms: 0, snippet: null }],
      transitions: [{ at: "2026-10-22T01:06:05Z", from: "up", to: "down" }, { at: "2026-10-22T02:00:00Z", from: "down", to: "up" }],
    }, true);
    expect(h.events.map((e) => e.text)).toEqual(["Up again: a good ping arrived. The incident closed.", "No ping by 2026-10-22 03:05 Europe/Warsaw", "Down. An incident opened."]);
    expect(transitionEvent(null, "up", true).text).toBe("First ping received.");
    expect(transitionEvent(null, "down", true).text).toBe("Down from its first ping. An incident opened.");
    expect(transitionEvent("down", "up").text).toBe("Up again after two passing checks. The incident closed.");
  });
});
