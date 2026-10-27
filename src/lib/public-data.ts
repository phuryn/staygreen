import "server-only";
import { db } from "./db";
import { incidentDto, snapshotDto, viewFromDto, type PublicView } from "./public-page";

/* The two reads behind the public routes. No session, no cookies: what a
   visitor sees is a function of the slug or the incident id alone. A snapshot
   that doesn't parse is treated as missing, never shown half-checked. */

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// `public.new_id`: a prefix, an underscore and 24 hex digits. Anything else is not an id.
const INCIDENT = /^inc_[0-9a-f]{24}$/;

export async function loadPublicView(slug: string): Promise<PublicView | null> {
  if (!SLUG.test(slug)) return null;
  const { data, error } = await db().rpc("public_status_snapshot", { p_slug: slug });
  if (error) throw new Error(`public_status_snapshot failed: ${error.code}`);
  if (!data) return null;
  const parsed = snapshotDto.safeParse(data);
  if (!parsed.success) throw new Error("public_status_snapshot returned an unexpected shape");
  return viewFromDto(parsed.data, Date.now());
}

export async function loadPublicIncident(id: string): Promise<{ view: PublicView; incidentId: string } | null> {
  if (!INCIDENT.test(id)) return null;
  const { data, error } = await db().rpc("public_incident", { p_incident_id: id });
  if (error) throw new Error(`public_incident failed: ${error.code}`);
  if (!data) return null;
  const parsed = incidentDto.safeParse(data);
  if (!parsed.success) throw new Error("public_incident returned an unexpected shape");
  return { view: viewFromDto(parsed.data, Date.now()), incidentId: parsed.data.incidentId };
}
