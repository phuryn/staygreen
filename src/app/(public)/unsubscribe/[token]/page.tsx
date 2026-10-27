import type { Metadata } from "next";
import { LinkAction } from "@/components/alerts/LinkAction";
import { unsubscribeTokenValid } from "@/lib/alerts/public";
import { unsubscribeAlerts } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Stop alerts", robots: { index: false, follow: false } };

/* Every alert email's "Stop these emails" link (`docs/emails.md § Unsubscribe`). No sign-in: the
   link names one receipt and is signed, so it can stop only what that receipt reached. Opening it
   changes nothing (a mail scanner opens links too); the button does. Mail apps that offer their
   own unsubscribe use the one-click address in the List-Unsubscribe header instead. */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = unsubscribeTokenValid(token);
  return (
    <div className="wrap band-tight">
      <div className="prose prose-doc stack">
        <h1 className="t-title">Stop Staygreen alerts</h1>
        {valid ? (
          <>
            <p>This stops the alert emails that reached you through this message, for the workspace that sent them. Other people who get them keep getting them.</p>
            <LinkAction action={unsubscribeAlerts.bind(null, token)} label="Stop these alerts" />
          </>
        ) : (
          <p>This link isn&rsquo;t one Staygreen made, or part of it is missing. Open the link from the email again, or use your mail app&rsquo;s own unsubscribe.</p>
        )}
      </div>
    </div>
  );
}
