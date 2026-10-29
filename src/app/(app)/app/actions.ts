"use server";

import { pageSlugBase } from "@/lib/page-slug";
import { env } from "@/lib/env";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { withdrawAtEdge } from "@/lib/edge-control";
import { domainSchema, matchesCname } from "@/lib/domain-input";
import { servesOverTls } from "@/lib/page-domain";
import { z } from "zod";
import type { Permission } from "@/lib/authz";
import { TEST_BUDGET, testBudgetSpent } from "@/lib/budgets";
import { open, seal } from "@/lib/credentials";
import { headerContext } from "@/lib/seal";
import { db } from "@/lib/db";
import { describeDbError, isNotFound, type DbError } from "@/lib/db-errors";
import { newHeartbeat } from "@/lib/heartbeat";
import { isCreatable, parseMonitorDraft, type MonitorRow } from "@/lib/monitor-input";
import { isService, SERVICE_KEY } from "@/lib/service-monitor";
import { monitorDefaults } from "@/lib/monitor-defaults";
import { runTest, TEST_DEADLINE_MS, TEST_MIN_MS } from "@/lib/monitor-test";
import { holds } from "@/lib/plans";
import { assertSameOrigin, CrossOrigin } from "@/lib/request";
import { checkTarget } from "@/lib/targets";
import { allowed, memberOrNull, resolveApp, resolveIncident, resolveMonitor, resolvePage, type Member } from "@/lib/workspace";
import { linkSchema, NOTE_STATES, pageDraftSchema } from "@/lib/page-input";
import { assetPath, PAGE_ASSET_LIMIT, PAGE_ASSET_UNPREPARED, pageAssetKind, storablePageAsset } from "@/lib/page-assets";
import { siteModelFromEnv } from "@/lib/site-model";
import { runSuggestions } from "@/lib/suggestion-checks";
import { rootName, sslComesWith, suggestionTargets, type Suggestions } from "@/lib/suggestions";
import { isPublishableKey, supabaseCheckOf, SUPABASE_NAMES } from "@/lib/supabase-detect";
import { registrableDomain, sameDomain } from "@/lib/dependency-detect";
import type { TestOutcome } from "@/lib/test-result";

/* Every write the dashboard makes (`AGENTS.md § 1.1`, `§ 1.2`).

   Each one runs the same four steps before it touches a row: the Origin check,
   the member, the thing resolved from its id with its own workspace, and the
   permission in *that* workspace. Then one database function or statement, and
   the refusal worded by `db-errors.ts`. A thing that is missing, belongs to
   another workspace, or is out of the caller's reach is one answer: not found.

   Results are values, not throws, so the screen can show the sentence where the
   builder is looking. A throw is a bug or an outage, and the client wrapper
   (`workspace-store.tsx`) turns it into a generic error. */

export type Refusal = {
  ok: false;
  reason: string;
  fieldErrors?: Record<string, string>;
  /** Seconds until a spent budget allows the call again (`AGENTS.md § 1.2`: a structured retry delay). */
  retryAfterSec?: number;
};
export type Result<T extends object = object> = ({ ok: true } & T) | Refusal;

const NOT_FOUND = { ok: false, reason: "That isn't here any more. Reload the page." } as const;
const SIGNED_OUT = { ok: false, reason: "Your session has ended. Sign in again to keep going." } as const;
const CROSS_ORIGIN = { ok: false, reason: "This request didn't come from Staygreen, so it was refused." } as const;

/** The Origin check and the member, or the refusal to return instead. */
async function begin(): Promise<Member | Refusal> {
  try {
    await assertSameOrigin();
  } catch (e) {
    if (e instanceof CrossOrigin) return CROSS_ORIGIN;
    throw e;
  }
  return (await memberOrNull()) ?? SIGNED_OUT;
}

const isMember = (m: Member | Refusal): m is Member => "caller" in m;

/** A thing resolved from its id, in the caller's reach for `permission`. */
function reach(member: Member, resolved: { id: string; workspace: Member["workspace"] } | null, permission: Permission): boolean {
  // The workspace the thing belongs to is the one checked, never the caller's active one;
  // `allowed` compares its organization with the caller's (`authz.ts`).
  return !!resolved && allowed(resolved.workspace, member.caller, permission) && resolved.workspace.id === member.workspace.id;
}

function refused(e: DbError, member: Member, extra: { host?: string | null; type?: string } = {}): Refusal {
  if (isNotFound(e)) return NOT_FOUND;
  return { ok: false, reason: describeDbError(e, { entitlements: member.entitlements, ...extra }) };
}

const fieldErrorsOf = (e: z.ZodError) => {
  const out: Record<string, string> = {};
  for (const issue of e.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
};

// ── apps ────────────────────────────────────────────────────────────────────

const appSchema = z.object({
  name: z.string().trim().min(1, "Give the app a name").max(60, "Names run to 60 characters"),
  url: linkSchema,
});

/** Counted against the plan inside `create_app`, with the workspace locked (`AGENTS.md § 2.8`):
 *  Free includes one app. A workspace already past it keeps its apps and can't add another. */
export async function addApp(input: { name: string; url: string }): Promise<Result<{ id: string }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!allowed(member.workspace, member.caller, "monitors:write")) return NOT_FOUND;
  const parsed = appSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  const { data, error } = await db().rpc("create_app", {
    p_workspace_id: member.workspace.id,
    p_name: parsed.data.name,
    // An empty address is stored as none; the function trims it to null.
    p_url: parsed.data.url,
    p_max_apps: member.entitlements.limits.apps,
  });
  if (error) return refused(error, member);
  return { ok: true, id: data.id };
}

/** An app's name and address, with the rules adding one has. Nothing else follows the address:
 *  its monitors keep checking what they check, and an SSL monitor Staygreen added stays while an
 *  HTTP monitor on its host does (`delete_monitor`, 007). The screen offers the new address's
 *  checks instead (`docs/flows.md § Editing an app`). */
export async function updateApp(appId: string, input: { name: string; url: string }): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolveApp(appId), "monitors:write")) return NOT_FOUND;
  const parsed = appSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  const { data, error } = await db()
    .from("apps")
    .update({ name: parsed.data.name, url: parsed.data.url || null })
    .eq("id", appId)
    .eq("workspace_id", member.workspace.id)
    .select("id");
  if (error) return refused(error, member);
  return data?.length ? { ok: true } : NOT_FOUND;
}

const APP_LOGO_UNPREPARED = "This image wasn't resized for the app. Reload Settings and choose it again.";

/** An app's logo, through the status page images' pipeline: resized in the browser, checked again
 *  here, and only its pixel chunks stored (`storablePageAsset`). With it may come `favicon`, the
 *  same image as a 48 px PNG, which a new status page for the app takes as its favicon (`addPage`);
 *  the browser makes it from the same source, since the server never resizes an image. `keep` is
 *  the import of the app's own icon, which never replaces a logo already there, one the builder
 *  chose included. */
