import { z } from "zod";
import { scanInput, scanOutput } from "./scan-contract";
import type { Permission, WorkspaceRef } from "./authz";
import type { Entitlements } from "./plans";

export class AgentError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number, public details?: unknown) { super(message); }
}
export type AgentPrincipal = {
  workspace: WorkspaceRef; actor: string; client: string; scope: "read" | "write";
  auth: "api_token" | "oauth"; entitlements: Entitlements;
};
export const AGENT_PERMISSIONS: Record<AgentPrincipal["scope"], readonly Permission[]> = {
  read: ["monitors:read"], write: ["monitors:read", "monitors:write", "incidents:draft"],
};
export function requireAgentPermission(p: AgentPrincipal, permission: Permission) {
  if (!AGENT_PERMISSIONS[p.scope].includes(permission)) throw new AgentError(403, "insufficient_scope", "This credential does not allow that action. A write credential is required.");
}
export const tokenInput = z.object({ request_id: z.uuid(), name: z.string().trim().min(1).max(60), scope: z.enum(["read", "write"]) }).strict();
export const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{24}$`));
const app = id("app").describe("App id from list_monitors, get_status or provision_app.");
const monitor = id("mon").describe("Monitor id from list_monitors or create_monitor.");
const incident = id("inc").describe("Incident id from get_incidents or get_status.");
const requestId = z.uuid().describe("A new UUID for this write. Retry with the same UUID and identical inputs after a lost reply; never reuse it for another operation.");
const cursor = z.string().max(80).optional().describe("Call again with cursor set to the returned next_cursor until next_cursor is null.");
const limit = z.number().int().min(1).max(100).default(50).describe("Maximum records in this page, from 1 to 100; defaults to 50.");
const page = { cursor, limit };
const window = z.enum(["24h", "7d", "30d", "90d", "1y"]).default("24h").describe("History window ending now, capped at 30 days without history_1y. The result reports the effective window.");
const type = z.enum(["http", "ssl", "dns", "tcp", "heartbeat", "stripe", "supabase"]).describe("Monitor type. MCP server monitors are not available yet.");
const state = z.enum(["up", "degraded", "down", "paused", "unchecked"]);
const assertion = z.object({
  path: z.string().max(200).describe("JSON path such as $.db.ok, or $keyword for a text assertion."),
  op: z.enum(["==", "!=", "<", ">", "<=", ">=", "contains", "exists"]).describe("Comparison operator."),
  value: z.string().max(500).describe("Expected value as text; empty for exists."),
}).strict();
// Type-specific validation still goes through parseMonitorDraft, exactly as dashboard saves do.
export const configInput = z.object({
  method: z.enum(["GET", "HEAD", "POST"]).optional().describe("HTTP method; defaults to GET."),
  expect: z.string().max(3).optional().describe("Expected HTTP status: 2xx, 3xx, or a specific code; defaults to 2xx."),
  keyword: z.string().max(200).optional().describe("Text the HTTP response must contain."),
  slowMs: z.number().int().optional().describe("Response-time warning threshold in milliseconds."),
  assertions: z.array(assertion).max(10).optional().describe("JSON assertions, within your plan's allowance."),
  headers: z.array(z.object({ name: z.string().max(64).describe("Request header name."), value: z.string().max(4096).describe("Secret header value, stored encrypted and never returned.") }).strict()).max(10).optional().describe("HTTP request headers. Credentials belong here, never in a URL."),
  port: z.number().int().optional().describe("TCP port, 1–65535."),
  tls: z.boolean().optional().describe("Whether the TCP connection uses TLS; defaults to false."),
  record: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "CAA", "NS"]).optional().describe("DNS record type."),
  expected: z.string().max(500).optional().describe("Expected DNS record value. For NS, the complete set of nameservers, separated by commas or whitespace."),
  schedule: z.string().max(100).optional().describe("Heartbeat cron schedule with five fields, such as 0 6 * * *."),
  tz: z.string().max(80).optional().describe("Heartbeat IANA time zone; defaults to UTC."),
  graceMin: z.number().int().optional().describe("Heartbeat grace period in minutes; defaults to 5."),
  maxRunMin: z.number().int().optional().describe("Longest heartbeat run in minutes; defaults to 60."),
  key: z.string().max(2000).optional().describe("Supabase publishable/anon key or Stripe restricted key. Never a service-role or unrestricted secret key."),
  databaseRead: z.string().max(67).optional().describe("Optional Supabase table, view, or rpc/function_name to verify a database read."),
  endpoints: z.array(z.string().max(103)).max(20).optional().describe("Stripe webhook endpoint ids (we_...) to watch; required for Stripe."),
  critical: z.array(z.string().max(150)).max(20).optional().describe("Critical Stripe event types; a terminal .* wildcard is allowed."),
  failureThreshold: z.number().int().optional().describe("Stripe failed-delivery count before an incident."),
  windowMin: z.number().int().optional().describe("Stripe delivery-failure lookback in minutes."),
  pendingMin: z.number().int().optional().describe("Stripe pending-delivery age threshold in minutes."),
}).strict().describe("Settings for the chosen type only. Unknown keys and settings for other types are refused.");
const cronInput = z.object({ name: z.string().min(1).max(80).describe("Job name."), schedule: z.string().max(100).describe("Five-field cron schedule copied from the repository."), tz: z.string().max(80).default("UTC").describe("IANA time zone; UTC by default.") }).strict();
export const inputs = {
  scan_app: scanInput,
  list_monitors: z.object({ app: app.optional(), type: type.optional(), status: state.optional().describe("Filter by current state; unchecked means no established state yet."), ...page }).strict(),
  get_status: z.object({ app: z.union([app, z.literal("*")]).default("*").describe("App id from list_monitors or provision_app, or * for all apps.") }).strict(),
  get_uptime: z.object({ monitor: z.union([monitor, z.literal("*")]).default("*").describe("Monitor id from list_monitors, or * for all monitors."), window, ...page }).strict(),
  get_response_times: z.object({ monitor, window, location: z.enum(["Toronto, Canada", "San Francisco, US", "Frankfurt, Germany"]).optional().describe("Optional check location, using the city and country returned by get_incidents."), ...page }).strict(),
  get_incidents: z.object({ app: app.optional(), since: z.iso.datetime({ offset: true }).optional().describe("Only incidents opened at or after this ISO 8601 timestamp; defaults to the plan's history window."), state: z.enum(["open", "resolved"]).optional().describe("Filter to open or resolved incidents."), ...page }).strict(),
  get_ssl_and_domain_expiry: z.object({ app: app.optional(), ...page }).strict(),
  provision_app: z.object({ request_id: requestId, url: z.url().max(2048).describe("Public HTTP(S) app address with a hostname of at most 80 characters. Repeated provisioning of its normalized URL returns the existing setup."), name: z.string().trim().min(1).max(60).optional().describe("App name, 1 to 60 characters and unique in the workspace ignoring case. Defaults to the hostname, shortened and suffixed as needed to be unique."),
    crons_from: z.array(cronInput).max(50).optional().describe("Cron definitions read by your agent from vercel.json or netlify.toml. Send definitions, never a local file path: a remote server cannot read your checkout."),
    supabase_url: z.string().max(100).optional().describe("Supabase project URL. Supply supabase_key too to create its health monitor."),
    supabase_key: z.string().max(2000).optional().describe("That project's publishable or legacy anon key, stored encrypted."),
    stripe_key: z.string().max(220).optional().describe("Restricted Stripe key; also supply stripe_endpoints. Never returned."),
    stripe_endpoints: z.array(z.string().max(103)).max(20).optional().describe("Stripe webhook endpoint ids to monitor with stripe_key."),
    mcp_url: z.string().max(2048).optional().describe("MCP server address; currently reported as skipped because that monitor type is Coming soon."),
    status_domain: z.string().max(253).optional().describe("Desired status-page hostname. Domain setup is reported as skipped until the separate status-edge stage is available."),
  }).strict(),
  create_monitor: z.object({ request_id: requestId, app, type, name: z.string().trim().max(80).optional().describe("Monitor name. Without one, Staygreen picks a default (a heartbeat's is \"Scheduled job\"), which this tool does not return; list_monitors shows it."), target: z.string().max(2048).describe("HTTP or Supabase URL, SSL hostname, TCP hostname or public IP, or DNS record name. HTTP(S) URL hostnames may be at most 80 characters. Stripe uses https://api.stripe.com; a heartbeat ignores it."), config: configInput.default({}) }).strict(),
  pause: z.object({ request_id: requestId, monitor: monitor.optional(), app: app.optional(), minutes: z.number().int().min(1).max(1440).describe("Pause length from 1 to 1440 minutes. Monitoring resumes automatically.") }).strict().refine(x => !!x.app !== !!x.monitor, "Choose exactly one app or monitor."),
  draft_incident_update: z.object({ request_id: requestId, incident, text: z.string().trim().min(1).max(2000).describe("Plain-text draft for the builder to review. This tool never publishes."), state: z.enum(["investigating", "identified", "monitoring", "resolved"]).default("investigating").describe("State proposed in the draft; does not change the incident or publish the note.") }).strict(),
};
export type ToolName = keyof typeof inputs;
export const toolNames = Object.keys(inputs) as ToolName[];
export const isTool = (s: string): s is ToolName => Object.hasOwn(inputs, s);
export const writeTools: readonly ToolName[] = ["provision_app", "create_monitor", "pause", "draft_incident_update"];
const timestamp = z.string();
const nullableNumber = z.number().nullable();
const note = z.object({ id: z.string(), state: z.string(), text: z.string(), published_at: timestamp });
const monitorResult = z.object({ id: z.string(), app: z.string(), name: z.string(), type: z.string(), target: z.string(), interval_sec: z.number(), state, last_check: timestamp.nullable(), last_check_precision: z.enum(["exact", "5m_window_start", "none"]) });
const pageResult = { next_cursor: z.string().nullable() };
export const outputs = {
  scan_app: scanOutput,
  list_monitors: z.object({ monitors: z.array(monitorResult), ...pageResult }),
  get_status: z.object({ apps: z.array(z.object({ id: z.string(), name: z.string(), state, components: z.array(z.object({ id: z.string(), name: z.string(), state, in_app: z.boolean(), monitors: z.array(z.string()) })), monitors: z.array(monitorResult), incidents: z.array(z.object({ id: z.string(), title: z.string(), monitor: z.string(), opened_at: timestamp, latest_note: note.nullable() })) })) }),
  get_uptime: z.object({ window: z.string(), monitors: z.array(z.object({ id: z.string(), uptime_pct: nullableNumber, downtime_minutes: z.number(), covered_minutes: z.number(), incident_count: z.number(), daily: z.array(z.object({ day: z.string(), uptime_pct: nullableNumber, downtime_minutes: z.number(), covered_minutes: z.number() })) })), ...pageResult }),
  get_response_times: z.object({ monitor: z.string(), window: z.string(), resolution: z.enum(["5m", "1h", "1d"]), aggregation: z.literal("maximum of stored window percentiles"), series: z.array(z.object({ at: timestamp, location: z.string(), p50_ms: nullableNumber, p95_ms: nullableNumber })), ...pageResult }),
  get_incidents: z.object({ incidents: z.array(z.object({ id: z.string(), app: z.string(), monitor: z.string(), title: z.string(), opened_at: timestamp, resolved_at: timestamp.nullable(), timeline: z.array(z.object({ at: timestamp, text: z.string() })), locations: z.array(z.string()), assertion: z.string().nullable(), snippet: z.string().nullable(), latest_note: note.nullable() })), ...pageResult }),
  get_ssl_and_domain_expiry: z.object({ hosts: z.array(z.object({ monitor: z.string(), host: z.string(), certificate_expires_at: timestamp.nullable(), certificate_days_left: nullableNumber, domain_expires_at: timestamp.nullable(), domain_days_left: nullableNumber })), ...pageResult }),
  provision_app: z.object({ app: z.string(), created: z.boolean(), monitors: z.array(z.object({ id: z.string(), type: z.string(), name: z.string() })), heartbeats: z.array(z.object({ monitor: z.string(), name: z.string(), url: z.string() })), status_page_url: z.string(), cname: z.object({ name: z.string(), target: z.string() }).nullable(), skipped: z.array(z.object({ item: z.string(), reason: z.string() })) }),
  create_monitor: z.object({ monitor: z.string(), first_check: z.object({ status: z.enum(["passed", "failed", "awaiting_ping"]), checked_at: timestamp.nullable(), message: z.string().nullable() }) }),
  pause: z.object({ monitors: z.array(z.string()), paused_until: timestamp }),
  draft_incident_update: z.object({ draft: z.string(), approval_url: z.string(), published: z.literal(false) }),
};
export const descriptions: Record<ToolName, string> = {
  scan_app: "Run a one-time silent-failure scan of a public app URL. Reports certificate/domain expiry, a discoverable status page, detected sign-in dependencies with DNS/TLS/frontend evidence and suggested HTTP/CNAME/NS monitors, optional Supabase health and Stripe delivery failures over 30 days. Optional keys are used once, never stored or returned. Repository cron findings may be supplied by the client. MCP server health is Coming soon. Requires read access; limited per credential and globally. No monitor is created.",
  list_monitors: "List monitors in your workspace with their app ids, current state and last check, ordered by id. The app, type and status filters combine, each narrowing the same list; with none you get every monitor, automatic SSL checks included. last_check_precision says whether last_check is an exact outcome, the start of its latest five-minute check window, or no data. Never returns credentials or heartbeat URLs. Use get_status instead for each app's overall state and open incidents, get_uptime for history. Call again with cursor set to next_cursor until null.",
  get_status: "Read the current status of one app or every app: its overall state, monitors (private ones included), status page components and open incidents with their latest published note. Omit app or pass * for the whole workspace; an app id outside your workspace returns not_found. Start here: its app, monitor and incident ids feed the other tools. Use get_uptime or get_incidents for history. No draft notes are returned.",
  get_uptime: "Read measured uptime, downtime minutes, incident counts and daily history. With monitor omitted or *, every monitor is returned a page at a time (follow next_cursor); a monitor id returns that monitor alone, so pass no cursor with it. window is capped at 30d unless your plan includes a year of history, and the result's window says which one applied. Unmeasured time is no data, not 100% uptime. Use get_response_times instead for latency, and get_incidents for what failed and why.",
  get_response_times: "Read response-time series for a monitor, optionally by city and country. Uses 5-minute windows for 24h, hourly up to 30d, daily beyond. Larger buckets report maxima of the recorded percentiles, not an exact percentile of raw requests. Follow next_cursor for all points.",
  get_incidents: "Read incident evidence and timelines for diagnosis, optionally filtered by app, start date and state. Returns incident ids for draft_incident_update, cities and countries, failing assertions and masked snippets. Only the latest published note is included. Follow next_cursor for older pages.",
  get_ssl_and_domain_expiry: "Read certificate and domain expiry dates, with days remaining, for the hosts your SSL monitors check. Omit app for every SSL monitor in the workspace, or pass an app id for that app's hosts only. A null date means Staygreen has no date to show for that host; it never guesses one. Use this for renewal deadlines; use get_status instead for whether a site is up now. Follow next_cursor to read every host.",
  provision_app: "Set up a new app in one transaction: its website check, an automatic SSL/domain check when url is https on port 443 with a hostname that has no SSL monitor yet, a status page, and one heartbeat per crons_from entry. Optional checks come in pairs, supabase_url with supabase_key and stripe_key with stripe_endpoints: half a pair is reported in skipped, and a full pair that fails verification refuses the whole call. mcp_url and status_domain are reported in skipped when supplied. A new app's explicit name must be free; without one, the hostname is made unique. Every option is validated and checked first; then, if url matches an existing app, that app comes back with its monitors as they were (add checks with create_monitor), plus a status page if it had none. A plan_limit error creates nothing and lists what was not created. Heartbeat URLs are returned only to this request and its retries with the same request_id. Needs write access.",
  create_monitor: "Create one monitor in an existing app; for a new app use provision_app instead. type decides what target is and which config keys apply: http takes a URL with method, expect, keyword, slowMs, assertions and headers; tcp a hostname or public IP with port, tls and slowMs; ssl a hostname and no config; dns a record name with record and expected; heartbeat ignores target and takes schedule, tz, graceMin, maxRunMin and assertions, so give it a name; supabase a project URL with key and databaseRead; stripe https://api.stripe.com with key, endpoints, critical, failureThreshold, windowMin and pendingMin. A key belonging to another type is refused. Validation, public-address checks and plan quotas match the dashboard, and Stripe and Supabase checks must verify before saving. Returns a first test result but never a heartbeat's URL, which the dashboard shows. Supply request_id for safe retries. Needs write access.",
  pause: "Temporarily pause exactly one monitor or every monitor of one app for at most 1440 minutes, then resume automatically. Get ids from list_monitors or get_status. A repeated request_id returns the original pause deadline without extending it. Needs write access.",
  draft_incident_update: "Save a new plain-text incident note as a draft and return the builder's approval link. Get the incident id from get_incidents. The note never appears publicly until the builder publishes it in the dashboard. Supply request_id for safe retries. Needs write access.",
};
export const MCP_TOOLS = toolNames.map(name => {
  const title = name.replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
  const write = writeTools.includes(name);
  return { name, title, description: descriptions[name], inputSchema: z.toJSONSchema(inputs[name], { io: "input" }), outputSchema: z.toJSONSchema(outputs[name]),
    annotations: { title, readOnlyHint: !write, destructiveHint: name === "pause", idempotentHint: name !== "scan_app", openWorldHint: name === "scan_app" || name === "create_monitor" || name === "provision_app" } };
});
