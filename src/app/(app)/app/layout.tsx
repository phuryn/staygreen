import { Shell } from "@/components/Shell";
import { getMember } from "@/lib/workspace";
import { WorkspaceRoot } from "@/lib/workspace-store";

export const metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

// The layout never redirects: a signed-out visitor reaches the page, whose `requireMember`
// sends them to sign-in with the page's own path to come back to. A caller who holds nothing
// in this workspace gets the 404 from `getMember`.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const member = await getMember();
  if (!member) return children;
  return (
    <WorkspaceRoot key={member.workspace.id} workspaceId={member.workspace.id}>
      <Shell>{children}</Shell>
    </WorkspaceRoot>
  );
}
