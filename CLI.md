# Staygreen MCP server and CLI

**The primary MCP connection is the hosted OAuth endpoint:
`https://staygreen.io/mcp`.** Add that URL to an OAuth-capable MCP client and sign
in to select your workspace. The local server below is for clients that prefer
a workspace token, and directories that need public server source.

This FSL-1.1-MIT package contains the MCP client/server bridge and CLI, not the
Staygreen app. Copyright 2026 Pawel Huryn. The generated tool contract is public;
workspace data and authorization remain behind the Staygreen REST API.

## Local MCP server

Requires Node 22 or later:

```sh
npx -y staygreen mcp
```

The package is prepared for publication; until the owner publishes it, build this
source and use `node /absolute/path/to/dist/cli.js mcp` in place of `npx`.

Create a workspace API token at [Agents and API](https://staygreen.io/app/agents)
and provide it as `STAYGREEN_API_TOKEN` in the server process's environment.
Tokens are never command arguments to `staygreen`, and OAuth tokens do not work
with this local server. **Read-only** tokens permit reads and scans;
**read-and-write** tokens also permit provisioning, monitor creation, pauses up to
24 hours and incident drafts. Tokens grant access only to their owning workspace.

Without a token, `initialize`, `ping` and `tools/list` work, and `scan_app` uses
the same public `/api/scan` service as the website and `staygreen scan`.
Every other tool call returns an error explaining where to create a token.
With a token, every call uses `/api/v1/<tool>` on the selected origin.

The 11 tools are `scan_app`, `list_monitors`, `get_status`, `get_uptime`,
`get_response_times`, `get_incidents`, `get_ssl_and_domain_expiry`, `provision_app`,
`create_monitor`, `pause` and `draft_incident_update`. Tool titles, descriptions,
input/output schemas and annotations match the hosted server. Reads never return
heartbeat URLs. The exception is `provision_app`'s creating request and its retries,
which receive the new heartbeat URLs needed to install the jobs. Treat those
results as secrets. `create_monitor` does not return a heartbeat URL.

### Claude Desktop

Add this entry to `claude_desktop_config.json` through Settings → Developer → Edit
Config, then restart Claude Desktop. Replace the placeholder in your **personal**
configuration; do not commit it. Omit `env` for discovery and public scans only.

```json
{
  "mcpServers": {
    "staygreen": {
      "command": "npx",
      "args": ["-y", "staygreen", "mcp"],
      "env": { "STAYGREEN_API_TOKEN": "<workspace API token>" }
    }
  }
}
```

### Claude Code

Use the local server registration command with your token in place of the ellipsis:

```sh
claude mcp add staygreen -e STAYGREEN_API_TOKEN=… -- npx -y staygreen mcp
```

This stores the token in Claude Code's local configuration and may put it in shell
history. If your shell already supplies `STAYGREEN_API_TOKEN`, omit `-e` and let the
child process inherit it. See [Claude Code's MCP documentation](https://code.claude.com/docs/en/mcp).

### Cursor

Put the same `mcpServers` JSON shown above in your personal `~/.cursor/mcp.json`.
Project `.cursor/mcp.json` also works, but must not contain a committed token.
See [Cursor's MCP configuration](https://cursor.com/docs/mcp).

### VS Code

In the VS Code MCP configuration (`MCP: Open User Configuration`, or an uncommitted
`.vscode/mcp.json`), use a password input instead of a literal credential:

```json
{
  "inputs": [
    { "id": "staygreen-token", "type": "promptString", "description": "Staygreen workspace API token", "password": true }
  ],
  "servers": {
    "staygreen": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "staygreen", "mcp"],
      "env": { "STAYGREEN_API_TOKEN": "${input:staygreen-token}" }
    }
  }
}
```

This is the VS Code configuration format; prompted inputs are not portable to
every Copilot harness. See [VS Code's MCP configuration reference](https://code.visualstudio.com/docs/agent-customization/mcp-servers).
If a Windows client cannot launch `npx`, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "staygreen", "mcp"]`, or use `node` and the built
CLI's absolute path. These configurations are documented examples: Claude Desktop,
Claude Code, Cursor and VS Code are still **untested for Staygreen** in a live client.

### Transport and limits

stdio carries newline-delimited JSON-RPC 2.0 only; diagnostics use stderr. Protocol
versions are `2025-11-25` and `2025-06-18`, as on the hosted server. There are no
resources, prompts, batch requests or local repository-reading MCP tools.

`--api-origin <origin>` selects HTTPS or localhost HTTP. Redirects are refused,
and a token goes only to that origin. Each call has one 50-second deadline covering
the response body and retry, a 256 KiB response cap and at most one retry on
429/503 when `Retry-After` is at most five seconds. Write retries keep the same
arguments and request UUID. Refusals preserve only bounded `code`, `message`,
`details` and `retry_after` fields; token echoes are redacted from all output.

Inputs are checked against the advertised JSON Schema before network access.
Server-side refinements, authorization, scope, quotas and target checks remain
the API's responsibility. JSON Schema cannot express every hosted Zod refinement.
Tool descriptions are kept identical, including `scan_app`'s hosted read-access
wording; local instructions explain its token-free public fallback.

Lines are capped at 64 KiB, counted as bytes. Oversized lines get `-32600 Invalid
Request` and are discarded through the next newline (the hosted equivalent is
HTTP 413 before JSON-RPC parsing). At most 32 calls run concurrently.
`notifications/cancelled` aborts a pending fetch or retry and suppresses its reply;
it cannot undo a write already accepted by the API. Closing stdin drains submitted
calls within their deadlines. Cancellation follows the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).

## Scan and provision

Node 22 or later. No account is needed for `npx staygreen scan https://yourapp.com`.
The scan calls Staygreen's shared scan service; it does not open arbitrary network
targets on your computer. Optional `STAYGREEN_API_TOKEN` uses the authenticated API.

`--repo .` reads only `vercel.json` and `netlify.toml`, at most 256 KiB each, locally.
Only cron names and schedules leave the machine. Netlify supports literal schedule
entries under `[functions."name"]`; unsupported schedule syntax fails visibly.
Schedules declared in function source code are not discovered. No repository code runs.
`--heartbeats private.json` compares job names with the private provisioning manifest.
Without a matching entry, a job reports `not_found`: no mapping was supplied, not proof
that its code never pings another service. A configured entry is not a delivery test.

Optional service credentials: `--supabase-url https://<ref>.supabase.co
--supabase-key-env SUPABASE_PUBLISHABLE_KEY` or `--stripe-key-env STRIPE_RESTRICTED_KEY`.
Use environment variable names, never literal keys in arguments. Scans never store keys.

For deploy pipelines, set `STAYGREEN_API_TOKEN` to a write-scoped workspace token and run:

```sh
npx staygreen provision https://yourapp.com --repo . --output .staygreen/private.json
```

Keep `.staygreen/` out of version control, logs and public CI artifacts. It contains
heartbeat credentials. The adjacent `.request-id` contains a retry id; preserve it
and the same arguments when retrying a lost response. Use a new output file or an
explicit new `--request-id` for a different operation. The command creates the HTTP
check, automatic expiry check, public status page and named cron heartbeats atomically.
It writes new heartbeat URLs only to the private output file, never stdout. A later
call for an already provisioned URL leaves that file alone. Optional service monitors
are reported as skipped when the supplied inputs are insufficient; inspect `skipped`.
The template must read that JSON, wire each cron to its returned heartbeat URL and ping
it after successful work. This package cannot alter a deployed app's cron code.

`--api-origin` explicitly selects a development deployment (HTTPS, or localhost HTTP).
Requests refuse redirects, have a 50-second deadline and a 256 KiB response limit.
No token is sent anywhere except that selected origin.

## Build and test this source

```sh
npm ci
npm run typecheck
npm run build
npm test
node dist/cli.js --help
npm pack --dry-run
```

The source builds and tests on its own. Zod is bundled; installing the published
executable adds no runtime dependencies. Third-party licensing is in
`THIRD_PARTY_NOTICES`. The small transport uses Node streams and fetch directly;
no MCP SDK is required. GitHub Actions runs build, typecheck and tests on Node 22
and 24, without credentials or live API calls. This workflow never publishes.

Maintainers regenerate `src/contract.generated.json` in the product checkout with
`npm run cli:contract`; a product unit test refuses drift from the hosted contract.
The public tree needs neither that checkout nor the generator to build or test.
`npm run cli:export -- <directory>` in the product checkout exports only this package.
An existing issue-tracker `README.md` is preserved; `CLI.md` always contains this
guide. Symbolic links/junctions in destination paths are refused.

The owner publishes to npm and pushes the exported package source to
`github.com/phuryn/staygreen`. Confirm ownership of the unscoped `staygreen` npm
name, authentication/2FA, the intended version and package contents first. Neither
the export nor the build publishes anything. Directory and registry submissions
remain separate owner tasks.
