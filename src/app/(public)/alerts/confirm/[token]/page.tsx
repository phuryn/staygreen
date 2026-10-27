import type { Metadata } from "next";
import { LinkAction } from "@/components/alerts/LinkAction";
import { isConfirmToken } from "@/lib/alerts/links";
import { confirmAlerts } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Confirm alerts", robots: { index: false, follow: false } };

/* The link in the confirmation email an address that isn't a member's gets (`docs/emails.md`).
   Until it is pressed here the address gets nothing. Opening the link changes nothing, because
   mail scanners open links; the button confirms. */
export default async function ConfirmAlertsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <div className="wrap band-tight">
      <div className="prose prose-doc stack">
        <h1 className="t-title">Get Staygreen alerts here?</h1>
        {isConfirmToken(token) ? (
          <>
            <p>A member of a Staygreen workspace asked to send its uptime alerts to this address. Confirm, and they arrive here when something it monitors goes down and when it recovers. Every alert has a link to stop them.</p>
            <LinkAction action={confirmAlerts.bind(null, token)} label="Confirm alerts" />
          </>
        ) : (
          <p>This link isn&rsquo;t one Staygreen made, or part of it is missing. Open it from the email again.</p>
        )}
      </div>
    </div>
  );
}
