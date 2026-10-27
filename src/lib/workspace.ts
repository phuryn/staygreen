import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { clerkClient } from "@clerk/nextjs/server";
import { hasPermission, NotAllowed, PERMISSIONS, requireWorkspaceAccess, type Caller, type Permission } from "./authz";
import { describeCron } from "./cron";
import { db, type Row } from "./db";
import type { Database } from "./database.types";
import { assetPath } from "./page-assets";
import { openHeartbeat } from "./heartbeat";
import { heartbeatView } from "./heartbeat-view";
import { measuredById, monitorHistoryDto, monitorHistoryOf, nothingMeasured, sinceLastEdit, workspaceHistoryDto, type MonitorHistory } from "./history";
import type { App, Assertion, Channel, Delivery, HeartbeatLatest, Incident, Monitor, MonEvent, NoteState, Op, ReceivedPing, Snapshot, StatusPage } from "./model";
import { isLocationId, type Entitlements, type Slug } from "./plans";
import { currentCaller, currentEntitlements, devPlanSimulation } from "./session";
import { monitorDefaults } from "./monitor-defaults";
import { sslOf } from "./expiry";
import { dnsRecordName } from "./page-domain";

/* The member side of the three functions (`AGENTS.md § 1.1`), and what a
   dashboard page renders from.

   - `requireMember(path)`: the signed-in caller, the workspace of their active
     organization (created on the first visit), and what their plan allows. A
     signed-out visitor goes to sign-in and back to `path`. A member whose role
     holds nothing in Phase 1 gets the same 404 as a stranger (`docs/permissions.md`).
   - `resolve<Thing>(id)`: the row's id and the workspace that owns it, from the
     URL, before anything about the caller is asked. Not-found and not-owned are
     the same `null`.
   - `loadSnapshot(member)`: every row of the workspace a screen shows, read in
     one call to `workspace_snapshot` (migration 022, with the alert lists since 024), mapped to the shapes in
     `model.ts`, with what the probes measured and one boolean per permission.
   - `heartbeatUrlOf(member, id)`: one heartbeat's ping URL, for its own page
     only, never in the snapshot.
   - `monitorHistory(member, id)`: one monitor's last 24 hours of windows, failed
     checks and state changes, for its own page only.
   - `heartbeatLatestOf(member, id)`: what a heartbeat's newest ping, `/start` and
     `/fail` carried, for its own page only.

   Reads only: the writes are `src/app/(app)/app/actions.ts`. */

export type WorkspaceRow = Pick<Row<"workspaces">, "id" | "clerk_org_id">;

export type Member = { caller: Caller; workspace: WorkspaceRow; entitlements: Entitlements };

/** Cached per request, so the layout, the page and an action share one Clerk read and one
 *  `ensure_workspace`. */
const lookupMember = cache(async (): Promise<Member | "signed-out" | "no-access"> => {
  const caller = await currentCaller();
  if (!caller) return "signed-out";
  // With *Membership required* every session has an active organization once its sign-in
  // task is done; a pending session is signed out to `auth()`, so this is rarely reached.
  if (!caller.orgId) return "no-access";
  // The role is asked before the row is created, so a member whose role holds nothing
  // never creates a workspace. Membership of the active organization is true by construction.
  if (!hasPermission({ id: "", clerk_org_id: caller.orgId }, caller, "monitors:read")) return "no-access";
  const { data, error } = await db().rpc("ensure_workspace", { p_clerk_org_id: caller.orgId });
  if (error || !data) throw new Error(`ensure_workspace failed: ${error?.code ?? "no row"}`);
  const workspace = { id: data.id, clerk_org_id: data.clerk_org_id };
  try {
    requireWorkspaceAccess(workspace, caller, "monitors:read");
  } catch (e) {
    if (e instanceof NotAllowed) return "no-access";
    throw e;
  }
  const entitlements = await currentEntitlements();
  // The probes check Builder monitors from Builder's third location by the plan stored here
  // (migration 20261024090000), which nothing else reads. It follows the verified session, never a
  // simulated plan, nor one Clerk didn't answer (`unread`: Free for this request only); a write
  // that fails costs only that location until the next visit.
  if (!entitlements.unread && data.plan !== entitlements.plan && !(await devPlanSimulation())) {
    await db().from("workspaces").update({ plan: entitlements.plan }).eq("id", data.id);
  }
  return { caller, workspace, entitlements };
});

