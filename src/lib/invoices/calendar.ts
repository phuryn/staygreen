/** Date-only deadlines belong to the seller's Warsaw calendar, including the
 * whole last day across DST/UTC boundaries. */
export function warsawDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(type => parts.find(p => p.type === type)!.value).join("-");
}
export const DAY = 86_400_000;
export function correctionDeadline(issueDate: string) { return new Date(Date.parse(`${issueDate}T12:00:00Z`) + 90 * DAY).toISOString().slice(0, 10); }
export function inCorrectionWindow(until: string | null, now = new Date()) { return until !== null && warsawDate(now) <= until; }