export async function uploadAppLogo(appId: string, form: FormData, opts: { keep?: boolean } = {}): Promise<Result<{ url: string | null }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolveApp(appId), "monitors:write")) return NOT_FOUND;
  const file = form instanceof FormData ? form.get("file") : null;
  if (!(file instanceof Blob) || form.getAll("file").length !== 1 || !file.size) return { ok: false, reason: "Choose an image to upload." };
  const favicon = form.get("favicon");
  if (form.getAll("favicon").length > 1 || (favicon !== null && !(favicon instanceof Blob && favicon.size))) return { ok: false, reason: APP_LOGO_UNPREPARED };
  if (file.size > PAGE_ASSET_LIMIT || (favicon instanceof Blob && favicon.size > PAGE_ASSET_LIMIT)) return { ok: false, reason: APP_LOGO_UNPREPARED };
  const checked = storablePageAsset(new Uint8Array(await file.arrayBuffer()), "app");
  if (!checked.ok) return { ok: false, reason: checked.reason === PAGE_ASSET_UNPREPARED ? APP_LOGO_UNPREPARED : checked.reason };
  const tab = favicon instanceof Blob ? storablePageAsset(new Uint8Array(await favicon.arrayBuffer()), "favicon") : null;
  if (tab && !tab.ok) return { ok: false, reason: APP_LOGO_UNPREPARED };
  const id = `asset_${randomBytes(16).toString("hex")}`;
  const hex = (bytes: Uint8Array) => `\\x${Buffer.from(bytes).toString("hex")}`;
  const { data, error } = await db()
    .from("app_logos")
    .upsert(
      {
        id, workspace_id: member.workspace.id, app_id: appId, mime: checked.mime, content: hex(checked.bytes),
        // A new logo without its copy clears the old copy, so a page never takes another image's favicon.
        favicon_mime: tab?.ok ? tab.mime : null, favicon_content: tab?.ok ? hex(tab.bytes) : null,
      },
      { onConflict: "app_id", ignoreDuplicates: opts.keep === true },
    )
    .select("id");
  if (error) return error.code === "23503" ? NOT_FOUND : refused(error, member);
  return { ok: true, url: data?.length ? assetPath(id) : null };
}

export async function removeAppLogo(appId: string): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolveApp(appId), "monitors:write")) return NOT_FOUND;
  const { error } = await db().from("app_logos").delete().eq("app_id", appId).eq("workspace_id", member.workspace.id);
  return error ? refused(error, member) : { ok: true };
}

/** The app goes with everything under it: its monitors, status pages and incidents. */
export async function deleteApp(appId: string): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  const app = await resolveApp(appId);
  if (!(reach(member, app, "monitors:delete") && reach(member, app, "pages:manage"))) return NOT_FOUND;
  const { error } = await db().rpc("delete_app", { p_workspace_id: member.workspace.id, p_app_id: appId });
  return error ? refused(error, member) : { ok: true };
}

// ── monitors ────────────────────────────────────────────────────────────────

const newMonitorId = () => `mon_${randomBytes(12).toString("hex")}`;

export async function addMonitor(draft: unknown): Promise<Result<{ id: string; heartbeatUrl?: string }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!allowed(member.workspace, member.caller, "monitors:write")) return NOT_FOUND;

  const parsed = parseMonitorDraft(draft);
  if (!parsed.ok) return { ok: false, reason: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors };
  const row = parsed.row;

  if (!(reach(member, await resolveApp(row.appId), "monitors:write"))) {
    return { ok: false, reason: "Pick the app this monitor belongs to.", fieldErrors: { appId: "Pick the app this monitor belongs to" } };
  }
  return createMonitor(member, row);
}

/** A parsed row, in an app already resolved to the member's workspace with `monitors:write`
 *  there: the private-range check, then `create_monitor` with the plan's limits. Adding a monitor
 *  and adding suggested checks both come through here. */
async function createMonitor(member: Member, row: MonitorRow): Promise<Result<{ id: string; heartbeatUrl?: string }>> {
  if (isService(row.type)) return saveServiceMonitor(member, newMonitorId(), row, false);
  // The private-range refusal at create time (`targets.ts`). A DNS monitor asks a public
  // resolver about a name and never connects to it, and a heartbeat reaches no host of yours.
  if (row.targetHost && (row.type === "http" || row.type === "ssl" || row.type === "tcp")) {
    const target = await checkTarget(row.targetHost);
    if (!target.ok) return { ok: false, reason: target.reason, fieldErrors: { [row.type === "http" ? "url" : "host"]: target.reason } };
  }

  const id = newMonitorId();
  const hb = row.type === "heartbeat" ? await newHeartbeat(id) : null;
  const L = member.entitlements.limits;
  const minInterval = L.httpIntervalMin * 60;

  const { error } = await db().rpc("create_monitor", {
    p_workspace_id: member.workspace.id,
    p_id: id,
    p_app_id: row.appId,
    p_type: row.type,
    p_name: row.name,
    p_target: row.target,
    p_target_host: row.targetHost,
    p_interval_sec: row.fixedIntervalSec ?? minInterval,
    p_config: row.config as never,
    p_heartbeat_token_hash: hb?.hash ?? null,
    p_secrets: row.secrets.length
      ? row.secrets.map((s) => ({ name: s.name, sealed: seal(s.value, headerContext(id, s.name)) }))
      : null,
    p_max_monitors: L.monitors,
    p_max_heartbeats: L.heartbeats,
    p_max_assertions: L.assertions,
    p_max_heartbeat_assertions: L.heartbeatAssertions,
    // Builder's per-host allowance is fair use: no number below the monitor cap.
    p_per_host: L.perHost === "fair use" ? L.monitors : L.perHost,
    p_min_interval_sec: minInterval,
    p_heartbeat_token_sealed: hb?.sealed ?? null,
  });
  if (error) return refused(error, member, { host: row.targetHost, type: row.type });
  return hb ? { ok: true, id, heartbeatUrl: hb.url } : { ok: true, id };
}

/** A monitor the builder may edit, as stored: its type, its app and its sealed header values,
 *  read in the member's workspace. An automatic monitor, or a type not live yet, is refused. */
async function storedMonitor(member: Member, monitorId: string): Promise<{ type: string; appId: string; target: string; sealed: Map<string, string> } | Refusal> {
  const ws = member.workspace.id;
  const [{ data: mon, error: monError }, { data: stored, error: storedError }] = await Promise.all([
    db().from("monitors").select("type, app_id, auto, target").eq("id", monitorId).eq("workspace_id", ws).maybeSingle(),
    db().from("monitor_secrets").select("name, sealed").eq("monitor_id", monitorId).eq("workspace_id", ws),
  ]);
  if (monError || storedError) return refused((monError ?? storedError)!, member);
  if (!mon) return NOT_FOUND;
  if (mon.auto || !isCreatable(mon.type)) return refused({ message: mon.auto ? "auto_monitor" : "type_not_available" }, member);
  return { type: mon.type, appId: mon.app_id, target: mon.target, sealed: new Map((stored ?? []).map((s) => [s.name, s.sealed])) };
}

