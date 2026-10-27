/* What the database refused, in the builder's words.

   The SQL functions raise a machine message (`supabase/migrations/`), and the
   tables refuse with a constraint name. This turns either into a sentence a
   screen can show, with the plan's numbers in it. Pure, so the unit suite holds
   every message; nothing here reads the request or the database.

   `not_found` is never worded here: a row that is missing and a row that
   belongs to another workspace are the same 404 (`AGENTS.md § 1.1`), so the
   caller answers it with `notFound()` or the same "not found" result. */

import { limits, type Entitlements } from "./plans";

/** The fields of a PostgREST error that matter here. */
export type DbError = { code?: string | null; message?: string | null; details?: string | null };

export function isNotFound(e: DbError | null | undefined): boolean {
  return !!e && e.code === "PT404" && e.message === "not_found";
}

/** The constraint a unique, check or foreign-key violation names, if any. */
export function constraintOf(e: DbError): string | null {
  const m = `${e.message ?? ""} ${e.details ?? ""}`.match(/constraint "([^"]+)"/);
  return m ? m[1] : null;
}

/** Shared by dashboard saves and agent writes; neither should retry an invalid name. */
export function appNameRefusal(e: DbError): string | null {
  const constraint = constraintOf(e);
  if (e.code === "23505" && constraint === "apps_workspace_name_key") return "You already have an app with that name.";
  if (e.code === "23514" && constraint === "apps_name_check") return "An app's name runs from 1 to 60 characters.";
  return null;
}

export type ErrorContext = {
  entitlements: Pick<Entitlements, "plan" | "limits">;
  /** The host a monitor was being added for, for the per-host message. */
  host?: string | null;
  /** The type being added, for the assertion message. */
  type?: string;
};

const planName = (e: ErrorContext["entitlements"]) => (e.plan === "builder" ? "Builder" : "Free");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A sentence for a refusal, or a generic one when the refusal is not ours to word. */
export function describeDbError(e: DbError, ctx: ErrorContext): string {
  const nameRefusal = appNameRefusal(e);
  if (nameRefusal) return nameRefusal;
  const L = ctx.entitlements.limits;
  const free = ctx.entitlements.plan === "free";
  const B = limits.builder;

  switch (e.message) {
    case "service_monitor_limit":
      return ctx.type === "stripe" ? `Your plan allows ${L.stripeAccounts} Stripe monitor connections. Keep one monitor per account.`
        : `Your plan allows ${L.supabaseMonitors === "cap" ? L.monitors : L.supabaseMonitors} Supabase monitors.`;
    case "monitor_limit":
      return free ? `Your plan allows ${L.monitors} monitors. Builder allows ${B.monitors}.` : `Your plan allows ${L.monitors} monitors, and they're all in use.`;
    case "heartbeat_limit":
      return free ? `Free includes ${plural(L.heartbeats, "heartbeat")}. Builder includes ${B.heartbeats}.` : `Builder includes ${L.heartbeats} heartbeats, and they're all in use.`;
    case "assertion_limit": {
      const n = ctx.type === "heartbeat" ? L.heartbeatAssertions : L.assertions;
      return `${planName(ctx.entitlements)} allows ${plural(n, "assertion")} on ${ctx.type === "heartbeat" ? "a heartbeat" : "a monitor"}.`;
    }
    case "interval_not_allowed":
      return `${planName(ctx.entitlements)} checks at most every ${plural(L.httpIntervalMin, "minute")}.`;
    case "host_limit": {
      const n = typeof L.perHost === "number" ? L.perHost : L.monitors;
      return ctx.host ? `${planName(ctx.entitlements)} allows ${n} monitors per host, and ${ctx.host} has ${n}.` : `${planName(ctx.entitlements)} allows ${n} monitors per host.`;
    }
    case "app_limit":
      return free ? `Free includes ${plural(L.apps, "app")}. Builder includes ${B.apps}, each with its own monitors and status page.` : `Builder includes ${L.apps} apps, and they're all in use.`;
    case "page_limit":
      return free ? `Free includes ${plural(L.statusPages, "status page")}. Builder includes ${B.statusPages}.` : `Builder includes ${L.statusPages} status pages, and they're all in use.`;
    case "type_not_available":
      return "That kind of monitor isn't available yet.";
    case "auto_monitor":
      return "Staygreen added this monitor with an HTTPS monitor, and it changes with that one.";
    case "white_label_required":
      return "Removing the Staygreen mark comes with Builder.";
    case "private_pages_required":
      return "Hiding a page from search engines comes with Builder.";
    case "components_invalid":
      return "A status page has at most 50 components.";
    case "note_published":
      return "A published update can't go back to being a draft.";
    case "pause_window_invalid":
      return "A pause lasts between a minute and 30 days.";
    case "organization_required":
      return "Choose a workspace first.";
    case "teammates_required":
      return "Teammates without an account come with Builder.";
  }

  const constraint = constraintOf(e);
  if (e.code === "23505") {
    switch (constraint) {
      case "status_pages_slug_key":
        return "That address is taken. Try another.";
      case "status_pages_app_id_key":
        return "That app already has a status page.";
      case "alert_channels_address_key":
        return "That address already gets this workspace's alerts, or is waiting for its confirmation.";
    }
    return "That already exists. Reload to see it.";
  }
  if (e.code === "23514") {
    switch (constraint) {
      case "status_pages_slug_check":
      case "status_pages_edge_slug_check":
        return "Use up to 40 lowercase letters, digits and dashes, starting and ending with a letter or digit. A few words, like www and status, are reserved.";
      case "apps_url_check":
      case "status_pages_homepage_check":
        return "Enter a full address, starting with https://";
      case "monitors_name_check":
        return "A monitor's name runs from 1 to 80 characters.";
      case "status_pages_name_check":
      case "page_components_name_check":
        return "A name runs from 1 to 80 characters.";
      case "status_pages_logo_text_check":
        return "The logo text runs to 40 characters.";
      case "status_pages_accent_check":
        return "Pick the accent colour as a hex value, like #1F2DE6.";
      case "incident_notes_body_check":
        return "An update runs from 1 to 5,000 characters.";
      case "alert_channels_address_check":
        return "That isn't an address Staygreen can send to.";
    }
    return "One of those values isn't allowed. Check the form and try again.";
  }
  if (e.code === "23503") return "Something it points at was just deleted. Reload and try again.";
  return "That didn't save. Try again in a moment.";
}
