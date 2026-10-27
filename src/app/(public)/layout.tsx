import { SiteFrame } from "@/components/landing/SiteFrame";

// The signed-out site: landing, pricing, scan, legal, sign-in. Its header and footer live in
// `SiteFrame`, which the root 404 wears too, and which reads no session (`AGENTS.md § 1.3`).
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return <SiteFrame>{children}</SiteFrame>;
}
