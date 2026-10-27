// The eleven implemented tools (spec.md § 8).
// The spec's table is the contract; this is its wording for the screen.

export type ToolRow = { name: string; inputs: string; returns: string; write: boolean };

export const tools: ToolRow[] = [
  { name: "scan_app", inputs: "An app URL, optional restricted service keys and cron findings", returns: "One-time expiry, status-page, Supabase and Stripe findings. Keys are never stored. MCP server health is Coming soon.", write: false },
  { name: "list_monitors", inputs: "Optionally an app, a type or a state", returns: "Each monitor's id, type, target, interval, state and last check. Secrets never.", write: false },
  { name: "get_status", inputs: "An app, or every app", returns: "Overall state, components, and the open incident with its latest published note", write: false },
  { name: "get_uptime", inputs: "A monitor or all of them, and a window: 24 hours, 7, 30 or 90 days, or a year", returns: "Uptime, downtime minutes, incident count and the daily series, capped by your plan's history", write: false },
  { name: "get_response_times", inputs: "A monitor, a window, and optionally a location", returns: "Recorded p50 and p95 series; larger buckets show the highest recorded values", write: false },
  { name: "get_incidents", inputs: "Optionally an app, a start date, and optionally a state", returns: "Incidents with timeline, locations, the failing assertion and a masked snippet", write: false },
  { name: "get_ssl_and_domain_expiry", inputs: "Optionally an app", returns: "Each host with certificate and domain expiry and days left", write: false },
  { name: "provision_app", inputs: "An app URL, and optionally a name, cron definitions and read-only service credentials", returns: "What it created, new heartbeat URLs, the status page, and anything skipped with its reason. Custom domains and MCP checks are not included yet.", write: true },
  { name: "create_monitor", inputs: "A type, a target and its settings", returns: "The monitor id and its first check result", write: true },
  { name: "pause", inputs: "A monitor or an app, and for how many minutes, up to 1,440", returns: "When it resumes, which it does by itself", write: true },
  { name: "draft_incident_update", inputs: "An incident, the text, and optionally its state", returns: "A draft and a link for you to approve it. It never publishes.", write: true },
];

export const neverExposed = [
  "Deleting monitors, status pages, incidents or history",
  "Removing or editing alert channels and teammates",
  "Billing, plan changes and API tokens",
  "Publishing an incident note",
];
