import { describe, expect, it } from "vitest";
import { confirmersFor, eligible, hash32, nextDue, ranked, TimerWheel, type ProbeInfo } from "../../probe/schedule";

/* Who checks a monitor and when (`spec.md § 4`): each check from one location, rotating; a probe
   that drops out is covered by the rest without a handover. */

const nyc: ProbeInfo = { id: "tor1-a", location: "tor1", builderOnly: false };
const sfo: ProbeInfo = { id: "sfo3-a", location: "sfo3", builderOnly: false };
const fra: ProbeInfo = { id: "fra1-a", location: "fra1", builderOnly: true };
const all = [nyc, sfo, fra];
const ids = (n: number) => Array.from({ length: n }, (_, i) => `mon_${i.toString(36).padStart(6, "0")}`);

/** Which probe checks each monitor in each second of [from, to): simulated with the wheel the
    way the runtime does it, one wheel per probe. */
function simulate(monitors: string[], probes: ProbeInfo[], intervalSec: number, from: number, to: number) {
  const checks = new Map<string, { at: number; by: string }[]>();
  for (const p of probes) {
    const wheel = new TimerWheel(from - 1);
    const place = (id: string) => {
      const order = ranked(id, probes);
      const k = order.findIndex((x) => x.id === p.id);
      wheel.schedule(id, nextDue(wheel.last, id, intervalSec, k, order.length));
    };
    monitors.forEach(place);
    for (let t = from; t < to; t++) {
      for (const id of wheel.advance(t)) {
        checks.set(id, [...(checks.get(id) ?? []), { at: t, by: p.id }]);
        place(id);
      }
    }
  }
  for (const list of checks.values()) list.sort((a, b) => a.at - b.at);
  return checks;
}

describe("hash32", () => {
  it("is stable and spreads nearby ids", () => {
    expect(hash32("mon_abc")).toBe(hash32("mon_abc"));
    expect(hash32("mon_abc")).not.toBe(hash32("mon_abd"));
    const buckets = new Array(10).fill(0);
    for (const id of ids(10_000)) buckets[hash32(id) % 10]++;
    for (const b of buckets) expect(b).toBeGreaterThan(850);
  });
});

describe("ranked", () => {
  it("is the same whatever order the live set arrives in", () => {
    for (const id of ids(50)) expect(ranked(id, [fra, sfo, nyc]).map((p) => p.id)).toEqual(ranked(id, all).map((p) => p.id));
  });

  it("homes monitors evenly", () => {
    const homes = new Map<string, number>();
    for (const id of ids(9_000)) {
      const h = ranked(id, all)[0].id;
      homes.set(h, (homes.get(h) ?? 0) + 1);
    }
    for (const n of homes.values()) expect(n).toBeGreaterThan(2_700);
  });

  it("moves only the monitors of a probe that drops out", () => {
    for (const id of ids(2_000)) {
      const before = ranked(id, all);
      const after = ranked(id, [nyc, sfo]);
      expect(after.map((p) => p.id)).toEqual(before.filter((p) => p.id !== fra.id).map((p) => p.id));
    }
  });
});

describe("eligible", () => {
  it("leaves the builder-only probe out of a Free monitor's set", () => {
    expect(eligible(all, false)).toEqual([nyc, sfo]);
    expect(eligible(all, true)).toEqual(all);
  });
});

describe("nextDue", () => {
  it("is strictly after the given second, and a whole period later when it falls on a slot", () => {
    const t = nextDue(1_000_000, "mon_x", 60, 0, 1);
    expect(t).toBeGreaterThan(1_000_000);
    expect(t - 1_000_000).toBeLessThanOrEqual(60);
    expect(nextDue(t, "mon_x", 60, 0, 1)).toBe(t + 60);
  });

  it("puts the ranks of one monitor an interval apart", () => {
    const after = 1_000_000;
    const slots = [0, 1, 2].map((k) => nextDue(after, "mon_x", 60, k, 3) % 180);
    const sorted = [...slots].sort((a, b) => a - b);
    expect(new Set(slots).size).toBe(3);
    expect((sorted[1] - sorted[0]) % 60).toBe(0);
    expect((sorted[2] - sorted[1]) % 60).toBe(0);
  });
});

