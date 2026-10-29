import { statusHost } from "@/lib/status-host";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { loadStatusPage } from "@/lib/status-access";
import { env } from "@/lib/env";
import { StatusPageView } from "@/components/status/StatusPageView";
import { faviconOf } from "@/lib/page-assets";

// Public pages use the snapshot without a session. Only a private page resolves membership;
// it stays here when public pages redirect to the standalone renderer.
export const dynamic = "force-dynamic";

const load = cache(loadStatusPage);

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await load((await params).slug);
  const view = found?.view;
  if (!view) return { title: "Status page not found" };
  // The page's own name, not Staygreen's: it is the builder's page.
  return { title: { absolute: view.page.name }, icons: { icon: faviconOf(view.page) }, ...(found.membersOnly || view.page.noindex ? { robots: { index: false, follow: false } } : {}) };
}

export default async function PublicStatusPage({ params }: Props) {
  const found = await load((await params).slug);
  const view = found?.view;
  if (!view) notFound();
  if (!found!.membersOnly && env().STATUS_EDGE_ENABLED === "on") redirect(`https://${statusHost()}/${view.page.slug}`);
  return <StatusPageView view={view} appUrl={env().APP_URL} />;
}
