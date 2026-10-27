import { heartbeatLatestOf, heartbeatUrlOf, loadSnapshot, monitorHistory, requireIn, requireMemberWith, resolveMonitor } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { MonitorScreen } from "./MonitorScreen";

export const dynamic = "force-dynamic";
// Rendered afresh on every visit, never from the router's kept screens (`FRESH_ON_EVERY_VISIT`).
export const unstable_dynamicStaleTime = 0;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [member, monitor] = await requireMemberWith(`/app/monitors/${id}`, () => resolveMonitor(id));
  requireIn(monitor, member, "monitors:read");
  // This page alone gets the ping URL, what a heartbeat's job sent, and the monitor's 24 hours of
  // windows and failed checks; the snapshot every screen receives never holds them.
  const [snapshot, pingUrl, history, latest] = await Promise.all([
    loadSnapshot(member), heartbeatUrlOf(member, id), monitorHistory(member, id), heartbeatLatestOf(member, id),
  ]);
  return (
    <WorkspaceSnapshot snapshot={snapshot}>
      <MonitorScreen id={id} pingUrl={pingUrl} history={history} latest={latest} />
    </WorkspaceSnapshot>
  );
}
