import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { AddMonitorScreen } from "./AddMonitorScreen";

export const dynamic = "force-dynamic";

export default async function Page() {
  const member = await requireMember("/app/monitors/new");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <AddMonitorScreen />
    </WorkspaceSnapshot>
  );
}
