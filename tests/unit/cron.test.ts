import { describe, expect, it } from "vitest";
import { describeCron, earlyFor, expectedAfter, heartbeatIntervalSec, isValidCron, lastRun, nextRun, runOf } from "@/lib/cron";

/* A heartbeat's schedule (`src/lib/cron.ts`): the label the form shows as you
   type, the period the creating action derives the interval from, and what
   counts as valid. Five fields, minute hour day-of-month month day-of-week. */

const MIN = 1;
const HOUR = 60;
const DAY = 1440;

describe("isValidCron", () => {
  it.each(["* * * * *", "0 6 * * *", "*/5 * * * *", "0 */6 * * *", "0 9 * * 1-5", "15,45 * * * *", "0 0 1 * *", "  0 6 * * *  ", "0  6 * * *", "0-30/10 * * * *", "59 23 31 12 6"])("accepts %j", (c) => {
    expect(isValidCron(c)).toBe(true);
  });

  it.each(["", "* * * *", "* * * * * *", "a b c d e", "0 6 * * MON", "0 6 * JAN *", "@daily", "0 6 * * * #", "0,6 * * * ,", "100 * * * *"])("refuses %j", (c) => {
    expect(isValidCron(c)).toBe(false);
  });

  // BUG (cron.ts:11, used at :15): FIELD takes any one- or two-digit number in every position, so a
  // minute of 60-99, an hour of 24-99, a day of 0 or 32-99, a month of 0 or 13-99, a weekday
  // of 8-99 and a step of 0 all pass as a valid schedule.
  it.each(["60 * * * *", "0 24 * * *", "0 6 32 * *", "0 6 0 * *", "0 6 * 13 *", "0 6 * 0 *", "0 6 * * 8", "*/0 * * * *", "0 */0 * * *"])(
    "refuses a value outside its field's range: %j",
    (c) => {
      expect(isValidCron(c)).toBe(false);
    },
  );
});

describe("describeCron", () => {
  it.each([
    ["* * * * *", "Every minute", MIN],
    ["*/5 * * * *", "Every 5 minutes", 5],
    ["*/15 * * * *", "Every 15 minutes", 15],
    ["30 * * * *", "Every hour at :30", HOUR],
    ["5 * * * *", "Every hour at :05", HOUR],
    ["0 */6 * * *", "Every 6 hours", 6 * HOUR],
    ["0 6 * * *", "Every day at 06:00", DAY],
    ["30 9 * * 1", "Every Monday at 09:30", 7 * DAY],
    ["0 18 * * 0", "Every Sunday at 18:00", 7 * DAY],
    ["0 9 * * 1-5", "Weekdays at 09:00", DAY],
    ["0 3 1 * *", "Monthly on day 1 at 03:00", 31 * DAY],
  ])("reads %j as %j, every %i minutes", (c, label, periodMin) => {
    expect(describeCron(c)).toEqual({ valid: true, label, periodMin });
  });

  it("calls a valid schedule it cannot word a custom one, read as daily", () => {
    const custom = describeCron("0 0 1 1 *");
    expect(custom.valid).toBe(true);
    expect(custom.periodMin).toBe(DAY);
    // Not any of the specific wordings above.
    expect(custom.label).toBe(describeCron("15 10 * 6 *").label);
    expect(custom.label).not.toBe(describeCron("0 6 * * *").label);
  });

  it("says an invalid schedule is not valid yet, without inventing a period shorter than a day", () => {
    const d = describeCron("not a schedule");
    expect(d.valid).toBe(false);
    expect(d.periodMin).toBe(DAY);
    expect(d.label).toBe(describeCron("* * *").label);
  });
});

