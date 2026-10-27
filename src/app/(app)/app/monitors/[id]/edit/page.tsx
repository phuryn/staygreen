import { loadSnapshot, requireIn, requireMemberWith, resolveMonitor } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { EditMonitorScreen } from "./EditMonitorScreen";

export const dynamic = "force-dynamic";
// Rendered afresh on every visit, never from the router's kept screens (`FRESH_ON_EVERY_VISIT`).
export const unstable_dynamicStaleTime = 0;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [member, monitor] = await requireMemberWith(`/app/monitors/${id}/edit`, () => resolveMonitor(id));
  requireIn(monitor, member, "monitors:write");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <EditMonitorScreen id={id} />
    </WorkspaceSnapshot>
  );
}
