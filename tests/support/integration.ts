import { randomBytes } from "node:crypto";
import { createClient, type PostgrestError, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect } from "vitest";
import { limits } from "@/lib/plans";

/* What every integration file shares (`docs/TESTS.md`, the Integration and
   Schema catalog rows).

   The one target. The development project is the only database these files may
   touch, so its ref is written here and every file asserts it before anything
   else: a URL that names any other project fails the file at collection, before
   a client exists. A missing URL or key skips the file and says why; it never
   passes silently (`§ Rules that came from bugs`).

   No key is ever printed: the guard names the variable, never its value. */

export const DEV_REF = "xxxxxxxxxxxxxxxxxxxx";

/** The ref a Supabase URL names, or null when it is not one. */
export function refOf(url: string): string | null {
  const m = /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

export type Target = { url: string; ref: string; secretKey: string; publishableKey: string | null };

/** Reads the target from `.env` (loaded by `tests/support/load-env.ts`).
 *  Returns the reason to skip when something is missing; throws when the URL names
 *  any project but the development one. */
export function readTarget(needs: { publishableKey?: boolean } = {}): Target | { skip: string } {
  const url = process.env.SUPABASE_URL?.trim() ?? "";
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim() ?? "";
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || null;
  if (!url) return { skip: "SUPABASE_URL is not set" };
  // Asserted before the key check, so a wrong target fails even on a machine without the key.
  if (!url.includes(DEV_REF) || refOf(url) !== DEV_REF) {
    throw new Error(`SUPABASE_URL does not name the development project ${DEV_REF}; integration tests refuse to run against anything else`);
  }
  if (!secretKey) return { skip: "SUPABASE_SECRET_KEY is not set" };
  if (needs.publishableKey && !publishableKey) return { skip: "SUPABASE_PUBLISHABLE_KEY is not set" };
  return { url, ref: DEV_REF, secretKey, publishableKey };
}

/** `describe`, or a loud skip naming the missing variable. */
export function describeTarget(name: string, target: Target | { skip: string }, body: (t: Target) => void): void {
  if ("skip" in target) {
    console.warn(`[integration] SKIPPED "${name}": ${target.skip}. Nothing in this file reached the database.`);
    describe.skip(name, () => {});
    return;
  }
  describe(name, () => body(target));
}

/** supabase-js builds a Realtime client even when nothing subscribes, and on Node 20 there is
 *  no global WebSocket (`docs/integrations.md § Supabase › Gotchas`). The same stand-in as
 *  `src/lib/db.ts`: construction works, a subscribe would throw. */
class NoRealtime {
  constructor() {
    throw new Error("the integration suite never subscribes to Realtime");
  }
}

export function clientFor(url: string, key: string): SupabaseClient {
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: NoRealtime as never },
  });
}

export const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A fake Clerk org id the `workspaces_clerk_org_id_check` accepts (`^org_[A-Za-z0-9]+$`,
 *  so no second underscore), obviously a test's. */
export const testOrgId = () => `org_itest${hex(8)}`;
export const testUserId = () => `user_itest${hex(8)}`;
export const testSlug = () => `itest-${hex(6)}`;
/** A heartbeat token hash: the shape `monitors_heartbeat_token_hash_check` accepts. */
export const testTokenHash = () => hex(32);
/** A sealed ping URL's shape, `monitors_heartbeat_sealed` (`credentials.ts`); it opens under no key. */
export const testSealed = () => `v1.${randomBytes(12).toString("base64url")}.${randomBytes(64).toString("base64url")}`;

/** The three facts a refusal through PostgREST is judged on, together
 *  (`docs/TESTS.md`: status, SQLSTATE and message). */
export function refusalOf(res: { status: number; error: PostgrestError | null }): { status: number; code: string | undefined; message: string | undefined } {
  return { status: res.status, code: res.error?.code, message: res.error?.message };
}

export function expectRefused(
  res: { status: number; error: PostgrestError | null; data: unknown },
  expected: { status: number; code: string; message: string },
): void {
  expect(refusalOf(res)).toEqual(expected);
  expect(res.data).toBeNull();
}

/** A call that succeeded: 200 with its row, or 204 for a function returning void. */
export function expectOk<T>(res: { status: number; error: PostgrestError | null; data: T }, status: 200 | 204 = 200): T {
  expect(refusalOf(res)).toEqual({ status, code: undefined, message: undefined });
  return res.data;
}

