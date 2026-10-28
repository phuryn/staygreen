import "server-only";
import { demoSlug, entitlementsFrom } from "./plans";

/** The env schema validates the value and refuses Staygreen's hosted domains at startup. */
export function selfHostedPlanEnabled(): boolean {
  return process.env.SELF_HOSTED_PLAN === "builder";
}

/** All Builder features at its ordinary limits, never the owner's demo counts. */
export const SELF_HOSTED_ENTITLEMENTS = entitlementsFrom((feature) => feature !== demoSlug);
