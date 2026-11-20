import { Shell } from "@/components/Shell";
import { WorkspaceProfile } from "@/components/WorkspaceProfile";
import { invoicesAvailable } from "@/lib/invoices/access";
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
      <WorkspaceProfile organizationId={member.workspace.clerk_org_id} invoicesEnabled={invoicesAvailable(member)}>
        <Shell>{children}</Shell>
      </WorkspaceProfile>
    </WorkspaceRoot>
  );
}
