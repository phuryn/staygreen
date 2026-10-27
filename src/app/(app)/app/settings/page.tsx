import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { SettingsScreen } from "./SettingsScreen";

export const dynamic = "force-dynamic";
// Rendered afresh on every visit, never from the router's kept screens (`FRESH_ON_EVERY_VISIT`).
export const unstable_dynamicStaleTime = 0;

export default async function Page() {
  const member = await requireMember("/app/settings");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <SettingsScreen />
    </WorkspaceSnapshot>
  );
}
