import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { StatusPagesScreen } from "./StatusPagesScreen";

export const dynamic = "force-dynamic";

export default async function Page() {
  const member = await requireMember("/app/status-pages");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <StatusPagesScreen />
    </WorkspaceSnapshot>
  );
}
