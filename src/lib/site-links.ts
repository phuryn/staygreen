/* Where Staygreen points people outside the app: its public repository and issue tracker, and its
   own status page. The footer, `/support` and the app's rail read these, so a move is one edit. */

/** The public repository: the code under FSL-1.1-MIT, the issue tracker and the MCP server's README. */
export const GITHUB_REPO = "https://github.com/phuryn/staygreen";

/** The issue chooser: a bug report or an idea, each with its own form (`.github/ISSUE_TEMPLATE`). */
export const NEW_ISSUE = `${GITHUB_REPO}/issues/new/choose`;

/** GitHub's private vulnerability reporting for the repository, on since the tracker opened. */
export const SECURITY_REPORT = `${GITHUB_REPO}/security/advisories/new`;

/** The README's section on connecting an agent, the nearest thing to docs until staygreen.io has a docs page. */
export const AGENT_DOCS = `${GITHUB_REPO}#connect-an-agent-mcp`;

// Staygreen's own status page, served by Staygreen (the owner, 2026-10-27, decisions.md). It runs on
// the status box and the probes it reports on, so it can't vouch for them in an outage, and `/support`
// says so; the independent witness, UptimeRobot on `/health` (spec.md § 9), isn't set up yet.
export const OWN_STATUS_PAGE = "https://status.staygreen.io/demo-status-page";
