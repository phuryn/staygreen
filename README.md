# Staygreen

Uptime and incident monitoring for apps built with coding agents: checks from more than one location, incidents with the evidence attached, and a public status page for each app. Free plan at [staygreen.io](https://staygreen.io).

This repository is Staygreen's public issue tracker, the home of its MCP server's listing, and the source of the `staygreen` command-line package and local MCP server ([CLI.md](CLI.md)), under the FSL-1.1-MIT license. The rest of Staygreen's code opens here in November 2026.

## Connect an agent (MCP)

Staygreen's MCP server is at `https://staygreen.io/mcp` (streamable HTTP). Every call requires sign-in; there is no anonymous tool.

### Sign in: no token to handle

Add `https://staygreen.io/mcp` to an MCP client that supports signing in (OAuth), then sign in with your Staygreen account and choose the workspace. If you don't have an account yet, signing up there creates a Free workspace; you don't need to open the dashboard first. The connection can read and change that workspace's monitors, and you must be an administrator of it.

[![Add Staygreen to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=staygreen&config=eyJ1cmwiOiJodHRwczovL3N0YXlncmVlbi5pby9tY3AifQ==) [![Install Staygreen in VS Code](https://img.shields.io/badge/VS_Code-Install_Staygreen-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=staygreen&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fstaygreen.io%2Fmcp%22%7D)

Claude Code:

```sh
claude mcp add --transport http staygreen https://staygreen.io/mcp
```

Then run `/mcp`, choose staygreen and Authenticate. In Claude, add it as a custom connector with the same URL.

### With an API token (CI and scripts)

An administrator creates a token in the dashboard under Agents and API: read-only or read-and-write, shown once. Send it as `Authorization: Bearer <token>`. The same token works on the MCP server and on the REST API (`https://staygreen.io/api/v1/<tool>`).

```sh
claude mcp add --transport http staygreen https://staygreen.io/mcp \
  --header "Authorization: Bearer $STAYGREEN_API_TOKEN"
```

### Local server (npm)

The [`staygreen`](https://www.npmjs.com/package/staygreen) package runs the same tools as a local stdio server and calls the REST API with a workspace API token. Node 22 or later.

```sh
claude mcp add staygreen -e STAYGREEN_API_TOKEN=… -- npx -y staygreen mcp
```

Without a token only `scan_app` works. Configuration for Claude Desktop, Cursor and VS Code, and the package's `scan` and `provision` commands, are in [CLI.md](CLI.md).

### Tools

| Tool | What it does |
|---|---|
| `get_status` | Current status of one app or every app: monitors, page components and open incidents |
| `list_monitors` | Monitors in your workspace, filtered by app, type or state, with each one's last check |
| `get_uptime` | Measured uptime, downtime minutes, incident counts and daily history. Unmeasured time is no data, not 100% |
| `get_response_times` | Response-time series for a monitor, by city and country |
| `get_incidents` | Incident evidence and timelines: failing assertions, locations and masked snippets |
| `get_ssl_and_domain_expiry` | Certificate and domain expiry dates for monitored hosts |
| `scan_app` | A one-time scan of a public app URL. Optional keys are used once and never stored. Creates nothing |
| `provision_app` | Sets up an app's website check, SSL and domain check, status page and cron heartbeats in one call |
| `create_monitor` | Adds one monitor to an app, with the dashboard's own checks and plan limits |
| `pause` | Pauses one monitor or one app's monitors for up to 24 hours, then resumes them |
| `draft_incident_update` | Saves an incident note as a draft. It appears publicly only once you publish it in the dashboard |

Writes take a `request_id` UUID: repeat it with the same inputs to retry safely. Deleting, alert channels, teammates, billing and publishing are not available to agents. Calls share your workspace's budget: 30 a minute on Free, 120 on Builder.

## Report a bug or suggest a feature

Open an [issue](https://github.com/phuryn/staygreen/issues/new/choose). Say what you did, what you expected, and what happened instead; the monitor type and the screen help.

Issues are public. **Never paste a secret, service-role or restricted key, a token, a webhook or heartbeat URL, a signing secret or a header value, whether Staygreen issued it or another service did.** If you posted one, treat it as leaked: make sure the old value stops working wherever it is accepted, because issuing a new one doesn't always retire it; see [staygreen.io/support](https://staygreen.io/support) if you're not sure how.

For a security problem, don't open an issue: use [private vulnerability reporting](https://github.com/phuryn/staygreen/security/advisories/new) instead. For anything else private, see [staygreen.io/support](https://staygreen.io/support).

Pull requests aren't accepted until the code opens.