/** The member for this request, or null when nobody is signed in. A caller who holds nothing
 *  here gets the 404 a stranger gets. */
export async function getMember(): Promise<Member | null> {
  const m = await lookupMember();
  if (m === "no-access") notFound();
  return m === "signed-out" ? null : m;
}

function toSignIn(path: string): never {
  redirect(`/sign-in?redirect_url=${encodeURIComponent(path)}`);
}

/** A dashboard page's first line. `path` is where sign-in sends the visitor back to. */
export async function requireMember(path: string): Promise<Member> {
  const member = await getMember();
  if (!member) toSignIn(path);
  return member;
}

/** A detail page's first line: the member and the thing its URL names, read side by side, since
 *  `resolve<Thing>` asks nothing about the caller. The page checks the permission on the pair
 *  (`requireIn`) before it reads anything else. The resolve waits for a session to exist, so a
 *  signed-out visitor still costs no database read: they go to sign-in as from `requireMember`. */
export async function requireMemberWith<T>(path: string, resolve: () => Promise<T>): Promise<[Member, T]> {
  if (!(await currentCaller())) toSignIn(path);
  return Promise.all([requireMember(path), resolve()]);
}

/** For a Server Action, which answers with a result rather than a page: null for a caller
 *  who is signed out or holds nothing here. */
export async function memberOrNull(): Promise<Member | null> {
  const m = await lookupMember();
  return typeof m === "string" ? null : m;
}

export function allowed(workspace: WorkspaceRow, caller: Caller | null, permission: Permission): boolean {
  return hasPermission(workspace, caller, permission);
}

// ── resolve ─────────────────────────────────────────────────────────────────

/** The id shape `public.new_id` produces. Anything else is not found before a query is spent. */
const idOf = (prefix: string) => new RegExp(`^${prefix}_[0-9a-f]{24}$`);

type Owned = { id: string; workspace: WorkspaceRow };

async function ownerOf(workspaceId: string): Promise<WorkspaceRow | null> {
  const { data, error } = await db().from("workspaces").select("id, clerk_org_id").eq("id", workspaceId).maybeSingle();
  if (error) throw new Error(`workspace read failed: ${error.code}`);
  return data;
}

async function resolveIn(table: "apps" | "monitors" | "incidents" | "status_pages", prefix: string, id: string): Promise<Owned | null> {
  if (!idOf(prefix).test(id)) return null;
  const { data, error } = await db().from(table).select("id, workspace_id").eq("id", id).maybeSingle();
  if (error) throw new Error(`${table} read failed: ${error.code}`);
  if (!data) return null;
  const workspace = await ownerOf(data.workspace_id);
  return workspace ? { id: data.id, workspace } : null;
}

export const resolveApp = (id: string) => resolveIn("apps", "app", id);
export const resolveMonitor = (id: string) => resolveIn("monitors", "mon", id);
export const resolveIncident = (id: string) => resolveIn("incidents", "inc", id);
export const resolvePage = (id: string) => resolveIn("status_pages", "page", id);

/** For a page: the resolved thing, or the same 404 for missing, foreign and forbidden. */
export function requireIn(owned: Owned | null, member: Member, permission: Permission): Owned {
  if (!owned || !allowed(owned.workspace, member.caller, permission)) notFound();
  return owned;
}

// ── a heartbeat's URL ───────────────────────────────────────────────────────

/** The ping URL, for the monitor's own page. Read by id *and* the member's workspace, and only
 *  with the permission that can make a new one, so another workspace's monitor, a member who
 *  holds nothing, and a monitor that isn't a heartbeat are all null. Null too for a heartbeat
 *  stored before URLs were kept, or a copy that doesn't open for this monitor; its page offers a
 *  new URL. Never part of `loadSnapshot`, which every screen receives. */
