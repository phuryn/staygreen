import { loadSnapshot, requireIn, requireMemberWith, resolveApp } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { ChecksScreen } from "./ChecksScreen";

export const dynamic = "force-dynamic";
// Rendered afresh on every visit, never from the router's kept screens (`FRESH_ON_EVERY_VISIT`).
export const unstable_dynamicStaleTime = 0;

/** Suggested checks for a new or existing app (`docs/flows.md § Suggested checks`). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [member, app] = await requireMemberWith(`/app/apps/${id}/checks`, () => resolveApp(id));
  requireIn(app, member, "monitors:write");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <ChecksScreen id={id} />
    </WorkspaceSnapshot>
  );
}
