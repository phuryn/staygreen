import "server-only";
import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import type { Caller } from "./authz";
import { demoSlug, entitlementsFrom, FREE, UNREAD, type Entitlements } from "./plans";

/* The one seam between us and Clerk (`AGENTS.md § 1.5`): verify, never decode.
   `auth()` verifies the session server-side on every request; nothing else in
   the app reads a claim, and no route sees a raw token.

   It carries two things, because Clerk answers both from the same verified
   session: *who* the caller is (`current`), and *what their plan allows*
   (`entitlements`, through `has({ feature })`, `§ 1.1`). Keeping them on one
   seam lets a test put a caller and a plan on the request together without a
   Clerk key or a checkout. */

export type SessionVerifier = {
  current(): Promise<Caller | null>;
  /** What the caller's plan allows. Free when nobody is signed in. */
  entitlements(): Promise<Entitlements>;
};

const clerkVerifier: SessionVerifier = {
  async current() {
    const { userId, orgId, orgRole } = await auth();
    if (!userId) return null;
    return { userId, orgId: orgId ?? null, orgRole: orgRole ?? null };
  },

  async entitlements() {
    try {
      const { userId, has } = await auth();
      if (!userId || !has) return FREE;
      const simulated = await devPlan();
      if (simulated) return simulated;
      // `has` is Clerk's own entitlement test, read from the verified session
      // token, never from our database (`§ 1.1`).
      return entitlementsFrom((feature) => has({ feature }));
    } catch {
      return UNREAD; // fail towards Free (`spec.md § 1`), marked so it is never stored
    }
  },
};

/* The development-only plan switch (`docs/variables.md`, DEV_PLAN_OVERRIDE).
   A developer flips a cookie to see every Builder screen and limit without a
   checkout: the actions pass these limits to the
   database functions, so the switch reaches the SQL quotas too.

   It needs two things at once: NODE_ENV=development, which only `next dev`
   sets (`next build` and `next start` run as production), and
   DEV_PLAN_OVERRIDE=on. "development" rather than "not production" keeps it out
   of the test runners too, which run as "test". It sits after the signed-in
   check, so a visitor with no session is Free whatever the cookie says. */

export const DEV_PLAN_COOKIE = "sg-dev-plan";

export function devPlanOverrideEnabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env.DEV_PLAN_OVERRIDE === "on";
}

/** The simulated plan, or null to ask Clerk. "builder" holds every Builder feature, not the
 *  owner's demo counts; any other value is Free, so a stale or mistyped cookie can only lower the plan. */
async function devPlan(): Promise<Entitlements | null> {
  if (!devPlanOverrideEnabled()) return null;
  const value = await devPlanCookie();
  if (value === undefined) return null;
  return value === "builder" ? entitlementsFrom((feature) => feature !== demoSlug) : FREE;
}

async function devPlanCookie(): Promise<string | undefined> {
  try {
    return (await cookies()).get(DEV_PLAN_COOKIE)?.value;
  } catch {
    return undefined; // outside a request (a script, a test harness): Clerk decides
  }
}

/** For the billing screen's toggle: null when the switch is off, else whether
 *  Builder is being simulated right now. */
export async function devPlanSimulation(): Promise<{ builder: boolean } | null> {
  if (!devPlanOverrideEnabled()) return null;
  return { builder: (await devPlanCookie()) === "builder" };
}

let verifier: SessionVerifier = clerkVerifier;

/** Used by the integration harness; never by application code. */
export function setSessionVerifier(next: SessionVerifier | null): void {
  verifier = next ?? clerkVerifier;
}

export function currentCaller(): Promise<Caller | null> {
  return verifier.current();
}

export function currentEntitlements(): Promise<Entitlements> {
  return verifier.entitlements();
}