const isRefusal = (x: object): x is Refusal => "ok" in x;

/** A kept secret header goes only to the address it was saved for. Any other address, another
 *  path on the same site included, means typing it again, so nobody who can edit a monitor can
 *  send a secret someone else typed to an address of their choosing, by saving or by testing:
 *  not to their own server, and not to a path of the same site that echoes what it's sent. */
function keptHeaderMoved(row: { type: string; target: string; secrets: readonly { name: string; value: string }[] }, storedTarget: string): Refusal | null {
  if (row.type !== "http" && row.type !== "supabase") return null;
  const address = (url: string) => {
    try {
      return new URL(url).href;
    } catch {
      return null;
    }
  };
  const kept = row.secrets.find((s) => !s.value);
  if (!kept || (address(row.target) !== null && address(row.target) === address(storedTarget))) return null;
  const reason = `Type ${kept.name} again: a kept value is only sent to the address it was saved for.`;
  return { ok: false, reason, fieldErrors: { [row.type === "supabase" ? "key" : "headers"]: reason } };
}

/** Service saves cannot bypass preflight by posting an action directly or reusing a stale
 * browser test. Verification happens after ownership and budget checks, before any write. */
async function saveServiceMonitor(member: Member, id: string, row: MonitorRow, editing: boolean, stored = new Map<string, string>()): Promise<Result<{ id: string }>> {
  const spent = await spendTest(member);
  if (spent) return spent;
  let key = row.secrets[0]?.value ?? "";
  if (!key) {
    try { key = open(stored.get(SERVICE_KEY) ?? "", headerContext(id, SERVICE_KEY)); }
    catch { return { ok: false, reason: "Type the key again; its stored value could not be read.", fieldErrors: { key: "Type the key again." } }; }
  }
  const outcome = await runTest(row, { [SERVICE_KEY]: key }, TEST_DEADLINE_MS);
  if (!("service" in outcome) || !outcome.service.saveable) return { ok: false,
    reason: outcome.failure?.message ?? "Verify every service check before saving.", fieldErrors: { form: outcome.failure?.message ?? "The configuration could not be verified." } };
  const L = member.entitlements.limits;
  const { error } = await db().rpc("save_service_monitor", {
    p_workspace_id: member.workspace.id, p_id: id, p_app_id: row.appId, p_type: row.type,
    p_name: row.name, p_target: row.target, p_config: row.config as never,
    p_sealed: seal(key, headerContext(id, SERVICE_KEY)), p_edit: editing,
    p_max_monitors: L.monitors, p_max_type: row.type === "stripe" ? L.stripeAccounts : L.supabaseMonitors === "cap" ? L.monitors : L.supabaseMonitors,
    p_per_host: L.perHost === "fair use" ? L.monitors : L.perHost,
    p_interval_sec: (row.type === "stripe" ? L.stripePollMin : L.httpIntervalMin) * 60,
  });
  return error ? refused(error, member, { type: row.type }) : { ok: true, id };
}

/** What a monitor checks, changed. Its type, app, heartbeat URL and history stay. */
export async function updateMonitor(monitorId: string, draft: unknown): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolveMonitor(monitorId), "monitors:write"))) return NOT_FOUND;

  const ws = member.workspace.id;
  const mon = await storedMonitor(member, monitorId);
  if (isRefusal(mon)) return mon;

  // The type and the app are the monitor's own, whatever the draft says.
  const sealed = mon.sealed;
  const input = typeof draft === "object" && draft ? draft : {};
  const parsed = parseMonitorDraft({ ...input, type: mon.type, appId: mon.appId }, { storedHeaders: [...sealed.keys()] });
  if (!parsed.ok) return { ok: false, reason: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors };
  const row = parsed.row;
  const moved = keptHeaderMoved(row, mon.target);
  if (moved) return moved;

  if (isService(row.type)) return saveServiceMonitor(member, monitorId, row, true, sealed);

  if (row.targetHost && (row.type === "http" || row.type === "ssl" || row.type === "tcp")) {
    const target = await checkTarget(row.targetHost);
    if (!target.ok) return { ok: false, reason: target.reason, fieldErrors: { [row.type === "http" ? "url" : "host"]: target.reason } };
  }

  const L = member.entitlements.limits;
  const minInterval = L.httpIntervalMin * 60;
  const { error } = await db().rpc("update_monitor", {
    p_workspace_id: ws,
    p_monitor_id: monitorId,
    p_name: row.name,
    p_target: row.target,
    // Null for a heartbeat; the generated types can't say an argument may be null.
    p_target_host: row.targetHost as string,
    p_interval_sec: row.fixedIntervalSec ?? minInterval,
    p_config: row.config as never,
    // A header sent without a value keeps its sealed one: the seal is bound to this id and name.
    p_secrets:
      row.type === "http"
        ? row.secrets.map((s) => ({ name: s.name, sealed: s.value ? seal(s.value, headerContext(monitorId, s.name)) : sealed.get(s.name)! }))
        : null,
    p_max_assertions: L.assertions,
    p_max_heartbeat_assertions: L.heartbeatAssertions,
    p_per_host: L.perHost === "fair use" ? L.monitors : L.perHost,
    p_min_interval_sec: minInterval,
  });
  return error ? refused(error, member, { host: row.targetHost, type: row.type }) : { ok: true };
}

const TESTABLE: readonly string[] = ["http", "ssl", "tcp", "dns", "stripe", "supabase"];

const budgetAnswer = z.object({ ok: z.boolean(), scope: z.enum(["member", "workspace"]).optional(), retryAfterSec: z.number().int().positive().optional() });

/** One check of what the form holds, now, from this server, before it is saved
 *  (`docs/flows.md § Testing a monitor`). The same steps as saving: the member, the monitor
 *  re-resolved with its own workspace when it is being edited, `monitors:write` there, and the
 *  same parser, so a test reaches nothing a save would refuse. Editing, the monitor's own type,
 *  app and kept header values are used, as saving would use them.
 *
 *  It writes one use of the member's and the workspace's budget and nothing else: no state, no
 *  incident, no rollup, no row of its own (`AGENTS.md § 2.8`). Plan limits are a save's
 *  question, so a Builder-only option in the form doesn't stop a test. */
