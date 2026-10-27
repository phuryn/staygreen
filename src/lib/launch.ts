// What ships at launch and what says "Coming soon". One flag per area; flipping one is the
// whole change, because every screen reads these instead of deciding for itself.
//
// Rule for "live": the mechanism is verified, not assumed. Each "soon" names what settles it.

import { locations } from "./plans";

export type Launch = "live" | "soon";

export const launch = {
  // Monitor types (spec.md § 3)
  http: "live",
  ssl: "live",
  heartbeat: "live",
  dns: "live",
  tcp: "live",
  // Stripe's List Events API takes delivery_success=false (checked 2026-10-21 in the API reference).
  stripe: "live",
  // MCP server monitor: handshake, tool baseline, OAuth checks. Owner's call, 2026-10-21.
  mcp: "soon",
  // Supabase: health checks with the publishable key and Paused read from DNS, with no Supabase
  // OAuth. Owner's call, 2026-10-22 (spec.md § 3.6, decisions.md).
  supabase: "live",

  // Surfaces
  statusPages: "live",
  customDomains: "live",
  // The in-app banner and the footer pill, from one script (spec.md § 7).
  widget: "live",
  // The README badge, an image with no script (spec.md § 7).
  badge: "live",
  alerts: "live",
  // Severity routing is live (028); delay/repeat and maintenance controls are not built.
  alertTiming: "soon",
  maintenanceWindows: "soon",
  // No CSV producer exists yet; history retention itself is live.
  csvExport: "soon",
  // The location becomes sellable only when its probe can serve Builder monitors.
  frankfurt: locations.fra1.live ? "live" : "soon",
  // Staygreen's own MCP server and REST API for agents (spec.md § 8). If "MCP Server" in the
  // owner's note meant this rather than the monitor type, set this to "soon".
  agentMcp: "live",
  scan: "live",
  // Deferred at launch; revisit when demand or sending costs justify it (decisions.md, 2026-10-23).
  subscribers: "soon",

  // Machinery a visitor never sees labelled, listed so `built` can say whether it runs yet.
  // Both ship at launch, so neither ever reads "Coming soon".
  // The probes that check monitors on their schedule (spec.md § 4).
  probes: "live",
  // Paying for Builder through Clerk Billing (spec.md § 1).
  billing: "live",
} as const satisfies Record<string, Launch>;

export type LaunchArea = keyof typeof launch;

export const isLive = (area: LaunchArea) => launch[area] === "live";

// What this build actually runs, which is not the same question. `launch` is the promise for
// launch day and the landing page's Coming soon labels read it; `built` is what works today.
// A screen that *does* the thing (runs a scan, sends an alert, serves a widget, issues a token)
// checks `isBuilt`, and until then says plainly that it's coming. Nothing simulated is ever
// shown as a result. Flip one when its stage in `docs/product/plan.md` passes its exit test.
//
// A monitor type that is built can be configured and saved; whether anything checks it is
// `probes`. The public site's "still being built" note reads `probes` and `alerts`, and its
// Builder buttons read `billing`, so none of them needs editing when a stage lands.
export const built = {
  http: true,
  ssl: true,
  heartbeat: true,
  dns: true,
  tcp: true,
  stripe: true, // stage 3.3; live-system acceptance remains in the stage hand-off
  mcp: false,
  supabase: true, // stage 3.3
  statusPages: true,
  // Stage 3.2. Proven end to end on development on 2026-10-24 (`environments.md § Log`); the
  // stage's done-when, AskOne's own page moving to Staygreen, is still open.
  customDomains: true,
  widget: true, // stage 3.4b; owner deployment pending
  badge: true, // served by the app at /s/<slug>/badge.svg until the status edge (stage 3.2)
  // Email and Telegram (stage 2.3). Slack is the rest of 2.3, Discord and the signed webhook 3.1;
  // the Alerts screen lists them as coming. Flipped with the screen that sends, because the screen
  // and the legal pages must say alerts go out the day they do (`docs/product/decisions.md`).
  alerts: true,
  alertTiming: false,
  maintenanceWindows: false,
  csvExport: false,
  frankfurt: locations.fra1.live,
  agentMcp: true, // stage 3.4a; real-client acceptance is an owner run
  scan: true, // stage 3.4b; owner migration/deployment pending
  subscribers: false, // deferred beyond launch (decisions.md, 2026-10-23)
  // Stage 2.2. On since production's probes check every workspace and its receiver answers at
  // in.staygreen.io (2026-10-24), though the stage's drill hasn't run there: the pages, the terms and
  // the privacy policy must say checks run the day they do (`docs/product/decisions.md`).
  probes: true,
  billing: true, // stage 4.1a: Clerk organization checkout; instance setup in docs/billing.md
} as const satisfies Record<LaunchArea, boolean>;

export const isBuilt = (area: LaunchArea) => built[area];

/** What each area is called on a page, for the lists that are built from the launch list. */
export const areaLabel: Record<LaunchArea, string> = {
  http: "HTTP monitors",
  ssl: "SSL and domain expiry",
  heartbeat: "Heartbeats",
  dns: "DNS monitors",
  tcp: "TCP monitors",
  stripe: "Stripe webhook monitors",
  // Said in full: "MCP server monitors" read as Staygreen's own MCP server, which is live (owner, 2026-10-24).
  mcp: "Monitoring your own MCP server",
  supabase: "Supabase monitors",
  statusPages: "Status pages",
  customDomains: "Custom domains",
  widget: "The in-app banner and status pill",
  badge: "The README badge",
  alerts: "Alerts",
  alertTiming: "Alert delay and repeat while down",
  maintenanceWindows: "Maintenance windows",
  csvExport: "CSV export",
  frankfurt: `Checks from ${locations.fra1.city} (${locations.fra1.country})`,
  agentMcp: "The MCP server and API for agents",
  scan: "The scan",
  subscribers: "Email subscribers",
  probes: "Scheduled checks",
  billing: "Billing",
};

/** The areas that say "Coming soon" at launch, in the launch list's order. */
export const soonAreas = (Object.keys(launch) as LaunchArea[]).filter((a) => launch[a] === "soon");

export const soonNote: Partial<Record<LaunchArea, string>> = {
  mcp: "Watches your MCP server's handshake, OAuth metadata and tool list, and tells you when a tool disappears.",
  supabase: "Checks your Supabase project's Auth and Storage with its publishable key, and reports paused or deleted when its address stops resolving. Add a verified database read to help keep a free project active. Permission failures stop requests until you edit and test the monitor.",
};
