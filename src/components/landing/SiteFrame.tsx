import Link from "next/link";
import { cookies } from "next/headers";
import { Logo } from "@/components/Logo";
import { isBuilt } from "@/lib/launch";
import { GITHUB_REPO, OWN_STATUS_PAGE } from "@/lib/site-links";
import { checkedFromNow } from "./plan-copy";

// The signed-out site's header and footer, shared by the public layout and the root 404.
//
// The front door reads no session (`AGENTS.md § 1.3`): no `auth()`, nothing from Clerk's
// server SDK. The header's one button goes to the member home, labelled from Clerk's
// `__client_uat` cookie, which is above zero once this browser has signed in. It is a guess,
// and a wrong one costs nothing: both labels open `/app`, which checks for itself. No
// prefetch, so a signed-out visitor's browser never fetches the redirect it would get.

// What a visitor can't yet rely on, read from what this build runs. Gone once both are built.
function stillBeingBuilt(): string | null {
  if (!isBuilt("probes")) return "You can sign up and set up monitors, but nothing checks them yet, so no alerts go out.";
  if (!isBuilt("alerts")) return "Monitors are checked, but alerts don't go out yet.";
  return null;
}

export async function SiteFrame({ children }: { children: React.ReactNode }) {
  const uat = Number((await cookies()).get("__client_uat")?.value ?? "0");
  const signedIn = Number.isFinite(uat) && uat > 0;
  const building = stillBeingBuilt();
  return (
    <div className="site">
      <a href="#main" className="skip">Skip to content</a>
      <header className="site-head">
        <div className="wrap site-head-row">
          <Link href="/" className="site-brand" aria-label="Staygreen home">
            <Logo />
          </Link>
          <nav aria-label="Site" className="site-nav">
            <Link href="/#checks" className="hide-md">What it checks</Link>
            <Link href="/pricing">Pricing</Link>
            {isBuilt("scan") && <Link href="/scan" className="hide-md">Scan your app</Link>}
            {signedIn ? (
              <Link href="/app" prefetch={false} className="btn btn-primary">Open dashboard</Link>
            ) : (
              <>
                <Link href="/app" prefetch={false} className="hide-sm">Sign in</Link>
                <Link href="/sign-up" className="btn btn-primary">Start free</Link>
              </>
            )}
          </nav>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="site-foot">
        <div className="wrap site-foot-row">
          <p className="site-foot-line">Monitoring for apps you built yourself, checked from {checkedFromNow()}.</p>
          <nav aria-label="Footer" className="site-foot-nav">
            <Link href="/pricing">Pricing</Link>
            <Link href="/scan">{isBuilt("scan") ? "Scan your app" : "The scan"}</Link>
            <a href={OWN_STATUS_PAGE} rel="noreferrer">Status</a>
            <Link href="/support">Support</Link>
            <a href={GITHUB_REPO} rel="noreferrer">GitHub</a>
            <Link href="/legal/terms">Terms</Link>
            <Link href="/legal/privacy">Privacy</Link>
          </nav>
        </div>
        <div className="wrap">
          <span className="site-word" aria-hidden="true">Staygreen</span>
          {building && <p className="t-meta proto-note">Staygreen is still being built. {building} The examples on this site use sample data.</p>}
        </div>
      </footer>
    </div>
  );
}