export async function heartbeatUrlOf(member: Member, monitorId: string): Promise<string | null> {
  if (!allowed(member.workspace, member.caller, "monitors:write")) return null;
  const { data, error } = await db()
    .from("monitors")
    .select("heartbeat_token_sealed")
    .eq("id", monitorId)
    .eq("workspace_id", member.workspace.id)
    .eq("type", "heartbeat")
    .maybeSingle();
  if (error) throw new Error(`heartbeat read failed: ${error.code}`);
  return data?.heartbeat_token_sealed ? openHeartbeat(data.heartbeat_token_sealed, monitorId) : null;
}

// ── what a heartbeat's job sent ─────────────────────────────────────────────

const received = (at: string | null, payload: unknown, note: string | null): ReceivedPing | null =>
  at ? { at: Date.parse(at), payload: obj(payload), note } : null;

/** The newest good ping, `/start` and `/fail` with their payloads, masked by the receiver, for the
 *  heartbeat's own page. Read by id *and* the member's workspace, so another workspace's monitor
 *  has none; null for a monitor that isn't a heartbeat or hasn't been pinged. Never part of
 *  `loadSnapshot`: three payloads a heartbeat, of up to 1 KB each, would weigh on every screen. */
export async function heartbeatLatestOf(member: Member, monitorId: string): Promise<HeartbeatLatest | null> {
  const { data, error } = await db()
    .from("heartbeat_latest")
    .select("ping_at, ping_payload, ping_note, start_at, start_payload, start_note, fail_at, fail_payload, fail_note")
    .eq("monitor_id", monitorId)
    .eq("workspace_id", member.workspace.id)
    .maybeSingle();
  if (error) throw new Error(`heartbeat read failed: ${error.code}`);
  if (!data) return null;
  return {
    ping: received(data.ping_at, data.ping_payload, data.ping_note),
    start: received(data.start_at, data.start_payload, data.start_note),
    fail: received(data.fail_at, data.fail_payload, data.fail_note),
  };
}

// ── one monitor's history ───────────────────────────────────────────────────

/** The response-time chart and the failed checks and state changes for one monitor's page,
 *  read by id *and* the member's workspace, so another workspace's monitor has none. Its 24 hours
 *  of windows and its 20 failures with their snippets would make the snapshot every screen
 *  receives a hundred times heavier, so they are never part of it. */
export async function monitorHistory(member: Member, monitorId: string): Promise<MonitorHistory> {
  // The snapshot is read once a request (`cache`), so asking it the monitor's type costs no query.
  const [{ data, error }, snapshot] = await Promise.all([
    db().rpc("monitor_history", { p_workspace_id: member.workspace.id, p_monitor_id: monitorId }),
    loadSnapshot(member),
  ]);
  if (error) throw new Error(`monitor_history failed: ${error.code}`);
  const parsed = monitorHistoryDto.safeParse(data);
  if (!parsed.success) throw new Error("monitor_history returned an unexpected shape");
  return monitorHistoryOf(parsed.data, snapshot.monitors.find((m) => m.id === monitorId)?.type === "heartbeat");
}

// ── the snapshot ────────────────────────────────────────────────────────────

export type { Snapshot };

const ms = (t: string | null | undefined) => (t ? Date.parse(t) : 0);
// The dashboard selects its display fields only; credentials and probe counters stay in the row.
type MonitorRead = Omit<Row<"monitors">, "heartbeat_token_hash" | "heartbeat_token_sealed" | "service_runtime" | `probe_${string}`> & { service_status?: string | null };
const isActivePause = (m: Pick<MonitorRead, "paused_at" | "paused_until">, now: number) => !!m.paused_at && (!m.paused_until || Date.parse(m.paused_until) > now);

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function assertionsOf(config: Json): Assertion[] {
  const list = Array.isArray(config.assertions) ? config.assertions : [];
  return list.map((a, i) => {
    const o = obj(a);
    return { id: `a${i + 1}`, path: str(o.path), op: (str(o.op, "==") as Op), value: str(o.value) };
  });
}

