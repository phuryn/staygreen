import { describe, expect, it } from "vitest";
import { configOf, DEADLINE_MARGIN_MS, judge, plan, type HeartbeatRow, type Ping } from "../../probe/heartbeat";
import { fresh, needsConfirmation, step, type Effect, type State } from "../../probe/state";

/* A heartbeat's verdicts, at the reducer's level (`probe/heartbeat.ts`, `probe/state.ts`): what
   the home judges from the latest pings the receiver keeps, and how each verdict moves the state.
   `settle` plays the store: it plans, judges, steps and applies the cursor until nothing is due,
   as `Store.judgeHeartbeat` does one transaction at a time. The same story against a real
   Postgres, through the real functions, is `tests/integration/heartbeat.test.ts`. */

const t = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;
const MIN = 60_000;

const daily = configOf({ schedule: "0 6 * * *", tz: "UTC", graceMin: 5, maxRunMin: 30, assertions: [{ path: "emails_sent", op: ">", value: "0" }] });

function row(over: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return {
    state: null, versionAt: t("2026-10-01T00:00:00Z"), config: daily, ping: null, start: null, fail: null,
    finishes: 0, judgedAt: null, judgedFinishes: 0, runAt: null, ...over,
  };
}

const ping = (iso: string, payload: Record<string, unknown> = { emails_sent: 12 }, note: string | null = null): Ping => ({ at: t(iso), payload, note });

/** What the receiver does: the newest of each kind replaces the last, and finishes are counted. */
function arrive(r: HeartbeatRow, kind: "ping" | "start" | "fail", p: Ping): HeartbeatRow {
  return { ...r, [kind]: p, finishes: r.finishes + (kind === "start" ? 0 : 1) };
}

type Story = { row: HeartbeatRow; effects: Effect[]; transitions: string[]; incidents: number; open: boolean; runs: { at: string; ok: boolean }[]; failures: string[] };

/** Judge everything due at `now`, as the store and the reducer would. */
function settle(s: Story, now: number): Story {
  for (let i = 0; i < 100; i++) {
    const p = plan(s.row, now);
    if (!p.event) return s;
    const j = judge(s.row, p.event, "tor1");
    const { next, effects } = step("heartbeat", fresh(s.row.state as State | null), { first: j.outcome });
    for (const e of effects) {
      if (e.kind === "transition") {
        s.transitions.push(`${e.from}->${e.to}`);
        if (e.from === "down") s.open = false;
      }
      if (e.kind === "open_incident" && !s.open) {
        s.incidents++;
        s.open = true;
      }
      if (e.kind === "record_failure") s.failures.push(e.result.failure!.kind);
    }
    s.effects.push(...effects);
    s.runs.push(...j.runs.map((r) => ({ at: new Date(r.at).toISOString(), ok: r.ok })));
    s.row = { ...s.row, state: next.state, judgedAt: j.cursor.judgedAt, judgedFinishes: j.cursor.judgedFinishes, runAt: j.cursor.runAt };
  }
  throw new Error("never settled");
}

const story = (r: HeartbeatRow = row()): Story => ({ row: r, effects: [], transitions: [], incidents: 0, open: false, runs: [], failures: [] });

/** A heartbeat that has been up since its 06:00 run on 21 October. */
function upSince21st(): Story {
  const s = story(arrive(row(), "ping", ping("2026-10-21T06:00:10Z")));
  return settle(s, t("2026-10-21T06:00:20Z"));
}

describe("the reducer's heartbeat outcomes", () => {
  const ok = { ok: true, ms: 0, location: "tor1" };
  const bad = { ok: false, ms: 0, location: "tor1", failure: { kind: "missed" as const, message: "No ping" } };
  const kinds = (es: Effect[]) => es.map((e) => (e.kind === "transition" ? `${e.from}->${e.to}` : e.kind));

  it("never waits for a second location: a heartbeat's grace window is its confirmation", () => {
    expect(needsConfirmation("heartbeat", bad)).toBe(false);
  });

  it("goes up on the first good ping, down at once on a failure with one incident, and up on the next good ping", () => {
    expect(kinds(step("heartbeat", fresh(), { first: ok }).effects)).toEqual(["null->up"]);
    const down = step("heartbeat", fresh("up"), { first: bad });
    expect(down.next.state).toBe("down");
    expect(kinds(down.effects)).toEqual(["record_failure", "up->down", "open_incident"]);
    // Still down: the failure is recorded, nothing opens again.
    expect(kinds(step("heartbeat", fresh("down"), { first: bad }).effects)).toEqual(["record_failure"]);
    // One good ping recovers it, not two (`spec.md § 3.3`).
    expect(kinds(step("heartbeat", fresh("down"), { first: ok }).effects)).toEqual(["down->up"]);
    expect(step("heartbeat", fresh("up"), { first: ok }).effects).toEqual([]);
  });

  it("opens an incident that names no location: nobody checked from anywhere", () => {
    const open = step("heartbeat", fresh("up"), { first: bad }).effects.find((e) => e.kind === "open_incident");
    expect(open).toMatchObject({ evidence: { locations: [] } });
  });
});

