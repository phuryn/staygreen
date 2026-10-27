import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/public-metadata";
import { Scan } from "@/components/scan/Scan";
export const metadata: Metadata = { ...publicPageMetadata("/scan"), title: "The scan", description: "Check expiry, find a status page, and check Supabase health and Stripe deliveries. No account needed." };
export default function PublicScanPage() {
  return <div className="wrap band-tight"><div className="pb-scan-page stack-lg"><header className="stack-sm"><h1 className="t-title">What could fail without you noticing?</h1><p className="t-lead">Read your app from the outside. No account needed, and nothing is added as a monitor.</p></header><Scan /></div></div>;
}
