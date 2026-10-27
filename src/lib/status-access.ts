import "server-only";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { db } from "./db";
import { currentCaller } from "./session";
import { NotAllowed, requireWorkspaceAccess } from "./authz";
import { loadPublicIncident, loadPublicView } from "./public-data";
import { snapshotDto, viewFromDto } from "./public-page";

const accessDto = z.object({ id: z.string(), slug: z.string(), workspaceId: z.string(), orgId: z.string() });

/** Public reads never ask Clerk. Only an explicitly private resource reaches this branch;
 * authorization precedes the content read, including the metadata/title read. */
async function privateView(slug: string | null, incidentId: string | null, path: string) {
  // The type generator marks every SQL argument non-null; 029's function takes one of the two.
  const { data, error } = await db().rpc("status_page_access", { p_slug: slug as string, p_incident_id: incidentId as string });
  if (error) throw new Error(`status_page_access failed: ${error.code}`);
  if (!data) return null;
  const access = accessDto.parse(data);
  const caller = await currentCaller();
  if (!caller) redirect(`/sign-in?redirect_url=${encodeURIComponent(path)}`);
  try { requireWorkspaceAccess({ id: access.workspaceId, clerk_org_id: access.orgId }, caller, "monitors:read"); }
  catch (error) { if (error instanceof NotAllowed) notFound(); throw error; }
  const result = await db().rpc("status_page_snapshot", { p_slug: access.slug, p_workspace_id: access.workspaceId });
  if (result.error) throw new Error(`status_page_snapshot failed: ${result.error.code}`);
  return result.data ? viewFromDto(snapshotDto.parse(result.data), Date.now()) : null;
}

export async function loadStatusPage(slug: string) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) return null;
  const publicView = await loadPublicView(slug);
  if (publicView) return { view: publicView, membersOnly: false };
  const view = await privateView(slug, null, `/s/${slug}`);
  return view ? { view, membersOnly: true } : null;
}

export async function loadStatusIncident(id: string) {
  if (!/^inc_[0-9a-f]{24}$/.test(id)) return null;
  const publicIncident = await loadPublicIncident(id);
  if (publicIncident) return publicIncident;
  const view = await privateView(null, id, `/i/${id}`);
  return view ? { view, incidentId: id } : null;
}
