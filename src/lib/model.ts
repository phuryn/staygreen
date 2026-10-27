// The shapes behind every screen (spec.md § 2). The dashboard fills them from the database
// (`workspace.ts`, `loadSnapshot`); the public prototype pages still fill them from the
// simulation in `sim.ts`, until each one is built for real (`docs/BACKLOG.md`).

import type { Permission } from "./authz";
import type { Limits, LocationId, PlanId, Slug } from "./plans";
import type { StripeConfig, SupabaseConfig } from "./service-monitor";

/** `unchecked` is a display state, not a stored one: a monitor nobody has checked yet has no
 *  state in the database, and every screen says so rather than guessing (`AGENTS.md § 2.8`). */
export type State = "up" | "degraded" | "down" | "paused" | "unchecked";
export type MonitorType = "http" | "ssl" | "heartbeat" | "dns" | "mcp" | "supabase" | "stripe" | "tcp";

/** What every screen calls each monitor type. */
export const typeLabel: Record<MonitorType, string> = {
  http: "HTTP",
  ssl: "SSL and domain",
  heartbeat: "Heartbeat",
  dns: "DNS",
  mcp: "MCP server",
  supabase: "Supabase",
  stripe: "Stripe webhooks",
  tcp: "TCP port",
};
export type Op = "==" | "!=" | "<" | ">" | "<=" | ">=" | "contains" | "exists";

export type Assertion = {
  id: string;
  path: string;
  op: Op;
  value: string;
  got?: string;
  pass?: boolean;
};

/** One 5-minute window of a monitor, every location merged. A window whose checks all failed has
 *  no response time: `p50` and `p95` are null. */
export type Point = { t: number; p50: number | null; p95: number | null; fails: number; checks: number };

/** A location's newest 5-minute window (`rollups_5m`). A probe writes a window when it closes, so
 *  `end` is about when it reported, and the newest check in it was up to five minutes before. */
export type Report = { loc: LocationId; end: number; checks: number; failures: number; p50: number | null };

/** Uptime over a stretch of time: the share of the time the probes' windows covered that no
 *  confirmed outage took. Null with nothing covered: no check is no uptime to claim. */
export type Uptime = { pct: number | null; coveredMs: number };

export type MonEvent = {
  id: string;
  t: number;
  kind: "pass" | "fail" | "unconfirmed" | "down" | "degraded" | "recovered" | "paused" | "resumed" | "created" | "ping" | "edited";
  text: string;
  loc?: LocationId;
  snippet?: string;
};

/** What a heartbeat's job sent: `/<token>`, `/<token>/start` or `/<token>/fail`. */
export type PingKind = "ping" | "start" | "fail";

/** One ping as the receiver recorded it (`ingest/`): its payload already masked and capped, and
 *  why fields are missing when they are (`not_json`, `too_large`, `truncated`). */
export type ReceivedPing = { at: number; payload: Record<string, unknown>; note: string | null };

/** The newest of each kind, for a heartbeat's own page only: never in the snapshot. */
export type HeartbeatLatest = { ping: ReceivedPing | null; start: ReceivedPing | null; fail: ReceivedPing | null };

export type FailMode =
  | "assertion"
  | "status"
  | "slow"
  | "missed"
  | "hb-assertion"
  | "stripe"
  | "dns"
  | "refused";

