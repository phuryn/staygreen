import { describe, expect, it } from "vitest";
import type { CheckResult, FailureKind } from "../../src/checks/types";
import { fresh, needsConfirmation, step, type CheckedType, type Effect, type Located, type MonitorState, type Outcome } from "../../probe/state";

/* The state machine (`AGENTS.md`: one for every monitor type; an incident opens only on a
   confirmed transition to down and closes after two passes in a row). */

const passAt = (location = "tor1", slow = false): Located => ({ ok: true, ms: 120, slow, location });
const failAt = (location = "tor1", kind: FailureKind = "status", extra: Partial<CheckResult> = {}): Located => ({
  ok: false,
  ms: 300,
  location,
  failure: { kind, message: kind === "status" ? "Answered 503, expected 2xx" : `failed: ${kind}` },
  ...extra,
});

/** Feeds outcomes in order; returns the final state and every effect, by round. */
function run(type: CheckedType, outcomes: Outcome[], from: MonitorState = fresh()) {
  let s = from;
  const rounds: Effect[][] = [];
  for (const o of outcomes) {
    const r = step(type, s, o);
    s = r.next;
    rounds.push(r.effects);
  }
  return { s, rounds, all: rounds.flat() };
}

const kinds = (effects: Effect[]) => effects.filter((e) => e.kind !== "record_failure").map((e) => (e.kind === "transition" ? `${e.from}->${e.to}` : e.kind));
const pass = (slow = false): Outcome => ({ first: passAt("tor1", slow) });
const confirmed = (): Outcome => ({ first: failAt("tor1"), confirm: failAt("sfo3") });
const blip = (): Outcome => ({ first: failAt("tor1"), confirm: passAt("sfo3") });

describe("needsConfirmation", () => {
  it("is every failure of http and tcp, and every failure of ssl but a verdict on the certificate", () => {
    expect(needsConfirmation("http", failAt())).toBe(true);
    expect(needsConfirmation("tcp", failAt("tor1", "connect"))).toBe(true);
    expect(needsConfirmation("ssl", failAt("tor1", "connect"))).toBe(true);
    expect(needsConfirmation("ssl", failAt("tor1", "tls"))).toBe(true);
    expect(needsConfirmation("ssl", failAt("tor1", "cert"))).toBe(false);
    expect(needsConfirmation("dns", failAt("tor1", "mismatch"))).toBe(false);
    expect(needsConfirmation("http", passAt())).toBe(false);
  });
});