/** What `workspace_snapshot` (migration 022, and 024's alert lists) returns: every row of the workspace a screen shows, each
 *  list in the order the screens read it, with the columns the function names and no others, and
 *  `workspace_history`'s own answer. One round trip: twelve requests at once had cost about three
 *  times one (`docs/product/decisions.md`, 2026-10-22, "Moving around the dashboard"). */
type SnapshotRows = {
  apps: Row<"apps">[];
  monitors: MonitorRead[];
  monitor_secrets: Pick<Row<"monitor_secrets">, "monitor_id" | "name">[];
  incidents: Row<"incidents">[];
  incident_notes: Row<"incident_notes">[];
  status_pages: Row<"status_pages">[];
  page_components: Row<"page_components">[];
  component_monitors: Pick<Row<"component_monitors">, "component_id" | "monitor_id">[];
  // Binary content never joins a dashboard snapshot.
  page_assets: Pick<Row<"page_assets">, "id" | "page_id" | "kind">[];
  app_logos: Pick<Row<"app_logos">, "id" | "app_id">[];
  // What each heartbeat's job sent (migration 019). The good ping's payload is read here only to
  // judge its assertions and take its first field; the payloads themselves are its page's.
  heartbeat_latest: Pick<Row<"heartbeat_latest">, "monitor_id" | "ping_at" | "ping_payload" | "start_at" | "fail_at" | "judged_at" | "run_at">[];
  // What the registries said about the domains of this workspace's SSL hosts (migration 020).
  domains: Database["public"]["Functions"]["workspace_domains"]["Returns"];
  // Where alerts go, and the settled receipts of incidents' alerts, for an incident's "Alerts
  // sent" (migrations 023 and 024). Never a confirmation hash, a chat id or a member's address.
  alert_channels: Pick<Row<"alert_channels">, "id" | "kind" | "audience" | "address" | "label" | "confirmed_at">[];
  alert_deliveries: Pick<Row<"alert_deliveries">, "id" | "event" | "incident_id" | "channel_id" | "status" | "created_at" | "sent_at">[];
  // What the probes measured, aggregated in Postgres (migration 014), checked by its own DTO.
  history: unknown;
};

const SNAPSHOT_LISTS = [
  "apps", "monitors", "monitor_secrets", "incidents", "incident_notes", "status_pages",
  "page_components", "component_monitors", "page_assets", "app_logos", "heartbeat_latest", "domains",
  "alert_channels", "alert_deliveries",
] as const satisfies readonly Exclude<keyof SnapshotRows, "history">[];

/** The function's answer, or a throw: a list missing is an error, never an empty screen. */
function snapshotRowsOf(data: unknown): SnapshotRows {
  const o = obj(data);
  for (const key of SNAPSHOT_LISTS) if (!Array.isArray(o[key])) throw new Error(`workspace_snapshot returned no ${key}`);
  return o as unknown as SnapshotRows;
}

