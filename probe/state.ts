import type { CheckResult } from "../src/checks/types";

/* One state machine for every checked type (`spec.md § 2`). Pure: the store reads its state from
   the locked monitor row, steps an outcome, and commits the next state and effects together.
   Homes keep only check configuration, never a second copy of these counters.

   - A monitor starts `up` after its first passing check, and reaches `down` only through
     confirmation: a failure is re-checked at once from another location, and only a second
     failure counts. DNS asks the same two public resolvers from anywhere, so its confirmation is
     a second failing check in a row instead. A certificate that is invalid is the same from
     everywhere, so it is down at once; a certificate that can't be reached is confirmed.
   - `degraded` is three passing checks in a row over the slow threshold, and ends at the first
     that isn't.
   - A failure the second location didn't confirm is one location's noise. It counts toward
     neither streak and breaks neither, so a location that can't reach a target never holds an
     incident open or a monitor degraded.
   - An incident opens with the transition to `down`, and the monitor leaves `down` after two
     passes in a row; the store closes the incident with that transition (`store.ts`), and writes
     any transition only from the state the row holds, so the two move together. A version change
     resets the counters in SQL. Degraded still means slow until a fast pass, even after a reset.

   `paused` is not here: a paused monitor isn't scheduled at all, and its state is kept.

   A heartbeat goes through the same reducer, with two differences (`spec.md § 3.3, § 5`): its
   grace window is its confirmation, so a missed deadline, a `/fail`, a false assertion or a
   stuck run is down at once, and it recovers on the next good ping rather than after two
   passes, which for a daily job would hold an incident open a day after the job recovered
   (`AGENTS.md § 2.8`). What counts as each of those is `heartbeat.ts`. */

export type State = "up" | "degraded" | "down";
export type CheckedType = "http" | "tcp" | "ssl" | "dns" | "stripe" | "supabase";
/** Every type the reducer steps: the checked ones, and heartbeats, whose outcomes the home
    derives from what the receiver recorded (`heartbeat.ts`). */
export type JudgedType = CheckedType | "heartbeat";

export type MonitorState = {
  state: State | null;
  slowStreak: number;
  /** Passes in a row while down. */
  passStreak: number;
  /** Failing checks in a row that haven't moved the state yet (DNS's two-in-a-row). */
  failStreak: number;
};

export const fresh = (state: State | null = null): MonitorState => ({ state, slowStreak: 0, passStreak: 0, failStreak: 0 });

export type Located = CheckResult & { location: string };
export type Outcome = { first: Located; confirm?: Located };

export type Evidence = {
  failure: CheckResult["failure"];
  status?: number;
  assertion?: NonNullable<CheckResult["assertions"]>[number];
  snippet?: string;
  locations: string[];
};

export type Effect =
  | { kind: "transition"; from: State | null; to: State }
  | { kind: "open_incident"; evidence: Evidence }
  | { kind: "record_failure"; result: Located };

const DEGRADED_AFTER = 3;
const RECOVERED_AFTER = 2;
const DNS_DOWN_AFTER = 2;

/** Whether a failed check is re-checked from another location before it counts. The probe that
    made the check decides, before the result reaches the monitor's home, so the answer can't
    depend on the state: a failure is confirmed even while the monitor is already down. */
export function needsConfirmation(type: JudgedType, first: CheckResult): boolean {
  if (first.ok || type === "dns" || type === "heartbeat") return false;
  // Only a verdict on the certificate itself is settled at once: a handshake that broke off is
  // the network until a second location says otherwise.
  return !(type === "ssl" && first.failure?.kind === "cert");
}

function evidenceOf(o: Outcome): Evidence {
  const r = o.confirm && !o.confirm.ok ? o.confirm : o.first;
  return {
    failure: r.failure,
    status: r.status,
    assertion: r.assertions?.find((a) => !a.pass),
    snippet: r.snippet,
    locations: [o.first.location, ...(o.confirm && !o.confirm.ok ? [o.confirm.location] : [])],
  };
}

export function step(type: JudgedType, s: MonitorState, o: Outcome): { next: MonitorState; effects: Effect[] } {
  const effects: Effect[] = [];
  for (const r of [o.first, o.confirm]) if (r && !r.ok) effects.push({ kind: "record_failure", result: r });
  const move = (to: State) => {
    if (s.state !== to) effects.push({ kind: "transition", from: s.state, to });
  };

  if (type === "heartbeat") {
    // No second location and no streaks: one verdict moves the state. A heartbeat has no
    // locations to report, so its evidence names none.
    if (o.first.ok) {
      move("up");
      return { next: fresh("up"), effects };
    }
    if (s.state !== "down") {
      move("down");
      effects.push({ kind: "open_incident", evidence: { ...evidenceOf({ first: o.first }), locations: [] } });
    }
    return { next: fresh("down"), effects };
  }

  // The verdict on this round: a pass, a blip (failed, but the second location passed), a
  // failure not counted yet (DNS's first), or a counted failure. A failure that needed a second
  // location and arrived without one is never counted: an incident opens only on a confirmed
  // failure (`AGENTS.md`). The probe sends one whenever any location could look, itself after a
  // pause when it is the only one live.
  let verdict: "pass" | "blip" | "pending" | "fail" | "unconfirmed";
  if (o.first.ok) verdict = "pass";
  else if (o.confirm) verdict = o.confirm.ok ? "blip" : "fail";
  else if (needsConfirmation(type, o.first)) verdict = "unconfirmed";
  else if (type === "dns" && s.state !== "down") verdict = s.failStreak + 1 >= DNS_DOWN_AFTER ? "fail" : "pending";
  else verdict = "fail";

  // Noise, whether the second location passed or couldn't look: nothing moves.
  if (verdict === "unconfirmed" || verdict === "blip") return { next: s, effects };
  if (verdict === "pending") return { next: { ...s, failStreak: s.failStreak + 1, passStreak: 0 }, effects };

  if (verdict === "fail") {
    if (s.state !== "down") {
      move("down");
      effects.push({ kind: "open_incident", evidence: evidenceOf(o) });
    }
    return { next: { state: "down", slowStreak: 0, passStreak: 0, failStreak: 0 }, effects };
  }

  // A pass. The slow streak stops counting at the threshold, so a monitor that stays degraded
  // stops changing its state at all.
  const slowStreak = o.first.slow ? Math.min(s.slowStreak + 1, DEGRADED_AFTER) : 0;
  if (s.state === "down") {
    const passStreak = s.passStreak + 1;
    if (passStreak < RECOVERED_AFTER) return { next: { ...s, passStreak, slowStreak, failStreak: 0 }, effects };
    const to: State = slowStreak >= DEGRADED_AFTER ? "degraded" : "up";
    move(to);
    return { next: { state: to, slowStreak, passStreak: 0, failStreak: 0 }, effects };
  }
  const to: State = slowStreak >= DEGRADED_AFTER || (s.state === "degraded" && o.first.slow) ? "degraded" : "up";
  move(to);
  return { next: { state: to, slowStreak, passStreak: 0, failStreak: 0 }, effects };
}
