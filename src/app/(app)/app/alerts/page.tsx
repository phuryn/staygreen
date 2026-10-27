import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { loadAlertsView } from "@/lib/alerts/server";
import { AlertsScreen } from "./AlertsScreen";

export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const member = await requireMember("/app/alerts");
  // The channels, the members who get email (read from Clerk now, never stored) and the latest
  // receipts are this page's own read, beside the snapshot every page shares.
  const [snapshot, view] = await Promise.all([loadSnapshot(member), loadAlertsView(member)]);
  const slack = (await searchParams).slack;
  return (
    <WorkspaceSnapshot snapshot={snapshot}>
      {slack && <p role="status" className="callout callout-info">{slack === "connected" ? "Slack connected. Send a test from its channel row." : slack === "cancelled" ? "Slack connection cancelled." : "Slack could not be connected. Start again from Add to Slack."}</p>}
      <AlertsScreen view={view} />
    </WorkspaceSnapshot>
  );
}
