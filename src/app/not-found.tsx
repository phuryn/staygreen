import type { Metadata } from "next";
import Link from "next/link";
import { SiteFrame } from "@/components/landing/SiteFrame";

// The site-wide 404: any address nothing matches, and any `notFound()` with no closer
// boundary, the dashboard's included (missing and not-yours are the same 404, `AGENTS.md
// § 1.1`). So the words fit a visitor and a signed-in builder alike, and both ways out are
// offered to everyone. Status pages have their own, in the builder's look (`(status)/`).

export const metadata: Metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <SiteFrame>
      <section className="wrap nf" aria-labelledby="nf-h">
        <p className="nf-code num" aria-hidden="true">404</p>
        <div className="nf-text">
          <h1 id="nf-h" className="lp-h2">There&rsquo;s nothing at this address</h1>
          <p className="lp-lead">The link may be mistyped, or what it pointed to has been deleted or isn&rsquo;t yours to see.</p>
          <div className="cluster">
            <Link href="/" className="btn btn-primary btn-lg">Go to the home page</Link>
            <Link href="/app" prefetch={false} className="btn btn-lg">Open your dashboard</Link>
          </div>
        </div>
      </section>
    </SiteFrame>
  );
}