export async function testMonitor(draft: unknown, monitorId: string | null = null): Promise<Result<{ outcome: TestOutcome }>> {
  const started = performance.now();
  const member = await begin();
  if (!isMember(member)) return member;

  let input: object = typeof draft === "object" && draft ? draft : {};
  let sealed = new Map<string, string>();
  let storedTarget: string | null = null;
  if (monitorId !== null) {
    if (!(reach(member, await resolveMonitor(monitorId), "monitors:write"))) return NOT_FOUND;
    const mon = await storedMonitor(member, monitorId);
    if (isRefusal(mon)) return mon;
    sealed = mon.sealed;
    storedTarget = mon.target;
    input = { ...input, type: mon.type, appId: mon.appId };
  } else if (!allowed(member.workspace, member.caller, "monitors:write")) return NOT_FOUND;

  const parsed = parseMonitorDraft(input, { storedHeaders: [...sealed.keys()] });
  if (!parsed.ok) return { ok: false, reason: "Check the highlighted fields.", fieldErrors: parsed.fieldErrors };
  const row = parsed.row;
  const moved = storedTarget === null ? null : keptHeaderMoved(row, storedTarget);
  if (moved) return moved;
  if (!TESTABLE.includes(row.type)) return { ok: false, reason: "A heartbeat has nothing to test: your job calls Staygreen, so its first ping is the test." };
  if (monitorId === null && !(reach(member, await resolveApp(row.appId), "monitors:write"))) {
    return { ok: false, reason: "Pick the app this monitor belongs to.", fieldErrors: { appId: "Pick the app this monitor belongs to" } };
  }

  // A header left empty on the edit screen keeps its stored value. It is opened here, for this
  // monitor and this name only (the seal is bound to both), handed to this one check, and masked
  // out of everything the check returns (`monitor-test.ts`); it is never sent back. On the add
  // screen nothing is stored, so the parser has already refused an empty value.
  const headers: Record<string, string> = {};
  for (const s of row.secrets) {
    if (s.value) {
      headers[s.name] = s.value;
      continue;
    }
    try {
      headers[s.name] = open(sealed.get(s.name) ?? "", headerContext(monitorId ?? "", s.name));
    } catch {
      const reason = `The stored value of ${s.name} can't be read. Type it again to test with it.`;
      return { ok: false, reason, fieldErrors: { [isService(row.type) ? "key" : "headers"]: reason } };
    }
  }

  const spent = await spendTest(member);
  if (spent) return spent;

  // Whatever the reads above took comes out of the check's time, so the whole test ends inside
  // `TEST_DEADLINE_MS` (`monitor-test.ts`).
  const withinMs = TEST_DEADLINE_MS - (performance.now() - started);
  if (withinMs < TEST_MIN_MS) return { ok: false, reason: "Staygreen took too long to get ready for the test. Try again in a moment." };
  return { ok: true, outcome: await runTest(row, headers, withinMs) };
}

/** One use of the member's and the workspace's test budget, or the refusal to return instead
 *  (`spend_budget`, 011). A refusal spends nothing. */
async function spendTest(member: Member): Promise<Refusal | null> {
  const { data, error } = await db().rpc("spend_budget", {
    p_workspace_id: member.workspace.id,
    p_action: "test_check",
    p_user_id: member.caller.userId,
    p_member_limit: TEST_BUDGET.member.limit,
    p_member_window_sec: TEST_BUDGET.member.windowSec,
    p_workspace_limit: TEST_BUDGET.workspace.limit,
    p_workspace_window_sec: TEST_BUDGET.workspace.windowSec,
  });
  if (error) return refused(error, member);
  const budget = budgetAnswer.parse(data);
  return budget.ok ? null : { ok: false, reason: testBudgetSpent(budget.scope ?? "member"), retryAfterSec: budget.retryAfterSec ?? 60 };
}

// ── suggested checks ────────────────────────────────────────────────────────

/** The HTTP draft a suggestion becomes, as the add form would send it with nothing changed. */
const suggestedDraft = (appId: string, url: string, name: string) => ({
  type: "http", appId, name, url, method: "GET", expect: "2xx", keyword: "", slowMs: monitorDefaults.slowMs.http, assertions: [], headers: [],
});

const NO_ADDRESS = { ok: false, reason: "Add the app's address first, and Staygreen will suggest its checks." } as const;

/** The app's address tried once, now, from this server, for the checks it could have
 *  (`docs/flows.md § Suggested checks`): the same member, permission and parser as testing a
 *  monitor, and one use of the same budget, because the run fetches addresses the builder chose
 *  and may make one model call (`architecture.md § Rate limits`, `site-model.ts`). It writes that
 *  use and the brand colour it found, which the app's next status page starts with (`addPage`);
 *  the icon it finds goes back to the browser, which resizes it and stores it with
 *  `uploadAppLogo` like any chosen image. */
export async function suggestChecks(appId: string): Promise<Result<{ suggestions: Suggestions }>> {
  const started = performance.now();
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolveApp(appId), "monitors:write")) return NOT_FOUND;
  const ws = member.workspace.id;
  const [app, logo, watched] = await Promise.all([
    db().from("apps").select("url").eq("id", appId).eq("workspace_id", ws).maybeSingle(),
    db().from("app_logos").select("app_id").eq("app_id", appId).eq("workspace_id", ws).maybeSingle(),
    db().from("monitors").select("type, target, target_host").eq("workspace_id", ws).in("type", ["http", "ssl", "supabase", "dns", "tcp"]),
  ]);
  const failed = app.error ?? logo.error ?? watched.error;
  if (failed) return refused(failed, member);
  if (!app.data) return NOT_FOUND;
  const targets = suggestionTargets(app.data.url ?? "");
  if (!targets) return NO_ADDRESS;
  // The parser refuses a literal private address or a local name before anything is spent.
  const parsed = parseMonitorDraft(suggestedDraft(appId, targets.address, rootName(targets.address)));
  if (!parsed.ok) return { ok: false, reason: parsed.fieldErrors.url ?? "Check the app's address in Settings." };

  const spent = await spendTest(member);
  if (spent) return spent;
  const withinMs = TEST_DEADLINE_MS - (performance.now() - started);
  if (withinMs < TEST_MIN_MS) return { ok: false, reason: "Staygreen took too long to get ready for the checks. Try again in a moment." };
  const found = await runSuggestions(targets.address, withinMs, !logo.data, {}, { model: siteModelFromEnv(), maxAssertions: member.entitlements.limits.assertions });
  if (!found) return NO_ADDRESS;
  // A colour found replaces the last one found: it is what the site says now, and only a page
  // made from here on reads it. A run that found none leaves the last one, since the same site
  // read again at a worse moment says nothing new. Best effort, like the icon: a write that fails
  // costs the next page its colour and nothing else.
  if (found.accent) await db().from("apps").update({ accent: found.accent }).eq("id", appId).eq("workspace_id", ws);

  const targetsWatched = new Set((watched.data ?? []).filter((m) => m.type === "http").map((m) => m.target));
  const projectsWatched = new Set((watched.data ?? []).filter(m => m.type === "supabase").map(m => m.target));
  const hostsWatched = new Set((watched.data ?? []).filter((m) => m.type === "ssl").map((m) => m.target_host));
  return {
    ok: true,
    suggestions: {
      ...found,
      http: found.http.map((h) => {
        const project = supabaseCheckOf(h.url);
        const watched = project ? projectsWatched.has(`https://${project.ref}.supabase.co`) : targetsWatched.has(h.url);
        return watched ? { ...h, watched: true } : h;
      }),
      ssl: found.ssl && hostsWatched.has(found.ssl.host) ? { ...found.ssl, watched: true } : found.ssl,
      ...(found.dns ? { dns: found.dns.map(d => (watched.data ?? []).some(m => m.type === "dns" && m.target === `${d.record} ${d.recordName}`) ? { ...d, watched: true } : d) } : {}),
      ...(found.tcp ? { tcp: found.tcp.map(t => (watched.data ?? []).some(m => m.type === "tcp" && m.target === `${t.host}:${t.port}`) ? { ...t, watched: true } : t) } : {}),
    },
  };
}

