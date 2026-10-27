import { z } from "zod";
import { compState, componentDaily, publicIncidents, publicTitle, published, shownComponents, showsMark } from "@/components/status/data";
import { worst } from "./derive";
import { datedSeries } from "./history";
import { NOTE_STATES } from "./page-input";
import { pageAssetPath } from "./page-assets";
import type { NoteState, Sim, State, StatusPage } from "./model";

/* What a public status page shows, and nothing else (`AGENTS.md § 2.9`).

   Two sources produce the same view: the public snapshot function, read by
   `/s/<slug>` and `/i/<id>` with no session (`public-data.ts`), and the
   dashboard's own workspace, for the editor's preview. The view is the
   allowlist: a field that isn't in `PublicView` can't reach a visitor, and the
   DTO below drops anything the function might add. Pure and browser-safe. */

export type PublicNote = { id: string; state: NoteState; text: string; at: number };

export type PublicIncident = {
  id: string;
  title: string;
  severity: "down" | "degraded";
  openedAt: number;
  resolvedAt: number | null;
  notes: PublicNote[];
  componentKeys?: string[];
};

export type PublicComponent = { key: string; name: string; inApp: boolean; state: State; daily: number[] };

export type PublicView = {
  page: { slug: string; name: string; logoText: string; logoUrl: string | null; faviconUrl: string | null; homepage: string; accent: string; theme: StatusPage["theme"]; poweredBy: boolean; noindex: boolean; historyDays: number };
  components: PublicComponent[];
  incidents: PublicIncident[];
  /** The newest check behind the page, or null before the first one. */
  updatedAt: number | null;
  now: number;
};

// ── the DTO ─────────────────────────────────────────────────────────────────

const when = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "a timestamp");

/** The snapshot function's output, as an allowlist: `z.object` drops keys it doesn't name. */
export const snapshotDto = z.object({
  page: z.object({
    slug: z.string(),
    name: z.string(),
    logoText: z.string(),
    logoUrl: pageAssetPath.nullable().default(null),
    faviconUrl: pageAssetPath.nullable().default(null),
    homepage: z.string().nullable(),
    accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    theme: z.enum(["light", "dark", "visitor"]),
    poweredBy: z.boolean(),
    noindex: z.boolean(),
    historyDays: z.number().int().min(1).max(366),
  }),
  components: z.array(
    z.object({
      key: z.number().int(),
      name: z.string(),
      inApp: z.boolean(),
      // null until the first check (`§ 2.8`).
      states: z.array(z.enum(["up", "degraded", "down", "paused"]).nullable()),
      // Each UTC day with a window, the worst of the component's monitors (migration 014).
      daily: z.array(z.object({ d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), up: z.number().min(0).max(100) })),
    }),
  ),
  incidents: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      severity: z.enum(["down", "degraded"]),
      openedAt: when,
      resolvedAt: when.nullable(),
      components: z.array(z.number().int()).nullable(),
      notes: z.array(z.object({ id: z.string(), state: z.enum(NOTE_STATES), body: z.string(), at: when })).nullable(),
    }),
  ),
});

export const incidentDto = snapshotDto.extend({ incidentId: z.string() });

export type SnapshotDto = z.infer<typeof snapshotDto>;

/** A visitor knows components, not monitors: an incident is named after the components it hit. */
function titleFrom(names: string[], severity: "down" | "degraded", fallback: string) {
  return names.length ? `${names.join(" and ")} ${severity === "down" ? "is down" : "is degraded"}` : fallback;
}

export function viewFromDto(d: SnapshotDto, now: number): PublicView {
  const nameAt = new Map(d.components.map((c) => [c.key, c.name]));
  return {
    page: { ...d.page, homepage: d.page.homepage ?? "" },
    components: d.components.map((c) => ({
      key: String(c.key),
      name: c.name,
      inApp: c.inApp,
      state: worst(c.states.map((x) => x ?? "unchecked")),
      daily: datedSeries(c.daily, now),
    })),
    incidents: d.incidents.map((i) => ({
      id: i.id,
      title: titleFrom((i.components ?? []).map((k) => nameAt.get(k)).filter((x): x is string => !!x), i.severity, i.title),
      severity: i.severity,
      openedAt: Date.parse(i.openedAt),
      resolvedAt: i.resolvedAt ? Date.parse(i.resolvedAt) : null,
      notes: (i.notes ?? []).map((n) => ({ id: n.id, state: n.state, text: n.body, at: Date.parse(n.at) })),
      componentKeys: (i.components ?? []).map(String),
    })),
    updatedAt: null,
    now,
  };
}

/** The editor's preview: the same view, from the workspace the dashboard already holds. */
export function viewFromSim(s: Sim, p: StatusPage): PublicView {
  const shown = shownComponents(p);
  const ids = new Set(shown.flatMap((c) => c.monitorIds));
  // A window still open (a new monitor's first check, written at once) ends ahead of now.
  const last = Math.max(0, ...s.monitors.filter((m) => ids.has(m.id)).flatMap((m) => m.reports.map((r) => Math.min(r.end, s.now))));
  return {
    page: { slug: p.slug, name: p.name, logoText: p.logoText, logoUrl: p.logoUrl, faviconUrl: p.faviconUrl, homepage: p.homepage, accent: p.accent, theme: p.theme, poweredBy: showsMark(s, p), noindex: p.noindex, historyDays: p.showHistoryDays },
    components: shown.map((c) => ({ key: c.id, name: c.name, inApp: c.inApp, state: compState(s, c), daily: componentDaily(s, c, 90) })),
    incidents: publicIncidents(s, p).map((i) => ({
      id: i.id,
      title: publicTitle(p, i),
      severity: i.severity,
      openedAt: i.openedAt,
      resolvedAt: i.resolvedAt,
      notes: published(i).map((n) => ({ id: n.id, state: n.state, text: n.text, at: n.at })),
    })),
    updatedAt: last || null,
    now: s.now,
  };
}

/** The page's one line at the top: what a visitor most needs to know. */
export function headline(v: PublicView): { state: State; title: string; detail?: string } {
  if (!v.components.length) return { state: "unchecked", title: "Nothing to show yet", detail: "This page has no components yet." };
  const st = worst(v.components.map((c) => c.state));
  // "All" means all: one component up beside a paused or unchecked one is not an all-clear.
  const unknown = v.components.filter((c) => c.state === "paused" || c.state === "unchecked").map((c) => c.name);
  if (st === "up" && !unknown.length) return { state: "up", title: "All systems operational" };
  if (st === "up") return { state: "up", title: "No problems found", detail: `Not checked right now: ${unknown.join(", ")}.` };
  // Every component paused: claiming "operational" would be a guess.
  if (st === "paused") return { state: "paused", title: "Checks are paused", detail: "Staygreen isn't checking these right now, so this page can't say how they're doing." };
  if (st === "unchecked") return { state: "unchecked", title: "Not checked yet", detail: "Staygreen hasn't checked these yet. This page updates once it has." };
  const hit = v.components.filter((c) => c.state === st).map((c) => c.name);
  return { state: st, title: `${st === "down" ? "Outage" : "Degraded"}: ${hit.join(", ")}` };
}
