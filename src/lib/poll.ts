// When the dashboard fetches a fresh snapshot by itself (`architecture.md § Feeds and polling`).
// Pure, so the rule is tested without a browser; `workspace-store.tsx` runs it.

import type { Monitor } from "./model";

/** The probes write 5-minute windows and check every 1 to 3 minutes, so a minute shows a change
 *  within a check or two of it, for one server render per open tab per minute. */
export const POLL_MS = 60_000;

/** While a screen in view shows a monitor that has no numbers yet. The probes check a new monitor
 *  within about 40 seconds of it being saved and write that first check at once
 *  (`probe/runtime.ts`), so five seconds puts it on screen a few seconds after it lands. */
export const FAST_POLL_MS = 5_000;

/** How long after a monitor is saved it may hold the fast poll: past the worst case for its first
 *  check (a 30-second refresh, a 10-second stagger and a 15-second timeout), with room to spare.
 *  A monitor still without numbers after that isn't about to get them (no probe is running), and
 *  the minute's poll is enough. */
export const FAST_FOR_MS = 120_000;

/** How often the store asks whether a poll is due: a second, so the fast poll keeps its five
 *  seconds from the snapshot's arrival rather than rounding up to the next ask. Asking is a
 *  comparison, not a request. A tab coming back into view asks at once. */
export const POLL_CHECK_MS = 1_000;

/** How long the router keeps a dashboard screen it rendered, in seconds (`staleTimes.dynamic` in
 *  `next.config.ts`). Under the poll's minute, so a kept screen is never older than polling allows. */
export const KEPT_SCREEN_S = 30;

/** The screens never shown from that keep, each exporting `unstable_dynamicStaleTime = 0`: the ones
 *  whose form or button sends what the screen shows (an edit form, the page editor, a draft's
 *  Publish, Settings), and the monitor's page, which alone carries its ping URL and history. Shown
 *  from a copy a teammate's save has since changed, they would write the old values back. The
 *  lists keep theirs: their buttons send an id. Pinned by `tests/unit/navigation.test.ts`. */
export const FRESH_ON_EVERY_VISIT = ["monitors/[id]", "monitors/[id]/edit", "incidents/[id]", "status-pages/[id]", "settings", "apps/[id]/checks", "clone/[slug]"] as const;

export type PollInput = {
  /** A screen that wants polling is showing. */
  polling: boolean;
  /** A screen showing is waiting for a monitor's first numbers (`awaitingNumbers`). */
  eager?: boolean;
  /** The tab is in view (`document.visibilityState`). */
  visible: boolean;
  /** Something on screen holds the poll: unsaved input, or a write still in flight. */
  held: boolean;
  now: number;
  /** When the newest snapshot arrived or the last poll asked for one, by this browser's clock. */
  lastAt: number;
};

/** Whether to fetch a fresh snapshot now. */
export const pollDue = (p: PollInput) => p.polling && p.visible && !p.held && p.now - p.lastAt >= (p.eager ? FAST_POLL_MS : POLL_MS);

const CHECKED: ReadonlySet<Monitor["type"]> = new Set(["http", "tcp", "ssl", "dns", "stripe", "supabase"]);

/** A monitor the probes are about to check for the first time: a type they check (a heartbeat
 *  waits for its job instead), not paused, with no window to show, saved less than `FAST_FOR_MS`
 *  ago. Saved means created, or edited, paused or resumed (`updatedAt`): an edit to its address
 *  hides the old address's windows until a probe checks the new one (`sinceLastEdit`). */
export function awaitingNumbers(m: Pick<Monitor, "type" | "paused" | "reports" | "createdAt" | "updatedAt">, now: number): boolean {
  if (!CHECKED.has(m.type) || m.paused || m.reports.length > 0) return false;
  return now - (m.updatedAt ?? m.createdAt) < FAST_FOR_MS;
}
