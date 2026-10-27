import { loadSnapshot, requireIn, requireMemberWith, resolvePage } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { PageEditorScreen } from "./PageEditorScreen";

export const dynamic = "force-dynamic";
// Rendered afresh on every visit, never from the router's kept screens (`FRESH_ON_EVERY_VISIT`).
export const unstable_dynamicStaleTime = 0;

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [member, page] = await requireMemberWith(`/app/status-pages/${id}`, () => resolvePage(id));
  requireIn(page, member, "pages:manage");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <PageEditorScreen id={id} />
    </WorkspaceSnapshot>
  );
}