const picksSchema = z.object({
  // Four app entry/final origins can contribute 60 health routes, plus API/dependencies.
  urls: z.array(z.string().max(2048)).max(80),
  ssl: z.boolean(),
  // Each list is checked again as a monitor's assertions are (`parseMonitorDraft`), and against
  // the plan's number by `create_monitor`.
  assertions: z.record(z.string().max(2048), z.array(z.object({ path: z.string(), op: z.string(), value: z.string() })).max(10)).optional(),
  supabaseKey: z.string().max(2000).optional(),
  dependencies: z.array(z.object({ url: z.string().max(2048), name: z.string().trim().min(1).max(80), keyword: z.string().max(200) }).strict()).max(6).optional(),
  http: z.array(z.object({ url: z.string().max(2048), name: z.string().trim().min(1).max(80), expect: z.enum(["401", "404"]).optional() }).strict()).max(80).optional(),
  tcp: z.array(z.object({ host: z.string().max(253), port: z.union([z.literal(587), z.literal(465), z.literal(2525)]), tls: z.boolean() }).strict()).max(1).optional(),
  dns: z.array(z.object({ record: z.enum(["CNAME", "NS"]), recordName: z.string().max(253), expected: z.string().min(1).max(500), name: z.string().max(80) }).strict()).max(7).optional(),
});

/** The ticked suggestions, each added as the add form adds a monitor, with the plan's limits:
 *  an HTTP check counts toward the monitors, and the SSL check that comes with an HTTPS one
 *  doesn't (`create_monitor`). Ticked without one, the SSL check is a monitor of its own.
 *  Derived health routes, dependency HTTP checks and same-domain DNS baselines use the same
 *  parser and create transaction as the add form. Supabase health routes collapse into one
 *  dedicated monitor; an already watched target is not added twice. A limit reached part way
 *  keeps what was added and says what stopped the rest.
 *
 *  A Supabase check, like a dependency, may be on another host named by the page. The
 *  browser can send any project, which is no more than the add form lets a member add, so what
 *  is held here is its shape: one project, its Auth health and Storage status, and a public-key
 *  shape (`isPublishableKey`). The service preflight verifies it against the project before
 *  sealing it. Existing HTTP monitors are left alone: changing their type would discard their
 *  configured assertions and history. A secret key is refused, never stored. The assertions a check
 *  carries are the builder's to send, like the add form's, and parsed the same way. */
export async function addSuggestedChecks(appId: string, input: unknown): Promise<Result<{ added: number; stopped?: string }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolveApp(appId), "monitors:write")) return NOT_FOUND;
  const picks = picksSchema.safeParse(input);
  if (!picks.success) return { ok: false, reason: "Tick the checks to add." };
  const ws = member.workspace.id;
  const [app, watched] = await Promise.all([
    db().from("apps").select("url").eq("id", appId).eq("workspace_id", ws).maybeSingle(),
    db().from("monitors").select("type, target, target_host").eq("workspace_id", ws).in("type", ["http", "ssl", "supabase", "dns", "tcp"]),
  ]);
  const failed = app.error ?? watched.error;
  if (failed) return refused(failed, member);
  if (!app.data) return NOT_FOUND;
  const targets = suggestionTargets(app.data.url ?? "");
  if (!targets) return NO_ADDRESS;
  const names = new Map<string, string>([[targets.address, rootName(targets.address)], ...targets.health.map((h) => [h.url, h.name] as [string, string])]);
  // Like the normal add form, a member may choose an external public HTTP target and
  // keyword. These are proposals, not authorization: the parser, target guard and create
  // transaction below still enforce permissions and quotas. No public scan can save one.
  const dependencies = new Map((picks.data.dependencies ?? []).map(d => [d.url, d]));
  for (const d of dependencies.values()) names.set(d.url, d.name);
  // Discovered redirects can leave the original domain. As with dependency picks/the add
  // form, these authenticated proposals still pass the parser, address guard and quota RPC.
  const http = new Map((picks.data.http ?? []).map(h => [h.url, h]));
  for (const h of http.values()) names.set(h.url, h.name);
  const appHost = new URL(targets.address).hostname;
  const tcp = picks.data.tcp ?? [];
  const domain = registrableDomain(appHost);
  if (tcp.some(t => !domain || t.host !== `smtp.${domain}` || t.tls !== (t.port === 465))) return { ok: false, reason: "These SMTP checks are for another address or port. Reload the page." };
  const dns = picks.data.dns ?? [];
  if (dns.some(d => d.record === "NS" ? d.recordName !== registrableDomain(appHost) : !sameDomain(d.recordName, appHost) || d.recordName === appHost)) return { ok: false, reason: "These DNS checks are for another domain. Reload the page." };
  const supabase = picks.data.urls.map(supabaseCheckOf).filter((c) => c !== null);
  if (new Set(supabase.map((c) => c.ref)).size > 1) return { ok: false, reason: "These checks are for another address. Reload the page." };
  for (const u of picks.data.urls) {
    const c = supabaseCheckOf(u);
    if (c) names.set(u, SUPABASE_NAMES[c.service]);
  }
  if (picks.data.urls.some((u) => !names.has(u))) return { ok: false, reason: "These checks are for another address. Reload the page." };
  const key = picks.data.supabaseKey;
  const auth = supabase[0];
  if (auth && !(key && isPublishableKey(key, auth.ref))) return { ok: false, reason: "This Supabase check needs the project's publishable key. Reload the page." };
  const urls = [...names.keys()].filter((u) => picks.data.urls.includes(u));
  if (!urls.length && !picks.data.ssl && !dns.length && !tcp.length) return { ok: false, reason: "Tick at least one check to add." };

  const has = new Set((watched.data ?? []).filter((m) => m.type === "http").map((m) => m.target));
  const projects = new Set((watched.data ?? []).filter((m) => m.type === "supabase").map(m => m.target));
  const sslWatched = (watched.data ?? []).some((m) => m.type === "ssl" && m.target_host === targets.sslHost);
  let added = 0;
  const stop = (r: Refusal): Result<{ added: number; stopped?: string }> => (added ? { ok: true, added, stopped: r.reason } : r);
  const add = async (draft: object): Promise<Refusal | null> => {
    const parsed = parseMonitorDraft(draft);
    if (!parsed.ok) return { ok: false, reason: Object.values(parsed.fieldErrors)[0] ?? "Check the app's address in Settings." };
    const r = await createMonitor(member, parsed.row);
    return r.ok ? null : r;
  };
  for (const url of urls) {
    const project = supabaseCheckOf(url);
    if (project) {
      const projectUrl = `https://${project.ref}.supabase.co`;
      if (projects.has(projectUrl)) continue;
      const r = await add({ type: "supabase", appId, name: "Supabase project", projectUrl, key, databaseRead: "" });
      if (r) return stop(r);
      projects.add(projectUrl);
      added++;
      continue;
    }
    if (has.has(url)) continue;
    const r = await add({
      ...suggestedDraft(appId, url, names.get(url)!),
      keyword: dependencies.get(url)?.keyword ?? "",
      expect: http.get(url)?.expect ?? "2xx",
      assertions: picks.data.assertions?.[url] ?? [],
      headers: [],
    });
    if (r) return stop(r);
    has.add(url);
    added++;
  }
  for (const t of tcp) {
    if ((watched.data ?? []).some(m => m.type === "tcp" && m.target === `${t.host}:${t.port}`)) continue;
    const r = await add({ type: "tcp", appId, name: "SMTP", ...t });
    if (r) return stop(r);
    added++;
  }
  const dnsWatched = new Set((watched.data ?? []).filter(m => m.type === "dns").map(m => m.target));
  for (const d of dns) {
    const target = `${d.record} ${d.recordName}`;
    if (dnsWatched.has(target)) continue;
    const r = await add({ type: "dns", appId, ...d });
    if (r) return stop(r);
    dnsWatched.add(target); added++;
  }
  // Ticked with an HTTPS check on its host, the SSL check came with that check, as it always does.
  if (picks.data.ssl && targets.sslHost && !sslWatched) {
    if (!sslComesWith(urls, targets.sslHost)) {
      const r = await add({ type: "ssl", appId, name: "", host: targets.sslHost });
      if (r) return stop(r);
    }
    added++;
  }
  return { ok: true, added };
}

