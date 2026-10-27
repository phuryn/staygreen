import { describe, expect, it } from "vitest";
import { ago, consts, dayTime, dur, ms, pct, plural, until } from "@/lib/format";

/* Formatting (`src/lib/format.ts`). The rule that matters most: an uptime figure
   is never rounded up, so a bad minute never reads as a perfect score. */

const { MIN, HOUR, DAY } = consts;

describe("pct", () => {
  it("says 100% only for 100", () => {
    expect(pct(100)).toBe("100%");
    expect(pct(100.0000001)).toBe("100%");
  });

  it.each([99.999, 99.995, 99.9999999, 100 - 1e-9, 99.99999999999])("never rounds %s up to a perfect score", (v) => {
    expect(pct(v)).not.toBe(pct(100));
    expect(pct(v)).toBe("99.99%");
  });

  it("truncates rather than rounds at every precision", () => {
    expect(pct(99.987)).toBe("99.98%");
    expect(pct(99.9999, 3)).toBe("99.999%");
    expect(pct(99.96, 1)).toBe("99.9%");
    expect(pct(99.5, 0)).toBe("99%");
  });

  it.each([
    [0, "0.00%"],
    [50, "50.00%"],
    [99.99, "99.99%"],
    [99.9, "99.90%"],
    [12.34, "12.34%"],
  ])("shows %s as %s", (v, s) => {
    expect(pct(v)).toBe(s);
  });

  // BUG (format.ts:72): `Math.floor(v * 100)` sees the binary float under a two-decimal
  // value, so 1.13 * 100 = 112.99999999999999 floors to 112 and the figure reads 0.01 low.
  it.each([
    [0.29, "0.29%"],
    [0.57, "0.57%"],
    [1.13, "1.13%"],
    [2.01, "2.01%"],
    [4.35, "4.35%"],
  ])("shows a value that is already at two decimals as itself: %s", (v, s) => {
    expect(pct(v)).toBe(s);
  });
});

describe("dur", () => {
  it.each([
    [0, "1 min"],
    [30_000, "1 min"],
    [5 * MIN, "5 min"],
    [59 * MIN, "59 min"],
    [HOUR, "1 h"],
    [90 * MIN, "1 h 30 min"],
    [DAY, "1 day"],
    [DAY + HOUR, "1 d 1 h"],
    [2 * DAY, "2 days"],
  ])("dur(%i) is %s", (v, s) => {
    expect(dur(v)).toBe(s);
  });
});

describe("ago and until", () => {
  const now = 1_800_000_000_000;

  it.each([
    [0, "just now"],
    [4_000, "just now"],
    [-60_000, "just now"],
    [30_000, "30 s ago"],
    [5 * MIN, "5 min ago"],
    [2 * HOUR, "2 h ago"],
    [DAY, "yesterday"],
    [3 * DAY, "3 days ago"],
  ])("ago(now - %i) is %s", (delta, s) => {
    expect(ago(now - delta, now)).toBe(s);
  });

  it.each([
    [-1_000, "now"],
    [0, "now"],
    [30_000, "in 30 s"],
    [5 * MIN, "in 5 min"],
    [HOUR, "in 1 h"],
    [HOUR + 15 * MIN, "in 1 h 15 min"],
  ])("until(now + %i) is %s", (delta, s) => {
    expect(until(now + delta, now)).toBe(s);
  });
});

describe("dayTime", () => {
  it("names today and yesterday in the viewer's own calendar", () => {
    const noon = new Date(2026, 9, 21, 12, 0, 0).getTime();
    expect(dayTime(noon - HOUR, noon).startsWith("Today ")).toBe(true);
    expect(dayTime(noon - DAY, noon).startsWith("Yesterday ")).toBe(true);
    expect(dayTime(noon - 3 * DAY, noon)).not.toMatch(/^(Today|Yesterday) /);
  });
});

describe("ms and plural", () => {
  it.each([
    [null, "—"],
    [undefined, "—"],
    [182.4, "182 ms"],
    [1500, "1.5 s"],
    [12_000, "12 s"],
  ])("ms(%s) is %s", (v, s) => {
    expect(ms(v)).toBe(s);
  });

  it("pluralises by count", () => {
    expect(plural(1, "monitor")).toBe("1 monitor");
    expect(plural(0, "monitor")).toBe("0 monitors");
    expect(plural(2, "day")).toBe("2 days");
    expect(plural(2, "status", "statuses")).toBe("2 statuses");
  });
});
