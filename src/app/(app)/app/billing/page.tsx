import { devPlanSimulation } from "@/lib/session";
import { loadSnapshot, requireMember } from "@/lib/workspace";
import { WorkspaceSnapshot } from "@/lib/workspace-store";
import { BillingScreen } from "./BillingScreen";

export const dynamic = "force-dynamic";

export default async function Page() {
  const member = await requireMember("/app/billing");
  // Null unless `next dev` runs with DEV_PLAN_OVERRIDE=on, so production never renders the switch.
  const [snapshot, simulation] = await Promise.all([loadSnapshot(member), devPlanSimulation()]);
  return (
    <WorkspaceSnapshot snapshot={snapshot}>
      <BillingScreen simulation={simulation} />
    </WorkspaceSnapshot>
  );
}
