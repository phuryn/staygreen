import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { loadStatusIncident } from "@/lib/status-access";
import { PublicIncidentView } from "@/components/status/StatusPageView";
import { env } from "@/lib/env";
import { faviconOf } from "@/lib/page-assets";

// One incident at the short link alerts carry (staygreen.io/i/inc_…), in its status page's frame.
// Published notes only; members-only pages verify access before metadata or content is rendered.
export const dynamic = "force-dynamic";

const load = cache(loadStatusIncident);

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await load((await params).id);
  if (!found) return { title: "Incident not found" };
  const i = found.view.incidents.find((x) => x.id === found.incidentId);
  // An incident page is a moment, not a destination: never indexed.
  return { title: { absolute: i ? `${i.title} – ${found.view.page.name}` : found.view.page.name }, icons: { icon: faviconOf(found.view.page) }, robots: { index: false, follow: false } };
}

export default async function PublicIncidentPage({ params }: Props) {
  const found = await load((await params).id);
  if (!found) notFound();
  return <PublicIncidentView view={found.view} incidentId={found.incidentId} appUrl={env().APP_URL} />;
}