export async function deleteMonitor(monitorId: string): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolveMonitor(monitorId), "monitors:delete"))) return NOT_FOUND;
  const { error } = await db().rpc("delete_monitor", { p_workspace_id: member.workspace.id, p_monitor_id: monitorId });
  return error ? refused(error, member) : { ok: true };
}

const pauseSchema = z.union([z.literal(60), z.literal(1440), z.null()]);

export async function pauseMonitor(monitorId: string, minutes: number | null): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolveMonitor(monitorId), "monitors:write"))) return NOT_FOUND;
  const window = pauseSchema.safeParse(minutes);
  if (!window.success) return { ok: false, reason: "Pause for an hour, a day, or until you resume it." };
  const { error } = await db().rpc("pause_monitor", {
    p_workspace_id: member.workspace.id,
    p_monitor_id: monitorId,
    p_minutes: window.data,
    p_reason: "",
  });
  return error ? refused(error, member) : { ok: true };
}

export async function resumeMonitor(monitorId: string): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolveMonitor(monitorId), "monitors:write"))) return NOT_FOUND;
  const { error } = await db().rpc("resume_monitor", { p_workspace_id: member.workspace.id, p_monitor_id: monitorId });
  return error ? refused(error, member) : { ok: true };
}

/** A new heartbeat URL. The old one stops being accepted the moment this returns. The hash and
 *  the sealed copy change in one statement, so the page never shows a URL the receiver refuses. */
export async function rotateHeartbeat(monitorId: string): Promise<Result<{ heartbeatUrl: string }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolveMonitor(monitorId), "monitors:write"))) return NOT_FOUND;
  const hb = await newHeartbeat(monitorId);
  const { data, error } = await db()
    .from("monitors")
    .update({ heartbeat_token_hash: hb.hash, heartbeat_token_sealed: hb.sealed, updated_at: new Date().toISOString() })
    .eq("id", monitorId)
    .eq("workspace_id", member.workspace.id)
    .eq("type", "heartbeat")
    .select("id");
  if (error) return refused(error, member);
  if (!data?.length) return NOT_FOUND;
  return { ok: true, heartbeatUrl: hb.url };
}

// ── incidents ───────────────────────────────────────────────────────────────

/** Acknowledging is incident work, not publishing: the draft permission gates it. */
export async function ackIncident(incidentId: string): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolveIncident(incidentId), "incidents:draft"))) return NOT_FOUND;
  const { error } = await db().rpc("ack_incident", { p_workspace_id: member.workspace.id, p_incident_id: incidentId, p_via: "the dashboard" });
  return error ? refused(error, member) : { ok: true };
}

const noteSchema = z.object({
  noteId: z.string().regex(/^note_[0-9a-f]{24}$/).nullable(),
  state: z.enum(NOTE_STATES),
  text: z.string().trim().min(1, "Write what you know so far").max(5000, "Updates run to 5,000 characters"),
  publish: z.boolean(),
});

export async function saveNote(incidentId: string, input: z.input<typeof noteSchema>): Promise<Result<{ id: string }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  const parsed = noteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  // Publishing puts words on a public page; drafting doesn't (`docs/permissions.md`).
  const permission: Permission = parsed.data.publish ? "incidents:publish" : "incidents:draft";
  if (!(reach(member, await resolveIncident(incidentId), permission))) return NOT_FOUND;
  const { data, error } = await db().rpc("save_incident_note", {
    p_workspace_id: member.workspace.id,
    p_incident_id: incidentId,
    p_note_id: parsed.data.noteId,
    p_state: parsed.data.state,
    p_body: parsed.data.text,
    p_publish: parsed.data.publish,
    p_author_user_id: member.caller.userId,
    p_author_client: null,
  });
  if (error) return refused(error, member);
  return { ok: true, id: data.id };
}

/** Only a draft can be deleted: a published update stays on the record. */
export async function deleteNote(incidentId: string, noteId: string): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolveIncident(incidentId), "incidents:draft"))) return NOT_FOUND;
  const { data, error } = await db()
    .from("incident_notes")
    .delete()
    .eq("id", noteId)
    .eq("incident_id", incidentId)
    .eq("workspace_id", member.workspace.id)
    .eq("status", "draft")
    .select("id");
  if (error) return refused(error, member);
  return data?.length ? { ok: true } : NOT_FOUND;
}