export const NOT_FOUND = { status: 404, code: "PT404", message: "not_found" } as const;
export const LIMITS_REQUIRED = { status: 400, code: "22004", message: "limits_required" } as const;
export const raised = (message: string) => ({ status: 400, code: "P0001", message }) as const;
/** A foreign-key refusal: PostgREST answers 23503 with a 409 and Postgres's own sentence. */
export const fkViolation = (table: string, constraint: string) =>
  ({ status: 409, code: "23503", message: `insert or update on table "${table}" violates foreign key constraint "${constraint}"` }) as const;
export const uniqueViolation = (constraint: string) =>
  ({ status: 409, code: "23505", message: `duplicate key value violates unique constraint "${constraint}"` }) as const;
export const checkViolation = (table: string, constraint: string) =>
  ({ status: 400, code: "23514", message: `new row for relation "${table}" violates check constraint "${constraint}"` }) as const;

type PlanLimits = (typeof limits)["free"];

/** `create_monitor`'s limit arguments, as `addMonitor` derives them from a plan (`actions.ts`). */
export function monitorLimitArgs(L: PlanLimits) {
  return {
    p_max_monitors: L.monitors,
    p_max_heartbeats: L.heartbeats,
    p_max_assertions: L.assertions,
    p_max_heartbeat_assertions: L.heartbeatAssertions,
    p_per_host: L.perHost === "fair use" ? L.monitors : L.perHost,
    p_min_interval_sec: L.httpIntervalMin * 60,
  };
}

export type MonitorArgs = {
  p_workspace_id: string;
  p_id: string | null;
  p_app_id: string;
  p_type: string;
  p_name: string;
  p_target: string;
  p_target_host: string | null;
  p_interval_sec: number;
  p_config: Record<string, unknown>;
  p_heartbeat_token_hash: string | null;
  p_heartbeat_token_sealed?: string | null;
  p_secrets: unknown[] | null;
} & ReturnType<typeof monitorLimitArgs>;

/** A DNS monitor: no host, so neither the per-host cap nor the automatic SSL monitor applies. */
export function dnsMonitor(workspaceId: string, appId: string, L: PlanLimits = limits.free, over: Partial<MonitorArgs> = {}): MonitorArgs {
  return {
    p_workspace_id: workspaceId,
    p_id: null,
    p_app_id: appId,
    p_type: "dns",
    p_name: `itest dns ${hex(3)}`,
    p_target: "example.com",
    p_target_host: null,
    p_interval_sec: 600,
    p_config: { record: "A", name: "example.com", expected: "" },
    p_heartbeat_token_hash: null,
    p_secrets: null,
    ...monitorLimitArgs(L),
    ...over,
  };
}

export function httpMonitor(workspaceId: string, appId: string, host: string, L: PlanLimits = limits.free, over: Partial<MonitorArgs> = {}): MonitorArgs {
  return {
    ...dnsMonitor(workspaceId, appId, L),
    p_type: "http",
    p_name: `itest http ${hex(3)}`,
    p_target: `https://${host}/health`,
    p_target_host: host,
    p_interval_sec: L.httpIntervalMin * 60,
    p_config: { method: "GET", expect: "2xx", assertions: [] },
    ...over,
  };
}

export function heartbeatMonitor(workspaceId: string, appId: string, L: PlanLimits = limits.free, over: Partial<MonitorArgs> = {}): MonitorArgs {
  return {
    ...dnsMonitor(workspaceId, appId, L),
    p_type: "heartbeat",
    p_name: `itest heartbeat ${hex(3)}`,
    p_target: "https://in.staygreen.io/itest",
    p_target_host: null,
    p_interval_sec: 3600,
    p_config: { schedule: "0 6 * * *", tz: "UTC", graceMin: 10, assertions: [] },
    p_heartbeat_token_hash: testTokenHash(),
    p_heartbeat_token_sealed: testSealed(),
    ...over,
  };
}

/** `save_status_page`'s arguments for a page row, with its components replaced. */
export function savePageArgs(
  page: { id: string; workspace_id: string; slug: string; name: string; logo_text: string; homepage: string | null; accent: string; theme: string; powered_by: boolean; noindex: boolean; history_days: number },
  components: { name: string; inApp?: boolean; monitorIds: string[] }[],
  over: Record<string, unknown> = {},
) {
  return {
    p_workspace_id: page.workspace_id,
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
    p_components: components.map((c) => ({ name: c.name, inApp: c.inApp ?? false, monitorIds: c.monitorIds })),
    p_white_label: false,
    p_private_pages: false,
    ...over,
  };
}

