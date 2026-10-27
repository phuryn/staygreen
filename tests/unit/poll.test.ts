import { describe, expect, it } from "vitest";
import { FAST_FOR_MS, FAST_POLL_MS, POLL_CHECK_MS, POLL_MS, awaitingNumbers, pollDue, type PollInput } from "@/lib/poll";
import { monitor } from "./fixtures";

/* When the dashboard refreshes by itself (`src/lib/poll.ts`): once a minute, only on a screen
   that asks for it, only in a tab in view, and never while a form holds unsaved input or a write
   is out; every five seconds while it shows a monitor about to get its first numbers. */

const NOW = 1_000_000_000;
const due = (over: Partial<PollInput> = {}) => pollDue({ polling: true, visible: true, held: false, now: NOW, lastAt: NOW - POLL_MS, ...over });

describe("pollDue", () => {
  it("is a minute", () => {
    expect(POLL_MS).toBe(60_000);
  });

  it("polls once the newest snapshot is a full interval old", () => {
    expect(due()).toBe(true);
    expect(due({ lastAt: NOW - POLL_MS + 1 })).toBe(false);
  });

  it("waits in a background tab", () => {
    expect(due({ visible: false })).toBe(false);
  });

  it("waits while a form holds unsaved input or a write is out", () => {
    expect(due({ held: true })).toBe(false);
  });

  it("never polls a screen that didn't ask", () => {
    expect(due({ polling: false })).toBe(false);
  });

  it("catches up at once when a tab comes back after a long time away", () => {
    expect(due({ lastAt: NOW - 30 * POLL_MS })).toBe(true);
  });
});

describe("the fast poll while a new monitor waits for its first numbers", () => {
  it("is five seconds, asked about every second, and still only on a screen that polls", () => {
    expect(FAST_POLL_MS).toBe(5_000);
    expect(POLL_CHECK_MS).toBeLessThan(FAST_POLL_MS);
    expect(due({ eager: true, lastAt: NOW - FAST_POLL_MS })).toBe(true);
    expect(due({ eager: true, lastAt: NOW - FAST_POLL_MS + 1 })).toBe(false);
    expect(due({ eager: false, lastAt: NOW - FAST_POLL_MS })).toBe(false);
    expect(due({ eager: true, polling: false, lastAt: NOW - FAST_POLL_MS })).toBe(false);
  });

  it("keeps the holds: unsaved input, a write out, a tab out of view", () => {
    for (const hold of [{ held: true }, { visible: false }]) expect(due({ eager: true, lastAt: NOW - POLL_MS, ...hold })).toBe(false);
  });
});

describe("awaitingNumbers", () => {
  const T = 1_800_000_000_000;
  const fresh = (over: Parameters<typeof monitor>[0]) => monitor({ createdAt: T - 10_000, checked: false, state: "unchecked", ...over });

  it("is a checked monitor saved moments ago with no window yet", () => {
    for (const type of ["http", "tcp", "ssl", "dns", "supabase", "stripe"] as const) expect(awaitingNumbers(fresh({ id: "m", type }), T)).toBe(true);
  });

  it("lets go once a window has arrived", () => {
    expect(awaitingNumbers(fresh({ id: "m", reports: [{ loc: "tor1", end: T + 200_000, checks: 1, failures: 0, p50: 120 }] }), T)).toBe(false);
  });

  it("lets go two minutes after the save, numbers or not", () => {
    expect(awaitingNumbers(fresh({ id: "m" }), T - 10_000 + FAST_FOR_MS - 1)).toBe(true);
    expect(awaitingNumbers(fresh({ id: "m" }), T - 10_000 + FAST_FOR_MS)).toBe(false);
  });

  it("counts from the last edit, which hides the old address's windows", () => {
    const edited = fresh({ id: "m", createdAt: T - 30 * 86_400_000, updatedAt: T - 5_000 });
    expect(awaitingNumbers(edited, T)).toBe(true);
    expect(awaitingNumbers({ ...edited, updatedAt: undefined }, T)).toBe(false);
  });

  it("never waits on a heartbeat, which waits for its job, or a paused monitor", () => {
    expect(awaitingNumbers(fresh({ id: "m", type: "heartbeat" }), T)).toBe(false);
    expect(awaitingNumbers(fresh({ id: "m", paused: { until: null, reason: "" } }), T)).toBe(false);
  });
});
