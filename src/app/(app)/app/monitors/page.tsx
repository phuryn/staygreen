import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { MonitorsScreen } from "./MonitorsScreen";

export const dynamic = "force-dynamic";

export default async function Page() {
  const member = await requireMember("/app/monitors");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <MonitorsScreen />
    </WorkspaceSnapshot>
  );
}
