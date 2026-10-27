import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { IncidentsScreen } from "./IncidentsScreen";

export const dynamic = "force-dynamic";

export default async function Page() {
  const member = await requireMember("/app/incidents");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <IncidentsScreen />
    </WorkspaceSnapshot>
  );
}
