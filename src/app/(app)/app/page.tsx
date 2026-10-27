import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { OverviewScreen } from "./OverviewScreen";

export const dynamic = "force-dynamic";

export default async function Page() {
  const member = await requireMember("/app");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <OverviewScreen />
    </WorkspaceSnapshot>
  );
}
