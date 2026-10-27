import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { AgentsScreen } from "./AgentsScreen";
import { agentSettings } from "@/lib/api-tokens";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function Page() {
  const member = await requireMember("/app/agents");
  const settings = await agentSettings(member);
  return (
    <WorkspaceSnapshot snapshot={await loadSnapshot(member)}>
      <AgentsScreen mcpUrl={new URL("/mcp", env().APP_URL).href} {...settings} />
    </WorkspaceSnapshot>
  );
}