// ── status pages ────────────────────────────────────────────────────────────

/** Images save immediately, independently of the editor's text draft. The row's new random
 * id and bytes replace its old ones atomically; a failed upload leaves the old image intact.
 * What arrives should be the picker's resized image; whoever sent it, only an image the
 * picker could have made is taken, and only its pixel chunks are stored (`storablePageAsset`). */
export async function uploadPageAsset(pageId: string, kind: unknown, form: FormData): Promise<Result<{ url: string }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolvePage(pageId), "pages:manage")) return NOT_FOUND;
  const slot = pageAssetKind.safeParse(kind);
  if (!slot.success) return { ok: false, reason: "Choose a logo or a favicon." };
  const file = form instanceof FormData ? form.get("file") : null;
  if (!(file instanceof Blob) || form.getAll("file").length !== 1 || !file.size) return { ok: false, reason: "Choose an image to upload." };
  if (file.size > PAGE_ASSET_LIMIT) return { ok: false, reason: PAGE_ASSET_UNPREPARED };
  const checked = storablePageAsset(new Uint8Array(await file.arrayBuffer()), slot.data);
  if (!checked.ok) return checked;
  const id = `asset_${randomBytes(16).toString("hex")}`;
  const { error } = await db().from("page_assets").upsert({
    id, workspace_id: member.workspace.id, page_id: pageId, kind: slot.data,
    mime: checked.mime, content: `\\x${Buffer.from(checked.bytes).toString("hex")}`,
  }, { onConflict: "page_id,kind" });
  if (error) return error.code === "23503" ? NOT_FOUND : refused(error, member);
  return { ok: true, url: assetPath(id) };
}

export async function removePageAsset(pageId: string, kind: unknown): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolvePage(pageId), "pages:manage")) return NOT_FOUND;
  const slot = pageAssetKind.safeParse(kind);
  if (!slot.success) return { ok: false, reason: "Choose a logo or a favicon." };
  const { error } = await db().from("page_assets").delete()
    .eq("page_id", pageId).eq("workspace_id", member.workspace.id).eq("kind", slot.data);
  return error ? refused(error, member) : { ok: true };
}

/** A new status page for an app, made from what the app already has: its name, its address as
 *  the homepage, one component per HTTP monitor, the brand colour its site was found to use as
 *  the accent, and its logo as the page's header logo and favicon (`docs/flows.md § A status page,
 *  and what visitors see`). Each is the builder's to change in the editor. The images are the
 *  app's stored bytes copied as they are: the logo is a 96 px square, inside a header logo's box,
 *  and the favicon the 48 px PNG the browser made beside it (`uploadAppLogo`); a logo stored
 *  before it had one gives the page no favicon, and the tab falls back to the logo (`faviconOf`).
 *  Only the page is required: an accent or an image that doesn't copy leaves the page as it would
 *  have been without it. */
export async function addPage(appId: string): Promise<Result<{ id: string }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolveApp(appId), "pages:manage"))) return NOT_FOUND;
  const q = db();
  const ws = member.workspace.id;
  const [{ data: app, error: appError }, { data: logo }] = await Promise.all([
    q.from("apps").select("id, name, url, accent").eq("id", appId).single(),
    q.from("app_logos").select("mime, content, favicon_mime, favicon_content").eq("app_id", appId).eq("workspace_id", ws).maybeSingle(),
  ]);
  if (appError) return refused(appError, member);

  // Slugs are global, so a taken one gets a short random tail; a reserved one too.
  const base = pageSlugBase(app.name);
  let created: { id: string } | null = null;
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    const { data, error } = await q.rpc("create_status_page", {
      p_workspace_id: member.workspace.id,
      p_app_id: appId,
      p_slug: slug,
      p_name: `${app.name} status`.slice(0, 80),
      p_logo_text: app.name.slice(0, 40),
      p_homepage: app.url,
      p_max_pages: member.entitlements.limits.statusPages,
    });
    if (!error) created = { id: data.id };
    else if (!(error.code === "23505" && /status_pages_slug_key/.test(error.message ?? "")) && !(error.code === "23514" && /status_pages_(edge_)?slug_check/.test(error.message ?? ""))) {
      return refused(error, member);
    }
  }
  if (!created) return { ok: false, reason: "Couldn't find a free address for this page. Try again." };

  if (app.accent) await q.from("status_pages").update({ accent: app.accent }).eq("id", created.id).eq("workspace_id", ws);
  if (logo) {
    const asset = (kind: "logo" | "favicon", mime: string, content: string) => ({ id: `asset_${randomBytes(16).toString("hex")}`, workspace_id: ws, page_id: created.id, kind, mime, content });
    const assets = [asset("logo", logo.mime, logo.content), ...(logo.favicon_mime && logo.favicon_content ? [asset("favicon", logo.favicon_mime, logo.favicon_content)] : [])];
    await q.from("page_assets").upsert(assets, { onConflict: "page_id,kind", ignoreDuplicates: true });
  }

  // One component per HTTP monitor of the app, so the page has something to show.
  const { data: monitors } = await q
    .from("monitors")
    .select("id, name")
    .eq("workspace_id", member.workspace.id)
    .eq("app_id", appId)
    .eq("type", "http")
    .order("created_at")
    .limit(50);
  if (monitors?.length) {
    const { data: page } = await q.from("status_pages").select("*").eq("id", created.id).single();
    if (page) {
      await q.rpc("save_status_page", {
        p_workspace_id: member.workspace.id,
        p_page_id: page.id,
        p_slug: page.slug,
        p_name: page.name,
        p_logo_text: page.logo_text,
        p_homepage: page.homepage,
        p_accent: page.accent,
        p_theme: page.theme,
        p_powered_by: page.powered_by,
        p_noindex: page.noindex,
        p_history_days: page.history_days,
        p_components: monitors.map((m) => ({ name: m.name, inApp: false, monitorIds: [m.id] })),
        p_white_label: holds(member.entitlements, "white_label"),
        p_private_pages: holds(member.entitlements, "private_pages"),
      });
    }
  }
  return { ok: true, id: created.id };
}