describe("the rotation", () => {
  const monitors = ids(300);
  const start = 1_800_000_000;

  it("checks every monitor once per interval, from each location in turn", () => {
    const checks = simulate(monitors, all, 60, start, start + 1_800);
    for (const id of monitors) {
      const list = checks.get(id)!;
      expect(list.length).toBeGreaterThanOrEqual(29);
      expect(list.length).toBeLessThanOrEqual(30);
      for (let i = 1; i < list.length; i++) {
        expect(list[i].at - list[i - 1].at).toBe(60);
        expect(list[i].by).not.toBe(list[i - 1].by);
      }
      const order = ranked(id, all).map((p) => p.id);
      expect(new Set(list.slice(0, 3).map((c) => c.by))).toEqual(new Set(order));
    }
  });

  it("is still once per interval after a probe drops out, with no handover", () => {
    const checks = simulate(monitors, [nyc, sfo], 60, start, start + 600);
    for (const id of monitors) {
      const list = checks.get(id)!;
      for (let i = 1; i < list.length; i++) expect(list[i].at - list[i - 1].at).toBe(60);
      expect(list.every((c) => c.by !== fra.id)).toBe(true);
    }
  });

  it("spreads checks across the seconds instead of the top of the minute", () => {
    const checks = simulate(monitors, all, 60, start, start + 60);
    const perSecond = new Map<number, number>();
    for (const list of checks.values()) for (const c of list) perSecond.set(c.at, (perSecond.get(c.at) ?? 0) + 1);
    expect(Math.max(...perSecond.values())).toBeLessThan(20);
  });
});

describe("confirmersFor", () => {
  const idsOf = (ps: ProbeInfo[]) => ps.map((p) => p.id);

  it("follows the ranking from the probe that saw the failure, so each probe asks a different one first", () => {
    const order = [nyc, sfo, fra];
    expect(idsOf(confirmersFor(order, nyc.id, false))).toEqual([sfo.id, fra.id]);
    expect(idsOf(confirmersFor(order, sfo.id, false))).toEqual([fra.id, nyc.id]);
    expect(idsOf(confirmersFor(order, fra.id, false))).toEqual([nyc.id, sfo.id]);
  });

  it("puts a probe on the other continent first when the plan allows it, keeping the rest as fallbacks", () => {
    // Seen from the US: Frankfurt is asked before the other US location, whatever the ranking says.
    expect(idsOf(confirmersFor([nyc, sfo, fra], nyc.id, true))).toEqual([fra.id, sfo.id]);
    expect(idsOf(confirmersFor([sfo, nyc, fra], sfo.id, true))).toEqual([fra.id, nyc.id]);
    // Seen from Frankfurt: both others are on the other continent, so the ranking decides.
    expect(idsOf(confirmersFor([fra, nyc, sfo], fra.id, true))).toEqual([nyc.id, sfo.id]);
    expect(idsOf(confirmersFor([fra, sfo, nyc], fra.id, true))).toEqual([sfo.id, nyc.id]);
    // With Frankfurt not live, the same continent still confirms.
    expect(idsOf(confirmersFor([nyc, sfo], nyc.id, true))).toEqual([sfo.id]);
  });

  it("leaves out probes at the same location, and is empty when no other location is live", () => {
    const nycB: ProbeInfo = { ...nyc, id: "tor1-b" };
    expect(idsOf(confirmersFor([nyc, nycB, sfo], nyc.id, false))).toEqual([sfo.id]);
    expect(confirmersFor([nyc, nycB], nyc.id, false)).toEqual([]);
    expect(confirmersFor([nyc], nyc.id, true)).toEqual([]);
    expect(confirmersFor([sfo], nyc.id, true)).toEqual([]);
  });
});

describe("TimerWheel", () => {
  it("hands out what is due, earliest first, once", () => {
    const w = new TimerWheel(99);
    w.schedule("b", 102);
    w.schedule("a", 101);
    w.schedule("c", 105);
    expect(w.advance(100)).toEqual([]);
    expect(w.advance(103)).toEqual(["a", "b"]);
    expect(w.advance(103)).toEqual([]);
    expect(w.size).toBe(1);
    expect(w.advance(200)).toEqual(["c"]);
    expect(w.last).toBe(200);
  });

  it("keeps one entry per monitor: scheduling again moves it, cancelling removes it", () => {
    const w = new TimerWheel(0);
    w.schedule("a", 5);
    w.schedule("a", 3);
    expect(w.when("a")).toBe(3);
    expect(w.size).toBe(1);
    w.schedule("b", 4);
    w.cancel("b");
    expect(w.advance(10)).toEqual(["a"]);
  });

  it("never schedules into a second it has already handled", () => {
    const w = new TimerWheel(0);
    w.advance(50);
    w.schedule("late", 10);
    expect(w.when("late")).toBe(51);
    expect(w.advance(51)).toEqual(["late"]);
  });

  it("catches up after a long stall without walking every second", () => {
    const w = new TimerWheel(0);
    w.schedule("a", 10);
    w.schedule("b", 5_000_000);
    expect(w.advance(9_000_000)).toEqual(["a", "b"]);
  });
});
