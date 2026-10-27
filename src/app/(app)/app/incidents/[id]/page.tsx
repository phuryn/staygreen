import { loadSnapshot, requireIn, requireMemberWith, resolveIncident } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { IncidentScreen } from "./IncidentScreen";

export const dynamic = "force-dynamic";
// Rendered afresh on every visit, never from the router's kept screens (`FRESH_ON_EVERY_VISIT`).
export const unstable_dynamicStaleTime = 0;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [member, incident] = await requireMemberWith(`/app/incidents/${id}`, () => resolveIncident(id));
  requireIn(incident, member, "monitors:read");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <IncidentScreen id={id} />
    </WorkspaceSnapshot>
  );
}