describe("step", () => {
  it("starts up at the first pass", () => {
    const { s, all } = run("http", [pass()]);
    expect(s.state).toBe("up");
    expect(kinds(all)).toEqual(["null->up"]);
  });

  it("goes down and opens one incident on a confirmed failure, with both locations as evidence", () => {
    const { s, all } = run("http", [pass(), { first: failAt("tor1", "status", { status: 503, snippet: "oops" }), confirm: failAt("sfo3", "status", { status: 503 }) }]);
    expect(s.state).toBe("down");
    expect(kinds(all)).toEqual(["null->up", "up->down", "open_incident"]);
    const open = all.find((e) => e.kind === "open_incident");
    expect(open).toMatchObject({ evidence: { locations: ["tor1", "sfo3"], status: 503, failure: { kind: "status" } } });
    expect(all.filter((e) => e.kind === "record_failure")).toHaveLength(2);
  });

  it("opens straight from no state when the first check already fails, confirmed", () => {
    expect(kinds(run("http", [confirmed()]).all)).toEqual(["null->down", "open_incident"]);
  });

  it("moves nothing when the second location passes, and keeps the failure", () => {
    const { s, all } = run("http", [pass(), blip()]);
    expect(s.state).toBe("up");
    expect(kinds(all)).toEqual(["null->up"]);
    expect(all.filter((e) => e.kind === "record_failure")).toHaveLength(1);
  });

  it("never counts a failure that needed a second location and came without one", () => {
    const { s, all } = run("http", [pass(), { first: failAt() }, { first: failAt() }]);
    expect(s.state).toBe("up");
    expect(kinds(all)).toEqual(["null->up"]);
  });

  it("stays down through more failures without a second incident", () => {
    const { s, all } = run("http", [confirmed(), confirmed(), confirmed()]);
    expect(s.state).toBe("down");
    expect(kinds(all)).toEqual(["null->down", "open_incident"]);
  });

  it("closes after two passes in a row, and not after one", () => {
    const { rounds, s } = run("http", [confirmed(), pass(), pass()]);
    expect(kinds(rounds[1])).toEqual([]);
    expect(kinds(rounds[2])).toEqual(["down->up"]);
    expect(s).toEqual(fresh("up"));
  });

  it("starts the two passes again after a confirmed failure in between", () => {
    expect(run("http", [confirmed(), pass(), confirmed(), pass()]).s.state).toBe("down");
    expect(kinds(run("http", [confirmed(), pass(), confirmed(), pass(), pass()]).all)).toEqual(["null->down", "open_incident", "down->up"]);
  });

  it("closes past a location that can't reach the target: its blips neither count nor break the passes", () => {
    // Rotating checks while down: sfo3 passes, tor1 fails and sfo3 confirms a pass, sfo3 passes.
    const { all } = run("http", [confirmed(), pass(), blip(), pass()]);
    expect(kinds(all)).toEqual(["null->down", "open_incident", "down->up"]);
    expect(run("http", [confirmed(), pass(), blip(), blip(), blip()]).s.state).toBe("down");
  });

  it("is degraded after three slow passes in a row, and up at the first fast one", () => {
    const { rounds, s } = run("http", [pass(true), pass(true), pass(true), pass(true), pass(false)]);
    expect(kinds(rounds[0])).toEqual(["null->up"]);
    expect(kinds(rounds[1])).toEqual([]);
    expect(kinds(rounds[2])).toEqual(["up->degraded"]);
    expect(kinds(rounds[3])).toEqual([]);
    expect(kinds(rounds[4])).toEqual(["degraded->up"]);
    expect(s.state).toBe("up");
  });

  it("counts slow passes past a blip, and a blip doesn't end degraded", () => {
    expect(run("http", [pass(true), pass(true), blip(), pass(true)]).s.state).toBe("degraded");
    const { rounds, s } = run("http", [pass(true), pass(true), pass(true), blip(), pass(true), pass(false)]);
    expect(kinds(rounds[3])).toEqual([]);
    expect(kinds(rounds[4])).toEqual([]);
    expect(kinds(rounds[5])).toEqual(["degraded->up"]);
    expect(s.state).toBe("up");
  });

  it("stops changing while steadily degraded, so a home has nothing to write", () => {
    const a = run("http", [pass(true), pass(true), pass(true)]).s;
    const b = step("http", a, pass(true)).next;
    expect(b).toEqual(a);
  });

  it("keeps degraded meaningful after counters reset: slow stays degraded, fast recovers", () => {
    const reset = fresh("degraded");
    expect(step("http", reset, pass(true)).next.state).toBe("degraded");
    expect(step("http", reset, pass(false)).next.state).toBe("up");
  });

  it("goes from degraded to down on a confirmed failure, and opens the incident", () => {
    expect(kinds(run("http", [pass(true), pass(true), pass(true), confirmed()]).all)).toEqual(["null->up", "up->degraded", "degraded->down", "open_incident"]);
  });

  it("takes a certificate that is invalid down at once, without a second location", () => {
    const { s, all } = run("ssl", [pass(), { first: failAt("tor1", "cert") }]);
    expect(s.state).toBe("down");
    expect(kinds(all)).toEqual(["null->up", "up->down", "open_incident"]);
  });

  it("confirms a certificate that can't be reached, or a handshake that broke off, like any connection", () => {
    expect(run("ssl", [pass(), { first: failAt("tor1", "tls") }]).s.state).toBe("up");
    expect(run("ssl", [pass(), { first: failAt("tor1", "connect") }]).s.state).toBe("up");
    expect(run("ssl", [pass(), { first: failAt("tor1", "connect"), confirm: failAt("sfo3", "connect") }]).s.state).toBe("down");
  });

  it("takes DNS down at the second failing check in a row", () => {
    const fail = (): Outcome => ({ first: failAt("tor1", "mismatch") });
    const { rounds, s } = run("dns", [pass(), fail(), fail()]);
    expect(kinds(rounds[1])).toEqual([]);
    expect(kinds(rounds[2])).toEqual(["up->down", "open_incident"]);
    expect(s.state).toBe("down");
    expect(run("dns", [pass(), fail(), pass(), fail()]).s.state).toBe("up");
  });

  it("closes a DNS incident after two passes too", () => {
    const fail = (): Outcome => ({ first: failAt("tor1", "dns") });
    expect(kinds(run("dns", [fail(), fail(), pass(), pass()]).all)).toEqual(["null->down", "open_incident", "down->up"]);
  });

  it("picks the confirmation's failure as the evidence, and the first's when only it failed", () => {
    const open = run("http", [{ first: failAt("tor1", "timeout"), confirm: failAt("sfo3", "status", { status: 502 }) }]).all.find((e) => e.kind === "open_incident");
    expect(open).toMatchObject({ evidence: { failure: { kind: "status" }, status: 502 } });
  });

  it("carries the failing assertion into the evidence", () => {
    const a = { path: "$.db.ok", op: "==", expected: "true", got: "false", pass: false };
    const bad = (location: string) => failAt(location, "assertion", { assertions: [{ ...a, path: "$.status", pass: true }, a] });
    const open = run("http", [{ first: bad("tor1"), confirm: bad("sfo3") }]).all.find((e) => e.kind === "open_incident");
    expect(open).toMatchObject({ evidence: { assertion: a } });
  });
});
