import type { RunReport } from "./sender";

/* Shared budget and value-free report for the Worker's one-minute cron. Stop claiming at 20 s;
   the current bounded call may finish afterwards, and the next minute takes what remains. */

export const SCHEDULED_DEADLINE_MS = 20_000;

export function summary(r: RunReport): string {
  const parts = Object.entries({ expanded: r.expanded, sent: r.sent, reconciled: r.reconciled, failed: r.failed, skipped: r.skipped, retrying: r.retrying, inDoubt: r.inDoubt, released: r.released })
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(", ") : "nothing due";
}