export async function savePage(pageId: string, input: unknown): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolvePage(pageId), "pages:manage"))) return NOT_FOUND;
  const parsed = pageDraftSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the highlighted fields.", fieldErrors: fieldErrorsOf(parsed.error) };
  const p = parsed.data;
  if (member.entitlements.demo && p.demo && p.membersOnly) return { ok: false,
    reason: "A demo page must be public. Turn off Demo page before making it members-only.",
    fieldErrors: { demo: "A demo page must be public." } };
  // Without the feature, its choice takes the plan's default rather than refusing the save: a page
  // set up under Builder stays editable after it, and its next save puts the mark back.
  const whiteLabel = holds(member.entitlements, "white_label");
  const privatePages = holds(member.entitlements, "private_pages");
  let withdrawal: number | null = null;
  if (p.membersOnly) {
    const retired = await db().rpc("begin_private_page", { p_workspace_id: member.workspace.id, p_page_id: pageId, p_private_pages: privatePages });
    if (retired.error) return refused(retired.error, member);
    if (retired.data) {
      const ticket = z.object({ pageId: z.string().min(1).max(128), slug: z.string(), version: z.number().int() }).parse(retired.data);
      if (!(await withdrawAtEdge(ticket.pageId, ticket.slug, ticket.version))) return { ok: false, reason: "The public copy is being withdrawn. Private changes were not saved. Try saving again once the status service is available." };
      withdrawal = ticket.version;
    }
  }
  // The type generator marks every SQL argument non-null; 029's function takes null for no
  // homepage and for a save that withdraws nothing.
  const { error } = await db().rpc("save_demo_page", {
    p_workspace_id: member.workspace.id,
    p_page_id: pageId,
    p_slug: p.slug,
    p_name: p.name,
    p_logo_text: p.logoText,
    p_homepage: (p.homepage || null) as string,
    p_accent: p.accent,
    p_theme: p.theme,
    p_powered_by: whiteLabel ? p.poweredBy : true,
    p_noindex: privatePages ? p.noindex : false,
    p_history_days: p.historyDays,
    p_components: p.components,
    // The features come from the session; the function refuses what they don't unlock.
    p_white_label: whiteLabel,
    p_private_pages: privatePages,
    p_members_only: p.membersOnly ?? false,
    p_withdrawal_version: withdrawal as number,
    p_demo: (member.entitlements.demo ? (p.demo ?? false) : null) as unknown as boolean,
  });
  return error ? refused(error, member) : { ok: true };
}

export async function deletePage(pageId: string): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!(reach(member, await resolvePage(pageId), "pages:manage"))) return NOT_FOUND;
  const { data, error } = await db().from("status_pages").delete().eq("id", pageId).eq("workspace_id", member.workspace.id).select("id");
  if (error) return refused(error, member);
  return data?.length ? { ok: true } : NOT_FOUND;
}

/** A separate bounded surface: up to three editor tabs may poll every 30 seconds. */
async function domainBudget(member: Member): Promise<Refusal | null> {
  const { data, error } = await db().rpc("spend_budget", { p_workspace_id: member.workspace.id,
    p_user_id: member.caller.userId, p_action: "domain_check", p_member_limit: 6,
    p_member_window_sec: 60, p_workspace_limit: 30, p_workspace_window_sec: 60 });
  if (error) return refused(error, member);
  const result = z.object({ ok: z.boolean(), retryAfterSec: z.number().optional() }).parse(data);
  return result.ok ? null : { ok: false, reason: "Wait a moment before checking DNS again.", retryAfterSec: result.retryAfterSec };
}

export async function reservePageDomain(pageId: string, input: unknown): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolvePage(pageId), "pages:manage")) return NOT_FOUND;
  const host = domainSchema.safeParse(input);
  if (!host.success) return { ok: false, reason: host.error.issues[0].message };
  const budget = await domainBudget(member); if (budget) return budget;
  const { error } = await db().rpc("reserve_page_domain", { p_workspace_id: member.workspace.id, p_page_id: pageId, p_host: host.data,
    p_cname_target: `${randomBytes(16).toString("hex")}.${env().STATUS_DOMAIN_SUFFIX}` });
  if (error?.code === "23505") return { ok: false, reason: "That domain is already attached to a page." };
  if (error?.message === "pending_domain_limit") return { ok: false, reason: "This workspace already has three domains waiting for DNS. Finish or remove one first." };
  if (error?.message === "domain_exists") return { ok: false, reason: "Remove this page's current domain before adding another." };
  return error ? refused(error, member) : { ok: true };
}

export async function verifyPageDomain(pageId: string): Promise<Result<{ verified: boolean }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolvePage(pageId), "pages:manage") || !allowed(member.workspace, member.caller, "monitors:write")) return NOT_FOUND;
  const budget = await domainBudget(member); if (budget) return budget;
  const { data: domain, error } = await db().from("page_domains").select("host,cname_target,created_at,verified_at,monitor_id")
    .eq("page_id", pageId).eq("workspace_id", member.workspace.id).maybeSingle();
  if (error) return refused(error, member);
  if (!domain) return NOT_FOUND;
  if (domain.verified_at && domain.monitor_id) return { ok: true, verified: true };
  if (Date.parse(domain.created_at) <= Date.now() - 7 * 86_400_000) return { ok: false, reason: "This pending domain expired after seven days. Remove it and add it again." };
  // Queries public DNS, never the supplied host's HTTP endpoint; a private answer cannot be SSRF.
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  let records: string[];
  try { records = await resolver.resolveCname(domain.host); }
  catch { return { ok: true, verified: false }; }
  if (!matchesCname(records, domain.cname_target)) return { ok: true, verified: false };
  const limits = member.entitlements.limits;
  const result = await db().rpc("verify_page_domain", { p_workspace_id: member.workspace.id, p_page_id: pageId,
    p_host: domain.host, p_created_at: domain.created_at, p_cname_target: domain.cname_target, p_max_monitors: limits.monitors,
    p_max_per_host: typeof limits.perHost === "number" ? limits.perHost : limits.monitors });
  return result.error ? refused(result.error, member) : { ok: true, verified: result.data === true };
}

/** Whether a verified domain already answers with its own certificate. The card asks until it does,
 *  so the owner sees the certificate step finish rather than inferring it. */
export async function checkPageDomain(pageId: string): Promise<Result<{ live: boolean }>> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolvePage(pageId), "pages:manage")) return NOT_FOUND;
  const budget = await domainBudget(member); if (budget) return budget;
  const { data: domain, error } = await db().from("page_domains").select("host,cname_target,verified_at")
    .eq("page_id", pageId).eq("workspace_id", member.workspace.id).maybeSingle();
  if (error) return refused(error, member);
  if (!domain?.verified_at) return NOT_FOUND;
  return { ok: true, live: await servesOverTls(domain.host, domain.cname_target) };
}

export async function removePageDomain(pageId: string): Promise<Result> {
  const member = await begin();
  if (!isMember(member)) return member;
  if (!reach(member, await resolvePage(pageId), "pages:manage")) return NOT_FOUND;
  // The CNAME monitor is kept: removing a domain must not silently remove its monitoring history.
  const { error } = await db().from("page_domains").delete().eq("page_id", pageId).eq("workspace_id", member.workspace.id);
  return error ? refused(error, member) : { ok: true };
}
