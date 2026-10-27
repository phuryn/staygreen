// What every screen derives from a workspace: worst states, host counts, open incidents. Pure,
// so the dashboard and the status page preview can never disagree about what a state means.
// Uptime and response times are the probes' and come computed (`history.ts`).

import { statusHost } from "@/lib/status-host";
import type { Sim, State, StatusPage } from "./model";

/** The worst of a set of states. A problem wins; then anything known to be up; a set that is all
 *  paused is paused; and a set with nothing checked yet, the empty set included, is unchecked. */
export const worst = (states: State[]): State =>
  states.includes("down")
    ? "down"
    : states.includes("degraded")
      ? "degraded"
      : states.includes("up")
        ? "up"
        : states.length && states.every((x) => x === "paused")
          ? "paused"
          : "unchecked";

export function appState(s: Sim, appId: string) {
  return worst(s.monitors.filter((m) => m.appId === appId).map((m) => m.state));
}

export function workspaceState(s: Sim) {
  return worst(s.monitors.map((m) => m.state));
}

/** Paused monitors never make a component look down: paused ranks below up in `worst`. */
export function componentState(s: Sim, monitorIds: string[]) {
  return worst(s.monitors.filter((m) => monitorIds.includes(m.id)).map((m) => m.state));
}

/** Monitors that send checks to a host, for the per-host cap. SSL monitors don't count, and
 *  neither do heartbeats or Stripe, which reach no host of yours. */
export function hostCount(s: Sim, host: string) {
  return s.monitors.filter((m) => {
    if (m.type === "ssl" || m.type === "heartbeat" || m.type === "stripe") return false;
    const t = m.tcp?.host ?? m.dns?.name ?? m.target;
    try {
      return new URL(t.startsWith("http") ? t : `https://${t}`).hostname === host;
    } catch {
      return false;
    }
  }).length;
}

export function openIncidents(s: Sim) {
  return s.incidents.filter((i) => !i.resolvedAt);
}

export function pageHost(p: StatusPage) {
  if (p.membersOnly) return `staygreen.io/s/${p.slug}`;
  return p.domain?.step === 4 ? p.domain.host : `${statusHost()}/${p.slug}`;
}

/** The address a builder shares: the one `pageHost` shows, as a link. */
export function pageUrl(p: StatusPage) {
  return `https://${pageHost(p)}`;
}