describe("heartbeatIntervalSec", () => {
  it.each([
    ["* * * * *", 60],
    ["*/5 * * * *", 300],
    ["30 * * * *", 3600],
    ["0 */6 * * *", 21600],
    ["0 6 * * *", 86400],
  ])("derives %j's interval as %i s", (c, sec) => {
    expect(heartbeatIntervalSec(c)).toBe(sec);
  });

  it("holds weekly and monthly schedules to the table's one-day ceiling", () => {
    expect(heartbeatIntervalSec("30 9 * * 1")).toBe(86400);
    expect(heartbeatIntervalSec("0 3 1 * *")).toBe(86400);
  });

  it("never goes below a minute", () => {
    expect(heartbeatIntervalSec("*/1 * * * *")).toBe(60);
  });
});

/* When the next run is due (`nextRun`), the one answer the probe's deadlines and the dashboard's
   "Expected" cell share. Daylight saving in both directions, in a zone on each side of the
   Atlantic: 2026's changes are 8 March and 1 November in New York, 29 March and 25 October in
   Warsaw. */

const at = (iso: string) => Date.parse(iso);
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());

describe("nextRun", () => {
  it("finds the next minute that matches, strictly after the given instant", () => {
    expect(iso(nextRun("0 6 * * *", "UTC", at("2026-10-22T05:00:00Z")))).toBe("2026-10-22T06:00:00.000Z");
    expect(iso(nextRun("0 6 * * *", "UTC", at("2026-10-22T06:00:00Z")))).toBe("2026-10-23T06:00:00.000Z");
    expect(iso(nextRun("*/15 * * * *", "UTC", at("2026-10-22T10:07:30Z")))).toBe("2026-10-22T10:15:00.000Z");
    expect(iso(nextRun("5/20 * * * *", "UTC", at("2026-10-22T10:30:00Z")))).toBe("2026-10-22T10:45:00.000Z");
    expect(iso(nextRun("0 9 * * 1-5", "UTC", at("2026-10-23T10:00:00Z")))).toBe("2026-10-26T09:00:00.000Z");
    expect(iso(nextRun("0 3 1 * *", "UTC", at("2026-12-15T00:00:00Z")))).toBe("2027-01-01T03:00:00.000Z");
  });

  it("runs on a day matching either the day of the month or the weekday when both are restricted", () => {
    // The 13th, or any Friday: Friday 6 November comes first.
    expect(iso(nextRun("0 0 13 * 5", "UTC", at("2026-11-01T00:00:00Z")))).toBe("2026-11-06T00:00:00.000Z");
    // A star in either field leaves the other alone, and 7 is Sunday as well as 0.
    expect(iso(nextRun("0 0 * * 7", "UTC", at("2026-10-22T00:00:00Z")))).toBe("2026-10-25T00:00:00.000Z");
    expect(iso(nextRun("0 0 */10 * *", "UTC", at("2026-10-22T00:00:00Z")))).toBe("2026-10-31T00:00:00.000Z");
  });

  it("reads the fields in the schedule's time zone", () => {
    expect(iso(nextRun("0 6 * * *", "Europe/Warsaw", at("2026-07-01T00:00:00Z")))).toBe("2026-07-01T04:00:00.000Z");
    expect(iso(nextRun("0 6 * * *", "Europe/Warsaw", at("2026-12-01T00:00:00Z")))).toBe("2026-12-01T05:00:00.000Z");
    expect(iso(nextRun("0 9 * * *", "America/Los_Angeles", at("2026-10-22T00:00:00Z")))).toBe("2026-10-22T16:00:00.000Z");
  });

  it("spring forward: a time the clocks skip runs once, after the change, never not at all (New York)", () => {
    // 02:30 doesn't exist on 8 March: it runs at 03:30 EDT, then at 02:30 EDT the day after.
    const first = nextRun("30 2 * * *", "America/New_York", at("2026-03-07T12:00:00Z"));
    expect(iso(first)).toBe("2026-03-08T07:30:00.000Z");
    expect(iso(nextRun("30 2 * * *", "America/New_York", first!))).toBe("2026-03-09T06:30:00.000Z");
    // Hourly across the change: 01:00 EST, then 03:00 EDT once, then 04:00 EDT.
    const skipped = nextRun("0 * * * *", "America/New_York", at("2026-03-08T06:30:00Z"));
    expect(iso(skipped)).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(nextRun("0 * * * *", "America/New_York", skipped!))).toBe("2026-03-08T08:00:00.000Z");
  });

  it("fall back: a time that happens twice runs once, at its first occurrence (New York)", () => {
    const first = nextRun("30 1 * * *", "America/New_York", at("2026-10-31T12:00:00Z"));
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT
    // Not the repeated 01:30 EST an hour later: the next run is the day after.
    expect(iso(nextRun("30 1 * * *", "America/New_York", first!))).toBe("2026-11-02T06:30:00.000Z");
    // Hourly: 01:00 EDT, then 02:00 EST. The repeated 01:00 is not a second run.
    expect(iso(nextRun("0 * * * *", "America/New_York", at("2026-11-01T05:00:00Z")))).toBe("2026-11-01T07:00:00.000Z");
  });

  it("both directions in Warsaw too", () => {
    // 29 March: 02:30 is skipped, so it runs at 03:30 CEST.
    expect(iso(nextRun("30 2 * * *", "Europe/Warsaw", at("2026-03-28T12:00:00Z")))).toBe("2026-03-29T01:30:00.000Z");
    // 25 October: 02:30 happens at 00:30Z (CEST) and again at 01:30Z (CET); the first counts.
    const first = nextRun("30 2 * * *", "Europe/Warsaw", at("2026-10-24T12:00:00Z"));
    expect(iso(first)).toBe("2026-10-25T00:30:00.000Z");
    expect(iso(nextRun("30 2 * * *", "Europe/Warsaw", first!))).toBe("2026-10-26T01:30:00.000Z");
  });

  it("has no next run for a schedule that never runs or isn't valid", () => {
    expect(nextRun("0 0 31 2 *", "UTC", at("2026-01-01T00:00:00Z"))).toBeNull();
    expect(nextRun("not a schedule", "UTC", at("2026-01-01T00:00:00Z"))).toBeNull();
    expect(iso(nextRun("0 0 29 2 *", "UTC", at("2026-03-01T00:00:00Z")))).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("lastRun", () => {
  it("finds the latest run at or before the given instant, the mirror of nextRun", () => {
    expect(iso(lastRun("0 6 * * *", "UTC", at("2026-10-22T06:00:00Z")))).toBe("2026-10-22T06:00:00.000Z");
    expect(iso(lastRun("0 6 * * *", "UTC", at("2026-10-22T05:59:59Z")))).toBe("2026-10-21T06:00:00.000Z");
    expect(iso(lastRun("* * * * *", "UTC", at("2026-10-22T06:00:40Z")))).toBe("2026-10-22T06:00:00.000Z");
    expect(iso(lastRun("*/2 * * * *", "UTC", at("2026-10-22T06:03:40Z")))).toBe("2026-10-22T06:02:00.000Z");
    expect(iso(lastRun("0 9 * * 1-5", "UTC", at("2026-10-26T08:00:00Z")))).toBe("2026-10-23T09:00:00.000Z");
    expect(iso(lastRun("0 3 1 * *", "UTC", at("2027-01-01T02:00:00Z")))).toBe("2026-12-01T03:00:00.000Z");
    expect(iso(lastRun("0 0 13 * 5", "UTC", at("2026-11-12T00:00:00Z")))).toBe("2026-11-06T00:00:00.000Z");
  });

  it("agrees with nextRun across daylight-saving changes", () => {
    // The skipped 02:30 on 8 March ran at 03:30 EDT.
    expect(iso(lastRun("30 2 * * *", "America/New_York", at("2026-03-08T08:00:00Z")))).toBe("2026-03-08T07:30:00.000Z");
    // The repeated 01:00 on 1 November is not a second run.
    expect(iso(lastRun("0 * * * *", "America/New_York", at("2026-11-01T06:30:00Z")))).toBe("2026-11-01T05:00:00.000Z");
    expect(iso(lastRun("30 2 * * *", "Europe/Warsaw", at("2026-10-25T01:45:00Z")))).toBe("2026-10-25T00:30:00.000Z");
  });

  it("has no last run for a schedule that never runs or isn't valid", () => {
    expect(lastRun("0 0 31 2 *", "UTC", at("2026-01-01T00:00:00Z"))).toBeNull();
    expect(lastRun("not a schedule", "UTC", at("2026-01-01T00:00:00Z"))).toBeNull();
  });
});

describe("runOf and expectedAfter: which run a finish belongs to, and the run expected after it", () => {
  it("expects the first run after the last one accounted for, or after the version's start", () => {
    expect(iso(expectedAfter("0 6 * * *", "UTC", at("2026-10-22T06:00:00Z"), at("2026-10-01T00:00:00Z")))).toBe("2026-10-23T06:00:00.000Z");
    expect(iso(expectedAfter("0 6 * * *", "UTC", null, at("2026-10-22T05:00:00Z")))).toBe("2026-10-22T06:00:00.000Z");
    // An edit after the last run restarts the expectation from the edit.
    expect(iso(expectedAfter("0 6 * * *", "UTC", at("2026-10-21T06:00:00Z"), at("2026-10-22T12:00:00Z")))).toBe("2026-10-23T06:00:00.000Z");
  });

  it("gives a finish at or after the expected run the latest run at or before it, never the run after", () => {
    // Every minute, a job that takes 40 s: each finish is its own minute's, not the next one's.
    expect(iso(runOf("* * * * *", "UTC", at("2026-10-22T10:00:40Z"), at("2026-10-22T10:00:00Z")))).toBe("2026-10-22T10:00:00.000Z");
    // Every two minutes, a job that takes 100 s.
    expect(iso(runOf("*/2 * * * *", "UTC", at("2026-10-22T10:01:40Z"), at("2026-10-22T10:00:00Z")))).toBe("2026-10-22T10:00:00.000Z");
    // Hourly, a job that finishes 10 s before the next run: still its own hour.
    expect(iso(runOf("0 * * * *", "UTC", at("2026-10-22T10:59:50Z"), at("2026-10-22T10:00:00Z")))).toBe("2026-10-22T10:00:00.000Z");
    // Runs skipped while nobody reported: the finish is the latest run's.
    expect(iso(runOf("* * * * *", "UTC", at("2026-10-22T10:07:30Z"), at("2026-10-22T10:00:00Z")))).toBe("2026-10-22T10:07:00.000Z");
  });

  it("counts a finish a little early as the expected run's: 30 s, or a tenth of the gap after it when shorter", () => {
    // The job's clock ran 20 s ahead: its 06:00 run reported at 05:59:40.
    expect(iso(runOf("0 6 * * *", "UTC", at("2026-10-22T05:59:40Z"), at("2026-10-22T06:00:00Z")))).toBe("2026-10-22T06:00:00.000Z");
    expect(earlyFor("0 6 * * *", "UTC", at("2026-10-22T06:00:00Z"))).toBe(30_000);
    expect(earlyFor("* * * * *", "UTC", at("2026-10-22T06:00:00Z"))).toBe(6_000);
    expect(earlyFor("*/2 * * * *", "UTC", at("2026-10-22T06:00:00Z"))).toBe(12_000);
    expect(iso(runOf("* * * * *", "UTC", at("2026-10-22T10:00:55Z"), at("2026-10-22T10:01:00Z")))).toBe("2026-10-22T10:01:00.000Z");
  });

  it("gives an earlier finish no run: a manual run, a retry, or the late finish of a run already counted", () => {
    expect(runOf("0 6 * * *", "UTC", at("2026-10-22T05:00:00Z"), at("2026-10-22T06:00:00Z"))).toBeNull();
    expect(runOf("0 6 * * *", "UTC", at("2026-10-22T07:00:00Z"), at("2026-10-23T06:00:00Z"))).toBeNull();
    expect(runOf("* * * * *", "UTC", at("2026-10-22T10:00:50Z"), at("2026-10-22T10:01:00Z"))).toBeNull();
    expect(runOf("0 6 * * *", "UTC", at("2026-10-22T07:00:00Z"), null)).toBeNull();
  });
});
