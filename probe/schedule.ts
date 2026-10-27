/* Which probe checks a monitor, and when (`spec.md § 4`). Pure, so every probe computes the same
   answer from the same live set without asking anyone.

   Each monitor ranks the live probes by rendezvous hashing (highest score of hash(monitor, probe)
   first). The first-ranked probe is the monitor's home: it runs the state machine for it and
   writes what it produces, so a monitor's state is only ever moved from one place. The checks
   rotate through the ranking: with N live probes and an interval of I seconds, the probe ranked k
   checks at the seconds t ≡ φ + k·I (mod N·I), where φ is a hash of the monitor id. The monitor is
   checked every I seconds, from a different location each time, and φ spreads monitors across
   the period so their checks never align on the minute.

   Nothing is handed over when the live set changes: every probe recomputes its ranks, and a probe
   that stopped heartbeating drops out of everyone's ranking at the same moment. Its slots are
   missed until then (two minutes), which leaves its monitors checked at a longer interval, not
   unchecked. */

import { isLocationId, locations } from "../src/lib/plans";

export type ProbeInfo = {
  id: string;
  /** A `LocationId`; its city and continent are `locations` in src/lib/plans.ts. */
  location: string;
  /** A probe Free monitors aren't checked from (`fra1`, Builder's third location). */
  builderOnly: boolean;
};

/** The continent a probe checks from. A location the plan module doesn't know has none: main.ts
    and the `probes` table both refuse one, so it can only come from a test. */
const continentOf = (p: ProbeInfo) => (isLocationId(p.location) ? locations[p.location].continent : undefined);

/** FNV-1a over UTF-8, then MurmurHash3's finalizer, so nearby ids land far apart. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(s, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function eligible(probes: readonly ProbeInfo[], builder: boolean): ProbeInfo[] {
  return builder ? [...probes] : probes.filter((p) => !p.builderOnly);
}

/** The monitor's ranking of these probes: home first. */
export function ranked(monitorId: string, probes: readonly ProbeInfo[]): ProbeInfo[] {
  return probes
    .map((p) => ({ p, score: hash32(`${monitorId}\u0000${p.id}`) }))
    .sort((a, b) => b.score - a.score || (a.p.id < b.p.id ? -1 : 1))
    .map((x) => x.p);
}

/** The first second after `after` at which the probe ranked `k` of `n` checks this monitor. */
export function nextDue(after: number, monitorId: string, intervalSec: number, k: number, n: number): number {
  const period = intervalSec * n;
  const target = (hash32(monitorId) % period + k * intervalSec) % period;
  const delta = (target - (after % period) + period) % period;
  return after + (delta === 0 ? period : delta);
}

/** Who may re-check a failure seen by `selfId`, in the order to ask them: the probes at other
    locations, following the ranking from `selfId`, those on the other continent first when the
    monitor's plan allows it (`spec.md § 4`: Free uses its other location, and Builder prefers one
    on the other continent). The rest stay as fallbacks, so a Builder failure is still confirmed
    when the other continent doesn't answer. Empty when no other location is live, and only then
    does the probe re-check on its own. */
export function confirmersFor(order: readonly ProbeInfo[], selfId: string, preferOtherContinent: boolean): ProbeInfo[] {
  const i = order.findIndex((p) => p.id === selfId);
  if (i < 0) return [];
  const self = order[i];
  const others = [...order.slice(i + 1), ...order.slice(0, i)].filter((p) => p.location !== self.location);
  if (!preferOtherContinent) return others;
  const near = (p: ProbeInfo) => continentOf(p) === continentOf(self);
  return [...others.filter((p) => !near(p)), ...others.filter(near)];
}

/** Monitor ids by the second they're due. One entry per monitor: scheduling again moves it. */
export class TimerWheel {
  private slots = new Map<number, Set<string>>();
  private at = new Map<string, number>();

  /** `cursor` is the last second already handled; nothing is ever due at or before it. */
  constructor(private cursor: number) {}

  get size(): number {
    return this.at.size;
  }

  /** The last second handled. */
  get last(): number {
    return this.cursor;
  }

  when(id: string): number | undefined {
    return this.at.get(id);
  }

  schedule(id: string, sec: number): void {
    this.cancel(id);
    const s = Math.max(Math.floor(sec), this.cursor + 1);
    let set = this.slots.get(s);
    if (!set) this.slots.set(s, (set = new Set()));
    set.add(id);
    this.at.set(id, s);
  }

  cancel(id: string): void {
    const s = this.at.get(id);
    if (s === undefined) return;
    const set = this.slots.get(s);
    set?.delete(id);
    if (set?.size === 0) this.slots.delete(s);
    this.at.delete(id);
  }

  /** Every id due up to and including `now`, earliest first, taken off the wheel. */
  advance(now: number): string[] {
    const due: string[] = [];
    const take = (s: number) => {
      const set = this.slots.get(s);
      if (!set) return;
      for (const id of set) {
        due.push(id);
        this.at.delete(id);
      }
      this.slots.delete(s);
    };
    if (now - this.cursor <= this.slots.size) for (let s = this.cursor + 1; s <= now; s++) take(s);
    else for (const s of [...this.slots.keys()].filter((s) => s <= now).sort((a, b) => a - b)) take(s);
    this.cursor = Math.max(this.cursor, now);
    return due;
  }
}
