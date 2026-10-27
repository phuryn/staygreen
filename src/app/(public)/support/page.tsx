import type { Metadata } from "next";
import Link from "next/link";
import { ADDRESS_LINE, COMPANY, legalContactEmail } from "@/lib/legal";
import { AGENT_DOCS, NEW_ISSUE, OWN_STATUS_PAGE, SECURITY_REPORT } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Support",
  description: "How to report a bug or suggest a feature, and how to reach Staygreen about your account, your plan or your data.",
};

/** Bump when what the page says changes, not when the file does. */
const SUPPORT_UPDATED = "27 October 2026";

/* One page for everyone: the public footer and the app's rail both link here, so a member and a
   stranger get the same answers. Public questions go to the issue tracker, private ones to the
   mailbox, with the postal address when no mailbox is configured, as on the legal pages. The page
   reads no session (`AGENTS.md § 1.3`) and stays out of the index: the root layout's `noindex`
   holds, since `publicPageMetadata` opts in six pages only. */
export default function SupportPage() {
  const email = legalContactEmail();
  const contact = email ? <a href={`mailto:${email}`}>{email}</a> : <>{COMPANY.name}, {ADDRESS_LINE}</>;
  return (
    <div className="wrap band-tight">
      <article className="prose prose-doc">
        <h1 className="t-title">Support</h1>
        <p className="t-meta">Last updated {SUPPORT_UPDATED}</p>

        <h2>Report a bug or suggest a feature</h2>
        <p>
          Found a security problem? Don&rsquo;t open an issue: <a href={SECURITY_REPORT} rel="noreferrer">report it privately</a> on GitHub, or write to us (below).
        </p>
        <p>
          For anything else, <a href={NEW_ISSUE} rel="noreferrer">open an issue</a> in Staygreen&rsquo;s public issue tracker on GitHub. Say what you did, what you expected and what happened instead; the monitor type and the screen help.
        </p>
        <p>
          Issues are public. Never paste a secret, service-role or restricted key, a token, a webhook or heartbeat URL, a signing secret or a header value, whether Staygreen issued it or another service did. If you posted one, treat it as leaked: make sure the old value stops working wherever it is accepted, because issuing a new one doesn&rsquo;t always retire it; write to us if you&rsquo;re not sure how. For anything private, write to us instead.
        </p>

        <h2>Contact us</h2>
        <p>
          Write to {contact} about your account, your plan and billing, a specific monitor or status page, or anything you wouldn&rsquo;t post in public. Include your workspace&rsquo;s name.
        </p>

        <h2>Is Staygreen down?</h2>
        <p>
          Check <a href={OWN_STATUS_PAGE} rel="noreferrer">Staygreen&rsquo;s status page</a>. It runs on Staygreen itself, so if it doesn&rsquo;t load, or it shows everything working while Staygreen isn&rsquo;t, write to us.
        </p>

        <h2>Connect an agent</h2>
        <p>
          How to connect a coding agent to Staygreen&rsquo;s MCP server, with sign-in or with an API token, is in the <a href={AGENT_DOCS} rel="noreferrer">repository&rsquo;s README</a>.
        </p>

        <h2>Your data</h2>
        <p>
          To ask what we hold about you, or to have it corrected or deleted, use the contact above. What we store, for how long, and your rights are in our <Link href="/legal/privacy">privacy policy</Link>; the rules for using Staygreen are in our <Link href="/legal/terms">terms</Link>.
        </p>

        <h2>Company</h2>
        <p>{COMPANY.name}, {ADDRESS_LINE}.</p>
      </article>
    </div>
  );
}
