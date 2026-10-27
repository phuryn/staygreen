import { env } from "@/lib/env";
import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { WidgetScreen } from "./WidgetScreen";

export const dynamic = "force-dynamic";

export default async function Page() {
  const member = await requireMember("/app/widget");
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      {/* The badge's Markdown leaves the request for a README, so it is built on the app's public
          address, never on the host this request happened to reach (`docs/variables.md`). */}
      <WidgetScreen origin={new URL(env().APP_URL).origin} />
    </WorkspaceSnapshot>
  );
}