export type Monitor = {
  id: string;
  appId: string;
  type: MonitorType;
  name: string;
  target: string;
  intervalSec: number;
  state: State;
  stateSince: number;
  createdAt: number;
  /** When its settings last changed (`updated_at`): created, edited, paused or resumed. Absent in
   *  the prototype's fixtures, which read `createdAt` instead. */
  updatedAt?: number;
  /** A probe has checked it: it has a state in the database, or a location has reported on it.
   *  A paused monitor keeps what it had. False is the only time a screen says "Not checked yet". */
  checked: boolean;
  /** Each location's newest window, newest first; empty until one has reported. */
  reports: Report[];
  uptime: { day: Uptime; month: Uptime };
  /** The 95th percentile of the last 24 hours' 5-minute p95s, every location together. */
  p95: number | null;
  failing: FailMode | null;
  paused: null | { until: number | null; reason: string };
  incidentId: string | null;
  /** An SSL monitor Staygreen added for an HTTPS host: it counts against no limit (`spec.md § 3.2`). */
  auto?: boolean;
  method?: "GET" | "HEAD" | "POST";
  expect?: string;
  keyword?: string;
  slowMs?: number;
  timeoutSec?: number;
  assertions?: Assertion[];
  secretHeaders?: string[];
  serviceConfig?: StripeConfig | SupabaseConfig;
  hasServiceKey?: boolean;
  serviceStatus?: "paused_or_deleted";
  hb?: {
    /** Empty for a real monitor: the snapshot never carries the URL; the monitor's own page reads it (`AGENTS.md § 2.8`). */
    token: string;
    schedule: string;
    scheduleLabel: string;
    periodMin: number;
    tz: string;
    graceMin: number;
    maxRunMin: number;
    /** The newest ping of any kind (a good ping, a `/start` or a `/fail`); 0 when none has
     *  arrived, the only time a screen says "No ping yet". */
    lastPingAt: number;
    /** Which kind the newest ping was. */
    lastKind: PingKind | null;
    /** The newest good ping's first field, as the receiver masked it: a list row's one number. */
    summary: [string, string] | null;
    /** A `/start` with no finish after it, since the last edit: the run that is open. */
    runningSince: number | null;
    /** The next expected run, from the schedule module the probe judges with (`cron.ts`);
     *  null before the first ping, while paused, or for a schedule that never runs. */
    expectedAt: number | null;
  };
  /** What the SSL check read and the registry said (`src/lib/expiry.ts`). Each part is absent
   *  until something filled it: the certificate after a check that reached a handshake, the
   *  domain after the probes' leader has looked it up. */
  ssl?: {
    host: string;
    /** Whole days until the certificate expires, below zero once it has. */
    certDays?: number;
    issuer?: string;
    domain?: DomainRegistration;
  };
  dns?: { record: "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "CAA" | "NS"; name: string; expected: string; got?: string; auto?: boolean };
  stripe?: {
    account: string;
    endpoints: { url: string; enabled: boolean }[];
    critical: string[];
    failed30m: number;
    pending: number;
    lastFailure?: { type: string; at: number; count: number };
  };
  tcp?: { host: string; port: number; tls: boolean };
  /** Uptime on each of the last 90 UTC days, oldest first and ending today; -1 for a day with no
   *  window, never 100. */
  daily: number[];
  events: MonEvent[];
};

/** A host's domain as its registry's RDAP service described it (`domain_registrations`): the
 *  domain it answered for, or why there is none. `days` is whole days to its expiry (below zero
 *  once past it), null when the registry publishes none. */
export type DomainRegistration =
  | { status: "found"; name: string; days: number | null; registrar: string | null }
  | { status: "no_rdap" | "not_found" | "failed"; name: string };

export type App = {
  id: string;
  name: string;
  url: string;
  /** Its logo's address (`/page-assets/<id>`), or null: chosen in Settings or imported from the
   *  app's own icon when it was added. Never the bytes. */
  logoUrl: string | null;
  blurb: string;
  channelIds: string[];
  pageId?: string;
};

export type NoteState = "investigating" | "identified" | "monitoring" | "resolved";

export type Note = {
  id: string;
  state: NoteState;
  text: string;
  status: "draft" | "published";
  at: number;
  author: string;
  /** Written through the API by an agent, not by a person in the dashboard. */
  byAgent?: boolean;
};

export type Incident = {
  id: string;
  monitorId: string;
  appId: string;
  title: string;
  severity: "down" | "degraded";
  openedAt: number;
  resolvedAt: number | null;
  ackedAt: number | null;
  evidence: {
    request: string;
    summary: string;
    status?: number;
    assertion?: string;
    got?: string;
    locations: LocationId[];
    snippet: string;
  };
  timeline: { t: number; text: string }[];
  notes: Note[];
};

export type ChannelKind = "email" | "telegram" | "slack" | "discord" | "webhook";

export type Channel = {
  id: string;
  kind: ChannelKind;
  label: string;
  target: string;
  verified: boolean;
  routes: "all" | "incidents" | "warnings";
};

export type Delivery = {
  id: string;
  t: number;
  channelId: string;
  event: string;
  incidentId?: string;
  title: string;
  ok: boolean;
};

export type Component = { id: string; name: string; monitorIds: string[]; inApp: boolean };

export type StatusPage = {
  id: string;
  appId: string;
  slug: string;
  name: string;
  logoText: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  homepage: string;
  accent: string;
  theme: "light" | "dark" | "visitor";
  domain: null | { host: string; name: string; cnameTarget: string; step: 1 | 2 | 3 | 4; startedAt: number };
  components: Component[];
  poweredBy: boolean;
  membersOnly: boolean;
  noindex: boolean;
  subscribersOn: boolean;
  subscribers: number;
  showHistoryDays: number;
};

export type Token = { id: string; name: string; prefix: string; createdAt: number; lastUsedAt: number | null; scope: "read" | "read-write" };

export type Activity = { id: string; t: number; client: string; tool: string; summary: string; write: boolean };

export type Teammate = { id: string; name: string; contact: string; via: "email" | "telegram" };

export type Toast = { id: string; t: number; tone: "up" | "down" | "warn" | "info"; title: string; body?: string; href?: string };

export type Sim = {
  v: number;
  version: number;
  seededAt: number;
  now: number;
  plan: PlanId;
  cycle: "yearly" | "monthly";
  workspace: { name: string; owner: string };
  apps: App[];
  monitors: Monitor[];
  incidents: Incident[];
  channels: Channel[];
  deliveries: Delivery[];
  pages: StatusPage[];
  tokens: Token[];
  activity: Activity[];
  teammates: Teammate[];
  toasts: Toast[];
  notified: string[];
  live: boolean;
  seq: number;
};

/** What a dashboard screen reads: the shapes above, filled from the database by `loadSnapshot`,
 *  plus one boolean per permission and the plan features held. What the probes measured comes
 *  from `workspace_history` (`history.ts`). */
export type Snapshot = Sim & {
  /** Server time when this was read; the client keeps the newest snapshot it has seen. */
  loadedAt: number;
  can: Record<Permission, boolean>;
  features: Slug[];
  /** The numbers the session read (`plans.ts`, `limitsOf`): above the plan's column on the owner's
   *  demo plan. Absent only in fixtures, which fall back to the column. */
  limits?: Limits;
};
