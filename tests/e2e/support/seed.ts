import { insert, select, update } from "./rest";

/* What the engine will write and nothing else does yet (`scripts/seed-incident.mjs` is the same
   thing for a person at a terminal): an incident on a monitor, the monitor's state to match, and
   optionally a note. Phase 2 replaces this with a target taken down for real. */

export async function workspaceOf(orgId: string): Promise<string> {
  const rows = await select<{ id: string }>("workspaces", `clerk_org_id=eq.${orgId}&select=id`);
  if (!rows.length) throw new Error(`no workspace for ${orgId}; the app creates it on the member's first visit`);
  return rows[0].id;
}

export async function openIncident(o: { workspaceId: string; monitorId: string; title: string; severity?: "down" | "degraded"; resolved?: boolean }) {
  const severity = o.severity ?? "down";
  const opened = new Date(Date.now() - 20 * 60_000).toISOString();
  const resolvedAt = o.resolved ? new Date(Date.now() - 5 * 60_000).toISOString() : null;
  const [row] = await insert<{ id: string }>("incidents", {
    workspace_id: o.workspaceId,
    monitor_id: o.monitorId,
    title: o.title,
    severity,
    opened_at: opened,
    resolved_at: resolvedAt,
    evidence: { request: "GET", summary: "Answered 503 from both locations", locations: ["tor1", "sfo3"] },
    timeline: [{ t: opened, text: "Check failed in Toronto" }],
  });
  await update("monitors", `id=eq.${o.monitorId}`, { state: o.resolved ? "up" : severity, state_since: resolvedAt ?? opened });
  return row.id;
}

export async function addNote(o: { workspaceId: string; incidentId: string; body: string; published?: boolean }) {
  const [row] = await insert<{ id: string }>("incident_notes", {
    workspace_id: o.workspaceId,
    incident_id: o.incidentId,
    state: "investigating",
    body: o.body,
    status: o.published ? "published" : "draft",
    published_at: o.published ? new Date().toISOString() : null,
    author_client: "e2e",
  });
  return row.id;
}