/** Note authors are Clerk users, read at render time and never stored (`AGENTS.md § 1.5`). */
async function authorNames(ids: string[], self: string): Promise<Map<string, string>> {
  const names = new Map<string, string>([[self, "You"]]);
  const others = ids.filter((id) => id !== self);
  if (!others.length) return names;
  try {
    const client = await clerkClient();
    const { data } = await client.users.getUserList({ userId: others, limit: others.length });
    for (const u of data) names.set(u.id, [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "A teammate");
  } catch {
    // Names are a courtesy; a Clerk outage must not take the incident page down with it.
  }
  return names;
}

export const loadSnapshot = cache(async (member: Member): Promise<Snapshot> => {
  const { data, error } = await db().rpc("workspace_snapshot", { p_workspace_id: member.workspace.id });
  if (error) throw new Error(`workspace_snapshot failed: ${error.code}`);
  const rows = snapshotRowsOf(data);
  const domainRead = await db().from("page_domains").select("host,cname_target,page_id,created_at,verified_at").eq("workspace_id", member.workspace.id);
  if (domainRead.error) throw new Error(`page_domains read failed: ${domainRead.error.code}`);
  const pageDomains = new Map((domainRead.data ?? []).map(d => [d.page_id, d]));
  const parsedHistory = workspaceHistoryDto.safeParse(rows.history);
  if (!parsedHistory.success) throw new Error("workspace_history returned an unexpected shape");
  const now = Date.now();
  const measured = measuredById(parsedHistory.data, now);
  const monitorRows = rows.monitors;
  const incidentRows = rows.incidents;

  const beatOf = new Map(rows.heartbeat_latest.map((b) => [b.monitor_id, b]));
  const domainOf = new Map(rows.domains.map((d) => [d.host, d]));
  const openByMonitor = new Map(incidentRows.filter((i) => !i.resolved_at).map((i) => [i.monitor_id, i.id]));
  const secretNames = new Map<string, string[]>();
  for (const s of rows.monitor_secrets) secretNames.set(s.monitor_id, [...(secretNames.get(s.monitor_id) ?? []), s.name]);

  const outMonitors: Monitor[] = monitorRows.map((r) => {
    const config = obj(r.config);
    const paused = isActivePause(r, now);
    const createdAt = ms(r.created_at);
    const events: MonEvent[] = [
      { id: `${r.id}-created`, t: createdAt, kind: "created", text: r.auto ? `Added automatically for ${r.target_host}` : "Monitor created" },
    ];
    if (paused) {
      const until = r.paused_until ? ` until ${new Date(r.paused_until).toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
      events.unshift({ id: `${r.id}-paused`, t: ms(r.paused_at), kind: "paused", text: `Paused${until}.${r.pause_reason ? ` ${r.pause_reason}` : ""}` });
    }
    const all = measured.get(r.id) ?? nothingMeasured();
    const got = r.state === null ? sinceLastEdit(all, ms(r.updated_at)) : all;
    const m: Monitor = {
      id: r.id,
      appId: r.app_id,
      type: r.type as Monitor["type"],
      name: r.name,
      target: r.target,
      intervalSec: r.interval_sec,
      state: paused ? "paused" : ((r.state as Monitor["state"] | null) ?? "unchecked"),
      stateSince: ms(r.state_since) || createdAt,
      createdAt,
      updatedAt: ms(r.updated_at) || createdAt,
      // Only a probe sets a state, so a state, or a window of this address, is a check that ran.
      checked: r.state !== null || got.reports.length > 0,
      ...got,
      failing: null,
      paused: paused ? { until: r.paused_until ? ms(r.paused_until) : null, reason: r.pause_reason ?? "" } : null,
      incidentId: openByMonitor.get(r.id) ?? null,
      auto: r.auto,
      events,
    };
    if (r.type === "http") {
      Object.assign(m, {
        method: str(config.method, "GET") as Monitor["method"],
        expect: str(config.expect, "2xx"),
        keyword: str(config.keyword) || undefined,
        slowMs: num(config.slowMs, monitorDefaults.slowMs.http),
        timeoutSec: num(config.timeoutSec, 15),
        assertions: assertionsOf(config),
        secretHeaders: secretNames.get(r.id) ?? [],
      });
    } else if (r.type === "ssl") {
      const host = str(config.host, r.target);
      m.ssl = sslOf(host, r, domainOf.get((r.target_host ?? host).toLowerCase()), now);
    } else if (r.type === "tcp") {
      m.tcp = { host: str(config.host), port: num(config.port, 443), tls: config.tls === true };
      m.slowMs = num(config.slowMs, monitorDefaults.slowMs.tcp);
    } else if (r.type === "dns") {
      m.dns = { record: str(config.record, "A") as NonNullable<Monitor["dns"]>["record"], name: str(config.name), expected: str(config.expected) };
    } else if (r.type === "supabase") {
      m.serviceConfig = { projectUrl: str(config.projectUrl), databaseRead: str(config.databaseRead) };
      m.hasServiceKey = (secretNames.get(r.id) ?? []).includes("service-key");
      if (m.state === "down" && r.service_status === "paused_or_deleted") m.serviceStatus = "paused_or_deleted";
    } else if (r.type === "stripe") {
      m.serviceConfig = { endpoints: Array.isArray(config.endpoints) ? config.endpoints.filter((x): x is string => typeof x === "string") : [],
        critical: Array.isArray(config.critical) ? config.critical.filter((x): x is string => typeof x === "string") : [],
        failureThreshold: num(config.failureThreshold, 3), windowMin: num(config.windowMin, 30), pendingMin: num(config.pendingMin, 30) };
      m.hasServiceKey = (secretNames.get(r.id) ?? []).includes("service-key");
    } else if (r.type === "heartbeat") {
      const schedule = str(config.schedule, "0 6 * * *");
      const sch = describeCron(schedule);
      const tz = str(config.tz, monitorDefaults.tz);
      const b = beatOf.get(r.id);
      const at = (t: string | null | undefined) => (t ? Date.parse(t) : null);
      const assertions = assertionsOf(config);
      const view = heartbeatView(
        { pingAt: at(b?.ping_at), pingPayload: b?.ping_at ? obj(b.ping_payload) : null, startAt: at(b?.start_at), failAt: at(b?.fail_at), judgedAt: at(b?.judged_at), runAt: at(b?.run_at) },
        { schedule, tz, versionAt: Math.floor(ms(r.updated_at)), paused, assertions },
      );
      // Each assertion with what the newest good ping held, judged by the code that judged it.
      m.assertions = assertions.map((a, i) => (view.results ? { ...a, got: view.results[i].got, pass: view.results[i].pass } : a));
      m.hb = { token: "", schedule, scheduleLabel: sch.label, periodMin: sch.periodMin, tz, graceMin: num(config.graceMin, monitorDefaults.graceMin), maxRunMin: num(config.maxRunMin, monitorDefaults.maxRunMin),
        lastPingAt: view.lastPingAt, lastKind: view.lastKind, summary: view.summary, runningSince: view.runningSince, expectedAt: view.expectedAt };
    }
    return m;
  });

  const appOfMonitor = new Map(monitorRows.map((m) => [m.id, m.app_id]));
  const noteRows = rows.incident_notes;
  const names = await authorNames([...new Set(noteRows.map((n) => n.author_user_id).filter((x): x is string => !!x))], member.caller.userId);

  const outIncidents: Incident[] = incidentRows
    .filter((i) => appOfMonitor.has(i.monitor_id))
    .map((i) => {
      const ev = obj(i.evidence);
      const timeline = (Array.isArray(i.timeline) ? i.timeline : []).map((t) => ({ t: ms(str(obj(t).t)), text: str(obj(t).text) }));
      return {
        id: i.id,
        monitorId: i.monitor_id,
        appId: appOfMonitor.get(i.monitor_id)!,
        title: i.title,
        severity: i.severity as Incident["severity"],
        openedAt: ms(i.opened_at),
        resolvedAt: i.resolved_at ? ms(i.resolved_at) : null,
        ackedAt: i.acked_at ? ms(i.acked_at) : null,
        evidence: {
          request: str(ev.request),
          summary: str(ev.summary),
          status: typeof ev.status === "number" ? ev.status : undefined,
          assertion: str(ev.assertion) || undefined,
          got: str(ev.got) || undefined,
          locations: (Array.isArray(ev.locations) ? ev.locations : []).filter(isLocationId),
          snippet: str(ev.snippet),
        },
        timeline,
        notes: noteRows
          .filter((n) => n.incident_id === i.id)
          .map((n) => ({
            id: n.id,
            state: n.state as NoteState,
            text: n.body,
            status: n.status as "draft" | "published",
            at: ms(n.published_at ?? n.updated_at),
            author: n.author_user_id ? (names.get(n.author_user_id) ?? "A teammate") : (n.author_client ?? "An agent"),
            byAgent: !n.author_user_id,
          })),
      };
    });

  const bound = new Map<string, string[]>();
  for (const b of rows.component_monitors) bound.set(b.component_id, [...(bound.get(b.component_id) ?? []), b.monitor_id]);
  const pageRows = rows.status_pages;
  const assetOf = (pageId: string, kind: string) => {
    const asset = rows.page_assets.find((a) => a.page_id === pageId && a.kind === kind);
    return asset ? assetPath(asset.id) : null;
  };
  const outPages: StatusPage[] = pageRows.map((p) => ({
    id: p.id,
    appId: p.app_id,
    slug: p.slug,
    name: p.name,
    logoText: p.logo_text,
    logoUrl: assetOf(p.id, "logo"),
    faviconUrl: assetOf(p.id, "favicon"),
    homepage: p.homepage ?? "",
    accent: p.accent,
    theme: p.theme as StatusPage["theme"],
    domain: pageDomains.has(p.id) ? { host: pageDomains.get(p.id)!.host, name: dnsRecordName(pageDomains.get(p.id)!.host),
      cnameTarget: pageDomains.get(p.id)!.cname_target,
      startedAt: ms(pageDomains.get(p.id)!.created_at), step: pageDomains.get(p.id)!.verified_at ? 4 : 1 } : null,
    components: rows.page_components.filter((c) => c.page_id === p.id).map((c) => ({ id: c.id, name: c.name, inApp: c.in_app, monitorIds: bound.get(c.id) ?? [] })),
    poweredBy: p.powered_by,
    membersOnly: p.members_only ?? false,
    noindex: p.noindex,
    subscribersOn: false,
    subscribers: 0,
    showHistoryDays: p.history_days,
  }));

  const logoOf = (appId: string) => {
    const logo = rows.app_logos.find((l) => l.app_id === appId);
    return logo ? assetPath(logo.id) : null;
  };
  const outApps: App[] = rows.apps.map((a) => ({
    id: a.id,
    name: a.name,
    url: a.url ?? "",
    logoUrl: logoOf(a.id),
    blurb: "",
    channelIds: [],
    pageId: pageRows.find((p) => p.app_id === a.id)?.id,
  }));

  const can = Object.fromEntries(PERMISSIONS.map((p) => [p, allowed(member.workspace, member.caller, p)])) as Snapshot["can"];

  const outChannels: Channel[] = rows.alert_channels.map((c) => ({
    id: c.id,
    kind: c.kind as Channel["kind"],
    label: c.audience === "members" ? "Workspace members" : c.kind === "email" ? (c.address ?? "Email address") : (c.label ?? "Telegram chat"),
    target: c.audience === "members" ? "Each member's own address" : (c.address ?? c.label ?? ""),
    verified: !!c.confirmed_at,
    routes: "all",
  }));
  // One line per incident, channel and event: the members' channel has a receipt per member, and
  // it is "delivered" when every one of them was.
  const titleOf = new Map(incidentRows.map((i) => [i.id, i.title]));
  const grouped = new Map<string, Delivery>();
  for (const d of rows.alert_deliveries) {
    const key = `${d.incident_id}|${d.channel_id}|${d.event}`;
    const t = ms(d.sent_at ?? d.created_at);
    const had = grouped.get(key);
    if (had) {
      had.ok = had.ok && d.status === "sent";
      had.t = Math.max(had.t, t);
    } else {
      grouped.set(key, { id: d.id, t, channelId: d.channel_id ?? "", event: `incident.${d.event}`, incidentId: d.incident_id ?? undefined, title: titleOf.get(d.incident_id ?? "") ?? "", ok: d.status === "sent" });
    }
  }

  return {
    v: 1,
    version: 0,
    seededAt: 0,
    now,
    loadedAt: now,
    plan: member.entitlements.plan,
    cycle: "yearly",
    workspace: { name: "", owner: "" },
    apps: outApps,
    monitors: outMonitors,
    incidents: outIncidents,
    channels: outChannels,
    deliveries: [...grouped.values()].sort((a, b) => b.t - a.t),
    pages: outPages,
    tokens: [],
    activity: [],
    teammates: [],
    toasts: [],
    notified: [],
    live: false,
    seq: 0,
    can,
    features: [...member.entitlements.features],
    limits: member.entitlements.limits,
  };
});