describe("a heartbeat's verdicts", () => {
  it("says No ping yet for ever until the first ping: no deadline without one", () => {
    const s = settle(story(), t("2026-12-31T00:00:00Z"));
    expect(s.row.state).toBeNull();
    expect(s.effects).toEqual([]);
    expect(plan(s.row, t("2026-12-31T00:00:00Z"))).toEqual({ event: null, due: null });
  });

  it("goes from No ping yet to up on its first good ping, and counts the run", () => {
    const s = upSince21st();
    expect(s.row.state).toBe("up");
    expect(s.transitions).toEqual(["null->up"]);
    expect(s.runs).toEqual([{ at: "2026-10-21T06:00:10.000Z", ok: true }]);
  });

  it("missed: no ping by the expected run plus grace opens one incident, judged 5 s after the deadline; the next good ping closes it", () => {
    let s = upSince21st();
    // The next run is 22 October 06:00, its deadline 06:05.
    expect(plan(s.row, t("2026-10-22T06:05:00Z") + DEADLINE_MARGIN_MS - 1)).toEqual({ event: null, due: t("2026-10-22T06:05:00Z") });
    s = settle(s, t("2026-10-22T06:05:05Z"));
    expect(s.row.state).toBe("down");
    expect(s.incidents).toBe(1);
    expect(s.failures).toEqual(["missed"]);
    expect(s.runs.at(-1)).toEqual({ at: "2026-10-22T06:00:00.000Z", ok: false });
    // An hour late: it recovers, but the late run was already counted missed, so it isn't counted again.
    s = settle({ ...s, row: arrive(s.row, "ping", ping("2026-10-22T07:00:00Z")) }, t("2026-10-22T07:00:10Z"));
    expect(s.row.state).toBe("up");
    expect(s.transitions).toEqual(["null->up", "up->down", "down->up"]);
    expect(s.open).toBe(false);
    expect(s.runs).toHaveLength(2);
    // And the next day's 06:00 run counts as on time.
    s = settle({ ...s, row: arrive(s.row, "ping", ping("2026-10-23T06:00:30Z")) }, t("2026-10-23T06:01:00Z"));
    expect(s.runs.at(-1)).toEqual({ at: "2026-10-23T06:00:30.000Z", ok: true });
  });

  it("failed by /fail: one incident, and the next good ping closes it", () => {
    let s = upSince21st();
    s = settle({ ...s, row: arrive(s.row, "fail", ping("2026-10-22T06:00:20Z", { error: "smtp down" })) }, t("2026-10-22T06:00:30Z"));
    expect(s.row.state).toBe("down");
    expect(s.incidents).toBe(1);
    expect(s.failures).toEqual(["fail"]);
    expect(s.runs.at(-1)).toEqual({ at: "2026-10-22T06:00:20.000Z", ok: false });
    // The /fail counted for 22 October's run, so no deadline is missed that day.
    s = settle(s, t("2026-10-22T23:00:00Z"));
    expect(s.incidents).toBe(1);
    s = settle({ ...s, row: arrive(s.row, "ping", ping("2026-10-23T06:00:20Z")) }, t("2026-10-23T06:00:30Z"));
    expect(s.row.state).toBe("up");
    expect(s.open).toBe(false);
  });

  it("failed by a false assertion: judged with the same code as an HTTP body's, one incident, closed by a passing ping", () => {
    let s = upSince21st();
    s = settle({ ...s, row: arrive(s.row, "ping", ping("2026-10-22T06:00:20Z", { emails_sent: 0 })) }, t("2026-10-22T06:00:30Z"));
    expect(s.row.state).toBe("down");
    expect(s.incidents).toBe(1);
    const failure = s.effects.find((e) => e.kind === "record_failure");
    expect(failure).toMatchObject({ result: { failure: { kind: "assertion", message: "emails_sent > 0 failed: got 0" } } });
    s = settle({ ...s, row: arrive(s.row, "ping", ping("2026-10-22T06:30:00Z", { emails_sent: "3" })) }, t("2026-10-22T06:30:10Z"));
    expect(s.row.state).toBe("up");
    expect(s.open).toBe(false);
  });

  it("says why a field is missing when the ping's body couldn't be read", () => {
    const s = settle(story(arrive(row(), "ping", ping("2026-10-21T06:00:10Z", {}, "not_json"))), t("2026-10-21T06:00:20Z"));
    expect(s.effects.find((e) => e.kind === "record_failure")).toMatchObject({
      result: { failure: { message: "emails_sent > 0 failed: got nothing, its body wasn't a JSON object" } },
    });
  });

  it("stuck: a /start with no finish within the max run time opens one incident; the finish closes it", () => {
    let s = upSince21st();
    s = { ...s, row: arrive(s.row, "start", ping("2026-10-22T06:00:00Z", {})) };
    // The run is open, so 06:05's missed deadline waits on the run: nothing at 06:10.
    s = settle(s, t("2026-10-22T06:10:00Z"));
    expect(s.row.state).toBe("up");
    expect(plan(s.row, t("2026-10-22T06:10:00Z")).due).toBe(t("2026-10-22T06:30:00Z"));
    s = settle(s, t("2026-10-22T06:30:05Z"));
    expect(s.row.state).toBe("down");
    expect(s.failures).toEqual(["stuck"]);
    expect(s.incidents).toBe(1);
    expect(s.runs.at(-1)).toEqual({ at: "2026-10-22T06:00:00.000Z", ok: false });
    s = settle({ ...s, row: arrive(s.row, "ping", ping("2026-10-22T06:40:00Z")) }, t("2026-10-22T06:40:10Z"));
    expect(s.row.state).toBe("up");
    expect(s.open).toBe(false);
    // The stuck run's own finish, not a second run.
    expect(s.runs.filter((r) => r.at.startsWith("2026-10-22"))).toHaveLength(1);
  });

  it("a run that started on time and finishes inside its max run time is on time, however long past the grace", () => {
    let s = upSince21st();
    s = { ...s, row: arrive(s.row, "start", ping("2026-10-22T06:00:00Z", {})) };
    s = settle({ ...s, row: arrive(s.row, "ping", ping("2026-10-22T06:20:00Z")) }, t("2026-10-22T06:25:00Z"));
    expect(s.row.state).toBe("up");
    expect(s.runs.at(-1)).toEqual({ at: "2026-10-22T06:20:00.000Z", ok: true });
    const pass = judge(arrive(upSince21st().row, "start", ping("2026-10-22T06:00:00Z", {})), { kind: "ping", at: t("2026-10-22T06:20:00Z"), ping: ping("2026-10-22T06:20:00Z"), last: true }, "tor1");
    expect(pass.outcome.ms).toBe(20 * MIN);
  });

  it("never loses a /fail to a good ping after it, both between two reads: it opens, then the ping closes", () => {
    let s = upSince21st();
    let r = arrive(s.row, "fail", ping("2026-10-22T06:00:10Z", { error: "x" }));
    r = arrive(r, "ping", ping("2026-10-22T06:00:20Z"));
    s = settle({ ...s, row: r }, t("2026-10-22T06:00:40Z"));
    expect(s.transitions).toEqual(["null->up", "up->down", "down->up"]);
    expect(s.incidents).toBe(1);
    expect(s.open).toBe(false);
    expect(s.row.judgedFinishes).toBe(s.row.finishes);
  });

  it("counts a ping up to 30 s early as the scheduled run's", () => {
    let s = upSince21st();
    s = settle({ ...s, row: arrive(s.row, "ping", ping("2026-10-22T05:59:40Z")) }, t("2026-10-22T05:59:50Z"));
    // Not 22 October 06:05 but 23 October's.
    expect(plan(s.row, t("2026-10-22T07:00:00Z")).due).toBe(t("2026-10-23T06:05:00Z"));
    expect(s.row.runAt).toBe(t("2026-10-22T06:00:00Z"));
    expect(s.runs).toHaveLength(2);
  });

  const minutely = configOf({ schedule: "* * * * *", tz: "UTC", graceMin: 5, maxRunMin: 30, assertions: [] });
  const fromNine = (config = minutely) => story(row({ config, versionAt: t("2026-10-22T09:00:00Z") }));
  const finishAt = (s: Story, iso: string, kind: "ping" | "fail" = "ping") => settle({ ...s, row: arrive(s.row, kind, ping(iso, {})) }, t(iso) + 5_000);

  it("every minute, a job that takes 40 s: each finish is its own minute's run, and a dead job is missed from the run after its last", () => {
    let s = fromNine();
    for (const m of ["10:00", "10:01", "10:02"]) s = finishAt(s, `2026-10-22T${m}:40Z`);
    expect(s.runs.map((r) => r.ok)).toEqual([true, true, true]);
    expect(s.row.runAt).toBe(t("2026-10-22T10:02:00Z"));
    // Dead after 10:02's run: 10:03 is the run missed, by 10:08, not 10:04 by 10:09.
    expect(plan(s.row, t("2026-10-22T10:05:00Z")).due).toBe(t("2026-10-22T10:08:00Z"));
    s = settle(s, t("2026-10-22T10:08:05Z"));
    expect(s.row.state).toBe("down");
    expect(s.runs.filter((r) => !r.ok).map((r) => r.at)).toEqual(["2026-10-22T10:03:00.000Z"]);
  });

  it("every minute: a second finish in the same minute is a retry, counted once and moving nothing", () => {
    let s = fromNine();
    s = finishAt(s, "2026-10-22T10:00:20Z", "fail");
    s = finishAt(s, "2026-10-22T10:00:45Z");
    expect(s.row.state).toBe("up");
    expect(s.runs.map((r) => r.ok)).toEqual([false]);
    expect(plan(s.row, t("2026-10-22T10:01:00Z")).due).toBe(t("2026-10-22T10:06:00Z"));
  });

  it("every two minutes, a job that takes 100 s: each finish is its own run, never the next one's", () => {
    let s = fromNine(configOf({ schedule: "*/2 * * * *", tz: "UTC", graceMin: 5, maxRunMin: 30, assertions: [] }));
    for (const m of ["10:01", "10:03", "10:05"]) s = finishAt(s, `2026-10-22T${m}:40Z`);
    expect(s.runs.map((r) => r.ok)).toEqual([true, true, true]);
    expect(s.row.runAt).toBe(t("2026-10-22T10:04:00Z"));
    // 10:06 is expected next, its deadline 10:11, not 10:08's 10:13.
    expect(plan(s.row, t("2026-10-22T10:06:00Z")).due).toBe(t("2026-10-22T10:11:00Z"));
  });

  it("a run longer than its period that sent /start finishes its own run, by its start", () => {
    let s = fromNine(configOf({ schedule: "*/2 * * * *", tz: "UTC", graceMin: 5, maxRunMin: 30, assertions: [] }));
    s = finishAt(s, "2026-10-22T09:58:40Z");
    s = { ...s, row: arrive(s.row, "start", ping("2026-10-22T10:00:00Z", {})) };
    s = finishAt(s, "2026-10-22T10:02:10Z");
    expect(s.row.runAt).toBe(t("2026-10-22T10:00:00Z"));
    expect(plan(s.row, t("2026-10-22T10:03:00Z")).due).toBe(t("2026-10-22T10:07:00Z"));
  });

  it("an hourly job with an hour's grace that finishes just before the next hour keeps its own hour", () => {
    let s = story(row({ config: configOf({ schedule: "0 * * * *", tz: "UTC", graceMin: 60, maxRunMin: 90, assertions: [] }), versionAt: t("2026-10-22T08:30:00Z") }));
    s = finishAt(s, "2026-10-22T09:00:30Z");
    expect(s.row.runAt).toBe(t("2026-10-22T09:00:00Z"));
    s = finishAt(s, "2026-10-22T10:59:50Z");
    expect(s.row.runAt).toBe(t("2026-10-22T10:00:00Z"));
    expect(plan(s.row, t("2026-10-22T11:00:00Z")).due).toBe(t("2026-10-22T12:00:00Z"));
  });

  it("judges days missed while no probe was live in one event, with one incident and each run counted", () => {
    let s = upSince21st();
    s = settle(s, t("2026-10-25T12:00:00Z"));
    expect(s.incidents).toBe(1);
    expect(s.failures).toEqual(["missed"]);
    expect(s.runs.filter((r) => !r.ok).map((r) => r.at)).toEqual([
      "2026-10-22T06:00:00.000Z", "2026-10-23T06:00:00.000Z", "2026-10-24T06:00:00.000Z", "2026-10-25T06:00:00.000Z",
    ]);
    expect(s.effects.find((e) => e.kind === "record_failure")).toMatchObject({ result: { failure: { message: expect.stringContaining("and 3 more expected runs") } } });
  });

  it("gives a deadline the benefit of the doubt when a finish it might have met was overwritten unseen", () => {
    const s = upSince21st();
    // Two good pings arrived while no probe judged: 22 October's on time, 23 October's after.
    // Only the newest is left, but the count says another came between.
    let r = arrive(s.row, "ping", ping("2026-10-22T06:00:10Z"));
    r = arrive(r, "ping", ping("2026-10-23T06:00:10Z"));
    const later = settle({ ...s, row: r }, t("2026-10-23T08:00:00Z"));
    expect(later.row.state).toBe("up");
    expect(later.incidents).toBe(0);
    expect(later.row.judgedFinishes).toBe(later.row.finishes);
    // With nothing hidden, the same gap is a missed run.
    const strict = settle({ ...s, row: arrive(s.row, "ping", ping("2026-10-23T06:00:10Z")) }, t("2026-10-23T08:00:00Z"));
    expect(strict.incidents).toBe(1);
  });

  it("restarts the expectation at an edit, pause or resume, and leaves pings from before it unjudged", () => {
    const s = upSince21st();
    // A /fail just before a resume at 12:00 on 22 October, never judged before it: fenced.
    const resumed = { ...arrive(s.row, "fail", ping("2026-10-22T11:59:00Z", {})), versionAt: t("2026-10-22T12:00:00Z") };
    const after = settle({ ...s, row: resumed }, t("2026-10-22T13:00:00Z"));
    expect(after.row.state).toBe("up");
    expect(after.failures).toEqual([]);
    // The next expected run is the first after the resume: 23 October.
    expect(plan(after.row, t("2026-10-22T13:00:00Z")).due).toBe(t("2026-10-23T06:05:00Z"));
  });

  it("an edit to the schedule moves the next deadline, read from the shared cron module", () => {
    const s = upSince21st();
    const hourly = { ...s.row, config: { ...s.row.config, schedule: "30 * * * *" }, versionAt: t("2026-10-21T06:10:00Z") };
    expect(plan(hourly, t("2026-10-21T06:20:00Z")).due).toBe(t("2026-10-21T06:35:00Z"));
  });

  it("follows the schedule's time zone through a daylight-saving change", () => {
    const ny = configOf({ schedule: "30 2 * * *", tz: "America/New_York", graceMin: 5, maxRunMin: 30, assertions: [] });
    // Up since 7 March 02:30 EST; 8 March's 02:30 is skipped by the clocks and runs at 03:30 EDT.
    const r = row({ state: "up", config: ny, versionAt: t("2026-03-01T00:00:00Z"), ping: ping("2026-03-07T07:30:10Z", {}), finishes: 1, judgedAt: t("2026-03-07T07:30:10Z"), judgedFinishes: 1, runAt: t("2026-03-07T07:30:00Z") });
    expect(new Date(plan(r, t("2026-03-07T12:00:00Z")).due!).toISOString()).toBe("2026-03-08T07:35:00.000Z");
  });

  it("has no deadline for a schedule that never runs or a time zone the runtime doesn't know", () => {
    const never = row({ state: "up", config: { ...daily, schedule: "0 0 31 2 *" }, ping: ping("2026-10-21T06:00:10Z"), finishes: 1, judgedAt: t("2026-10-21T06:00:10Z"), judgedFinishes: 1, runAt: t("2026-10-21T06:00:10Z") });
    expect(plan(never, t("2027-01-01T00:00:00Z"))).toEqual({ event: null, due: null });
    expect(plan({ ...never, config: { ...daily, tz: "Mars/Olympus" } }, t("2027-01-01T00:00:00Z"))).toEqual({ event: null, due: null });
  });

  it("reads a monitor's config with defaults for anything missing", () => {
    expect(configOf({})).toEqual({ schedule: "", tz: "UTC", graceMin: 5, maxRunMin: 60, assertions: [] });
    expect(configOf({ assertions: [{ path: "n", op: ">=", value: 1 }, null] }).assertions).toEqual([{ path: "n", op: ">=", value: "1" }]);
  });

  it("keeps time order across days: nothing is judged twice or skipped", () => {
    let s = upSince21st();
    for (let d = 22; d <= 28; d++) {
      const day = `2026-10-${d}`;
      if (d === 24) continue; // missed
      s = { ...s, row: arrive(s.row, "ping", ping(`${day}T06:01:00Z`)) };
      s = settle(s, t(`${day}T06:02:00Z`));
    }
    s = settle(s, t("2026-10-28T12:00:00Z"));
    expect(s.incidents).toBe(1);
    expect(s.runs.map((r) => `${r.at.slice(5, 10)} ${r.ok}`)).toEqual([
      "10-21 true", "10-22 true", "10-23 true", "10-24 false", "10-25 true", "10-26 true", "10-27 true", "10-28 true",
    ]);
    expect(s.row.judgedAt).toBe(t("2026-10-28T06:01:00Z"));
    expect(t("2026-10-28T06:01:00Z") + DAY).toBeGreaterThan(s.row.judgedAt!);
  });
});
