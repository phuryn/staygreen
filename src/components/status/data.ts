// What the public surfaces derive from the store: the status page, its preview and the widget
// pieces all read these, so they can never disagree (spec.md § 6 and § 7).

import type { Component, Incident, Note, NoteState, Sim, State, StatusPage } from "@/lib/model";
import { componentState, worst } from "@/lib/derive";
import { has } from "@/lib/plans";
import { hslOf, isHex } from "@/lib/accents";

export const noteWord: Record<NoteState, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};

/** Components with no monitor are not shown publicly: a component nobody checks has no state to earn. */
export const shownComponents = (p: StatusPage) => p.components.filter((c) => c.monitorIds.length > 0);

export const compState = (s: Sim, c: Component): State => componentState(s, c.monitorIds);

export function pageState(s: Sim, p: StatusPage): State {
  return worst(shownComponents(p).map((c) => compState(s, c)));
}

/** A component's day is its worst monitor's day. -1 means no data that day. */
export function componentDaily(s: Sim, c: Component, days = 90): number[] {
  const ms = s.monitors.filter((m) => c.monitorIds.includes(m.id)).map((m) => ({ daily: m.daily }));
  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    let v = Infinity;
    for (const m of ms) {
      const d = m.daily[m.daily.length - 1 - i];
      if (d != null && d >= 0) v = Math.min(v, d);
    }
    out.push(v === Infinity ? -1 : v);
  }
  return out;
}

export const published = (i: Incident): Note[] => i.notes.filter((n) => n.status === "published").sort((a, b) => b.at - a.at);

/** Incidents the page may show: this app's, on a monitor one of its components shows, and only once
 *  the builder has published something; `public_status_snapshot` keeps the same ones. */
export function publicIncidents(s: Sim, p: StatusPage, days = p.showHistoryDays) {
  const from = s.now - days * 86_400_000;
  const shown = new Set(shownComponents(p).flatMap((c) => c.monitorIds));
  return s.incidents
    .filter((i) => i.appId === p.appId && shown.has(i.monitorId) && published(i).length > 0 && (i.resolvedAt ?? s.now) >= from)
    .sort((a, b) => b.openedAt - a.openedAt);
}

/** Incident titles name the monitor ("API health is down"); visitors know components, not monitors.
 *  Publicly, an incident is named after the components its monitor feeds. */
export function publicTitle(p: StatusPage, i: Incident) {
  const names = shownComponents(p).filter((c) => c.monitorIds.includes(i.monitorId)).map((c) => c.name);
  if (!names.length) return i.title;
  return `${names.join(" and ")} ${i.severity === "down" ? "is down" : "is degraded"}`;
}

/** The current incident with its latest published note, optionally limited to in-app components. */
export function currentIncident(s: Sim, p: StatusPage, inAppOnly: boolean) {
  const comps = shownComponents(p).filter((c) => !inAppOnly || c.inApp);
  const ids = new Set(comps.flatMap((c) => c.monitorIds));
  const affected = comps.filter((c) => compState(s, c) === "down" || compState(s, c) === "degraded");
  if (inAppOnly && affected.length === 0) return null;
  const inc = s.incidents
    .filter((i) => i.appId === p.appId && !i.resolvedAt && (!inAppOnly || ids.has(i.monitorId)))
    .filter((i) => published(i).length > 0)
    .sort((a, b) => published(b)[0].at - published(a)[0].at)[0];
  if (!inc) return null;
  const st = worst(affected.map((c) => compState(s, c)));
  return { incident: inc, note: published(inc)[0], state: affected.length ? st : ("degraded" as State), components: affected };
}

/** The banner shows only while an in-app component is degraded or down and its incident has a published note. */
export const bannerFor = (s: Sim, p: StatusPage) => currentIncident(s, p, true);

export const showsMark = (s: Sim, p: StatusPage) => p.poweredBy || !has(s.plan, "white_label");

/** The custom-domain row in a word. */
export function domainState(p: StatusPage): { word: string; live: boolean } {
  if (!p.domain) return { word: "None", live: false };
  if (p.domain.step === 4) return { word: "Live", live: true };
  if (p.domain.step === 3) return { word: "Issuing certificate", live: false };
  return { word: "Waiting for the CNAME", live: false };
}


// ---------- accent ----------
export { isHex };

/** Which status colour an accent could be mistaken for, if any. */
export function nearStatus(hex: string): null | "amber" | "red" | "green" {
  if (!isHex(hex)) return null;
  const { h, s, l } = hslOf(hex);
  if (s < 0.35 || l < 0.2 || l > 0.85) return null;
  if (h >= 22 && h <= 58) return "amber";
  if (h <= 14 || h >= 345) return "red";
  if (h >= 95 && h <= 165) return "green";
  return null;
}
