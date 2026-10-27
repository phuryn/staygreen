"use server";

import { cookies } from "next/headers";
import { assertSameOrigin, CrossOrigin } from "@/lib/request";
import { DEV_PLAN_COOKIE, devPlanOverrideEnabled } from "@/lib/session";
import { allowed, memberOrNull } from "@/lib/workspace";
import type { Result } from "../actions";

/* The development-only plan switch behind the billing screen's toggle
   (`session.ts`, `docs/variables.md` DEV_PLAN_OVERRIDE). The same steps as every
   dashboard write: the Origin check, the member, the permission. Then it refuses
   outright unless the override is on, so in production it is a no-op.

   It sets a cookie from a Server Action, which `AGENTS.md § 1.1` avoids for the
   anonymous bootstrap because Next re-renders the page around it. Here that
   re-render is the point: the page comes back on the new plan. */

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export async function simulateBuilderPlan(on: boolean): Promise<Result> {
  try {
    await assertSameOrigin();
  } catch (e) {
    if (e instanceof CrossOrigin) return { ok: false, reason: "This request didn't come from Staygreen, so it was refused." };
    throw e;
  }
  const member = await memberOrNull();
  if (!member) return { ok: false, reason: "Your session has ended. Sign in again to keep going." };
  if (!allowed(member.workspace, member.caller, "billing:manage")) return { ok: false, reason: "Only a workspace admin can change the plan." };
  if (!devPlanOverrideEnabled()) return { ok: false, reason: "The plan switch works only under next dev with DEV_PLAN_OVERRIDE=on." };

  const jar = await cookies();
  if (on === true) jar.set(DEV_PLAN_COOKIE, "builder", { httpOnly: true, sameSite: "lax", path: "/", maxAge: THIRTY_DAYS });
  else jar.delete(DEV_PLAN_COOKIE);
  return { ok: true };
}