/**
 * The rows a file creates, and only those. Every workspace comes from the real
 * `ensure_workspace` with a fresh `org_itest…` id and is recorded the moment it
 * exists; `cleanup` deletes exactly those workspaces, and the cascade takes
 * everything they own (`invariants.test.ts` proves the cascade). Slugs and token
 * hashes are random too, so two runs never meet.
 */
export class Fixtures {
  readonly workspaces: string[] = [];

  constructor(readonly db: SupabaseClient) {}

  async workspace(): Promise<{ id: string; clerk_org_id: string }> {
    const org = testOrgId();
    const res = await this.db.rpc("ensure_workspace", { p_clerk_org_id: org });
    if (res.error || !res.data) throw new Error(`fixture ensure_workspace failed: ${res.error?.code} ${res.error?.message}`);
    this.workspaces.push(res.data.id);
    return { id: res.data.id, clerk_org_id: res.data.clerk_org_id };
  }

  async app(workspaceId: string, name = `itest app ${hex(4)}`): Promise<{ id: string; name: string }> {
    const res = await this.db.from("apps").insert({ workspace_id: workspaceId, name, url: "https://example.com" }).select("id, name").single();
    if (res.error) throw new Error(`fixture app failed: ${res.error.code} ${res.error.message}`);
    return res.data;
  }

  async monitor(args: MonitorArgs): Promise<Record<string, any>> {
    const res = await this.db.rpc("create_monitor", args);
    if (res.error) throw new Error(`fixture create_monitor failed: ${res.error.code} ${res.error.message}`);
    return res.data;
  }

  /** Bulk rows straight into `monitors`, for reaching a limit's boundary quickly. They are
   *  what the function would count; the call under test still goes through the function. */
  async seedMonitors(rows: Record<string, unknown>[]): Promise<void> {
    if (!rows.length) return;
    const res = await this.db.from("monitors").insert(rows, { defaultToNull: false });
    if (res.error) throw new Error(`fixture seed monitors failed: ${res.error.code} ${res.error.message}`);
  }

  /** Phase 1 has no engine, so nothing but the seed opens an incident: a direct insert. */
  async incident(workspaceId: string, monitorId: string, over: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const res = await this.db
      .from("incidents")
      .insert({ workspace_id: workspaceId, monitor_id: monitorId, title: `itest incident ${hex(3)}`, severity: "down", ...over })
      .select("*")
      .single();
    if (res.error) throw new Error(`fixture incident failed: ${res.error.code} ${res.error.message}`);
    return res.data;
  }

  async note(workspaceId: string, incidentId: string, publish: boolean, body = `itest note ${hex(4)}`, noteId: string | null = null): Promise<Record<string, any>> {
    const res = await this.db.rpc("save_incident_note", {
      p_workspace_id: workspaceId,
      p_incident_id: incidentId,
      p_note_id: noteId,
      p_state: "investigating",
      p_body: body,
      p_publish: publish,
      p_author_user_id: null,
      p_author_client: "itest",
    });
    if (res.error) throw new Error(`fixture save_incident_note failed: ${res.error.code} ${res.error.message}`);
    return res.data;
  }

  async page(workspaceId: string, appId: string, maxPages = limits.free.statusPages): Promise<Record<string, any>> {
    const res = await this.db.rpc("create_status_page", {
      p_workspace_id: workspaceId,
      p_app_id: appId,
      p_slug: testSlug(),
      p_name: `itest page ${hex(3)}`,
      p_logo_text: "itest",
      p_homepage: null,
      p_max_pages: maxPages,
    });
    if (res.error) throw new Error(`fixture create_status_page failed: ${res.error.code} ${res.error.message}`);
    return res.data;
  }

  async savePage(page: Parameters<typeof savePageArgs>[0], components: Parameters<typeof savePageArgs>[1], over: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const res = await this.db.rpc("save_status_page", savePageArgs(page, components, over));
    if (res.error) throw new Error(`fixture save_status_page failed: ${res.error.code} ${res.error.message}`);
    return res.data;
  }

  /** Deletes the workspaces this file created, and nothing else. */
  async cleanup(): Promise<void> {
    if (!this.workspaces.length) return;
    const ids = this.workspaces.splice(0);
    const res = await this.db.from("workspaces").delete().in("id", ids).like("clerk_org_id", "org_itest%").select("id");
    if (res.error) throw new Error(`fixture cleanup failed: ${res.error.code} ${res.error.message}`);
  }
}
