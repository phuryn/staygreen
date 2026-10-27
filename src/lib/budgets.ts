/* Per-actor budgets (`AGENTS.md § 1.2`, `docs/architecture.md § Rate limits`): how often one
   member, and one workspace, may make Staygreen do something that costs more than a database
   row. Counted in Postgres by `spend_budget` (migration 011), because the dashboard runs as
   serverless functions and a counter in memory counts only the instance it lives in.

   Pure, so the numbers and the sentences have a unit test, and the screen can quote them. */

/** Testing a monitor before saving it fetches a public address now and shows what came back
 *  (`src/lib/monitor-test.ts`). Setting up a monitor takes a few tests and a save, which tests
 *  too; the member's count is several monitors' worth in ten minutes, and the workspace's caps
 *  what all its members together can make Staygreen fetch in an hour. */
export const TEST_BUDGET = {
  member: { limit: 20, windowSec: 600 },
  workspace: { limit: 100, windowSec: 3600 },
} as const;

export type BudgetScope = keyof typeof TEST_BUDGET;

const span = (sec: number) => (sec % 3600 === 0 ? (sec === 3600 ? "an hour" : `${sec / 3600} hours`) : `${Math.round(sec / 60)} minutes`);

/** The sentence a refused test shows; the screen adds when it can run again, in the
 *  member's own clock (`retryAfterSec`). */
export function testBudgetSpent(scope: BudgetScope): string {
  const b = TEST_BUDGET[scope];
  return scope === "member"
    ? `You've run ${b.limit} tests in ${span(b.windowSec)}, which is as many as one person can.`
    : `This workspace has run ${b.limit} tests in ${span(b.windowSec)}, which is as many as a workspace can.`;
}

/** A test alert sends a real message from the Alerts screen (`docs/emails.md`): a member may send
 *  a few while setting channels up, and a workspace a few dozen an hour. */
export const ALERT_TEST_BUDGET = {
  member: { limit: 10, windowSec: 600 },
  workspace: { limit: 30, windowSec: 3600 },
} as const;

/** Channel setup shares this existing budget: confirmation mail, Slack OAuth starts, and
 *  Discord/webhook creation (including DNS). The stored action remains alert_confirm so
 *  old dashboards share the same counters during rollout. */
export const ALERT_CONFIRM_BUDGET = {
  member: { limit: 5, windowSec: 3600 },
  workspace: { limit: 20, windowSec: 3600 },
} as const;

export function alertBudgetSpent(action: "alert_test" | "alert_confirm", scope: BudgetScope): string {
  const b = (action === "alert_test" ? ALERT_TEST_BUDGET : ALERT_CONFIRM_BUDGET)[scope];
  const what = action === "alert_test" ? "sent" : "used";
  const noun = action === "alert_test" ? "test alerts" : "channel setup attempts";
  return scope === "member"
    ? `You've ${what} ${b.limit} ${noun} in ${span(b.windowSec)}, which is as many as one person can.`
    : `This workspace has ${what} ${b.limit} ${noun} in ${span(b.windowSec)}, which is as many as a workspace can.`;
}
