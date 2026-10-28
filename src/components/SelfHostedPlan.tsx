"use client";

import { createContext, useContext, type ReactNode } from "react";

// Display only. The server's entitlement seams decide every allowance independently.
const SelfHostedPlan = createContext(false);

export function SelfHostedPlanProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <SelfHostedPlan.Provider value={enabled}>{children}</SelfHostedPlan.Provider>;
}

export const useSelfHostedPlan = () => useContext(SelfHostedPlan);
