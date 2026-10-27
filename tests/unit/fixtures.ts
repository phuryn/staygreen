/* Builders for the shapes in `src/lib/model.ts`, so a unit test names only the
   fields its assertion depends on. Not a test file: `vitest.config.ts` collects
   `*.test.ts` only. Every default is the dullest value the type allows. */

import type { Component, Incident, Monitor, Note, Sim, StatusPage } from "@/lib/model";

export const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);
export const DAY = 86_400_000;

export function monitor(over: Partial<Monitor> & Pick<Monitor, "id">): Monitor {
  return {
    appId: "app_1",
    type: "http",
    name: over.id,
    target: "https://example.com/health",
    intervalSec: 180,
    state: "up",
    stateSince: NOW - DAY,
    createdAt: NOW - 30 * DAY,
    checked: true,
    reports: [],
    uptime: { day: { pct: null, coveredMs: 0 }, month: { pct: null, coveredMs: 0 } },
    p95: null,
    failing: null,
    paused: null,
    incidentId: null,
    daily: [],
    events: [],
    ...over,
  };
}

export function note(over: Partial<Note> & Pick<Note, "id">): Note {
  return { state: "investigating", text: "Looking into it.", status: "published", at: NOW - 1000, author: "You", ...over };
}

export function incident(over: Partial<Incident> & Pick<Incident, "id" | "monitorId">): Incident {
  return {
    appId: "app_1",
    title: `${over.monitorId} is down`,
    severity: "down",
    openedAt: NOW - 3_600_000,
    resolvedAt: null,
    ackedAt: null,
    evidence: { request: "GET https://example.com/health", summary: "returned 500", locations: [], snippet: "" },
    timeline: [],
    notes: [],
    ...over,
  };
}

export function component(over: Partial<Component> & Pick<Component, "id">): Component {
  return { name: over.id, monitorIds: [], inApp: false, ...over };
}

export function page(over: Partial<StatusPage> = {}): StatusPage {
  return {
    id: "page_1",
    appId: "app_1",
    slug: "example",
    name: "Example status",
    logoText: "Example",
    logoUrl: null,
    faviconUrl: null,
    homepage: "https://example.com",
    accent: "#1F2DE6",
    theme: "visitor",
    domain: null,
    components: [],
    poweredBy: true,
    membersOnly: false,
    noindex: false,
    subscribersOn: false,
    subscribers: 0,
    showHistoryDays: 90,
    ...over,
  };
}

export function sim(over: Partial<Sim> = {}): Sim {
  return {
    v: 1,
    version: 1,
    seededAt: NOW,
    now: NOW,
    plan: "free",
    cycle: "yearly",
    workspace: { name: "Example", owner: "You" },
    apps: [],
    monitors: [],
    incidents: [],
    channels: [],
    deliveries: [],
    pages: [],
    tokens: [],
    activity: [],
    teammates: [],
    toasts: [],
    notified: [],
    live: false,
    seq: 0,
    ...over,
  };
}
