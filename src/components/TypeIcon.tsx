import { Globe, ShieldCheck, HeartPulse, Network, Plug, Database, CreditCard, Cable } from "lucide-react";
import type { MonitorType } from "@/lib/model";

const icons = { http: Globe, ssl: ShieldCheck, heartbeat: HeartPulse, dns: Network, mcp: Plug, supabase: Database, stripe: CreditCard, tcp: Cable };

export function TypeIcon({ type, size = 18 }: { type: MonitorType; size?: number }) {
  const I = icons[type];
  return <I width={size} height={size} strokeWidth={1.75} aria-hidden="true" />;
}
