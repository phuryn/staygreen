import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/public-metadata";
import Link from "next/link";
import { Info } from "lucide-react";
import { checkedFromNow } from "@/components/landing/plan-copy";
import { isBuilt } from "@/lib/launch";
import { ADDRESS_LINE, COMPANY, TERMS_UPDATED, REFUND_IF_CLOSED, legalContactEmail } from "@/lib/legal";

export const metadata: Metadata = {
  ...publicPageMetadata("/legal/terms"),
  title: "Terms of service",
  description: `The agreement between you and ${COMPANY.name} for using Staygreen.`,
};

/** What a reader can't rely on yet, read from what this build runs (`src/lib/launch.ts`). Each
 *  sentence goes the day its area is built, with nothing to edit here. */
function notRunningYet(): string[] {
  const out: string[] = [];
  // The heartbeat receiver ships with the checks; the monitor's page says the same from the same
  // flag (`HeartbeatUrl.tsx`).
  if (!isBuilt("probes")) out.push("Scheduled checks haven’t started for new workspaces yet, so a monitor you add isn’t checked until they do, and nothing receives heartbeat pings yet, so no heartbeat opens an incident.");
  if (!isBuilt("alerts")) out.push("Staygreen doesn’t send alerts yet.");
  return out;
}

/* Terms of service, from AskOne's (the same company, `src/lib/legal.ts`). Short on purpose:
   every clause is one we would enforce, and what Staygreen stores, for how long and what you can
   ask back lives in the privacy policy. Every sentence about what Staygreen does is checked
   against the code, and a sentence that is true only until an area ships reads `isBuilt`. The
   page reads no session (`AGENTS.md § 1.3`). */
export default function TermsPage() {
  const email = legalContactEmail();
  const pending = notRunningYet();
  return (
    <div className="wrap band-tight">
      <article className="prose prose-doc">
        <h1 className="t-title">Terms of service</h1>
        <p className="t-meta">Last updated {TERMS_UPDATED}</p>

        <p>
          These terms are the agreement between you and <strong>{COMPANY.name}</strong>, {ADDRESS_LINE} (KRS {COMPANY.krs}, NIP {COMPANY.nip}, REGON {COMPANY.regon}), &ldquo;we&rdquo;, for your use of Staygreen. By creating an account, you accept them.
        </p>

        <h2>1. What Staygreen is</h2>
        <p>
          A monitoring service for apps you build. You add an app and the monitors that watch it. Staygreen checks each monitor&rsquo;s target on its schedule from {checkedFromNow()}, records what it found, and opens an incident when a failure is confirmed, which it sends as an alert by email and to the Telegram chats you connect, with another when it recovers. A heartbeat monitor works the other way round: your scheduled job calls a URL Staygreen gives you, and a run that is missed, fails or gets stuck opens one. You can publish a status page that shows your users the state of what you choose to put on it.
        </p>
        {pending.length > 0 && <p>{pending.join(" ")}</p>}

        <p>The one-time scan reads public app responses and optional service health using the credentials you supply. It creates no monitors and is not a security audit or a guarantee that everything works. Unknown or skipped checks mean no conclusion was reached. Supply only credentials you are authorized to use. The widget shows published status data; if that data is unreachable, it shows nothing.</p>
        <h2>2. Accounts</h2>
        <ul>
          <li>You sign in through Clerk, our sign-in provider. Your account works inside a workspace, and a new account gets a workspace of its own.</li>
          <li>Keep your sign-in to yourself. You are responsible for what happens under your account.</li>
          <li>You can authorize a coding agent through Clerk or give a pipeline a workspace API token. Choose its access carefully and keep tokens private. Its permitted changes act for your workspace; incident updates it drafts still need you to publish them.</li>
          <li>A workspace&rsquo;s admins decide who joins it, and are responsible for what the workspace monitors and publishes.</li>
          <li>You must be at least 16, or have your guardian&rsquo;s permission.</li>
        </ul>

        <h2>3. What you monitor, and your content</h2>
        <p>
          <strong>Monitor only what you run, or are allowed to test.</strong> Checks send requests to the targets you add, on the schedule you set, from the locations above, and a test or a suggested check you start from the dashboard sends one from our hosting provider&rsquo;s servers. You are responsible for having the right to send them. Staygreen refuses targets on private networks.
        </p>
        <p>
          What you put into Staygreen stays yours: names, addresses, incident updates, images, and what your jobs send. You give us only the permission we need to run the service: to store it, to use it to check your targets, to show it to your workspace, to publish what you choose to publish, and to pass it to the processors named in our <Link href="/legal/privacy">privacy policy</Link>.
        </p>
        <p>
          <strong>A status page is public unless you make it members-only.</strong> Anyone who has its address can read it: its name and logo, a link to the homepage you set (at first, your app&rsquo;s address), the components you put on it with their state and daily uptime, and every incident update you publish. So can anyone who sees its README badge, which shows the page&rsquo;s name and its overall state. An update you haven&rsquo;t published, and a monitor you haven&rsquo;t put on the page, never appear there. Members-only pages require sign-in to their workspace and have no public summary or badge. Attach only a custom domain you control; its certificate records are public. Making a page private cannot recall copies someone already saved while it was public.
        </p>
        <p>
          <strong>Alerts go where you send them.</strong> Every member of a workspace who can see its monitors gets its alerts by email. Add someone else&rsquo;s email address, or connect a Telegram chat other people are in, only with their agreement: an address gets nothing until its owner confirms it, and anyone who gets an alert can stop them from the alert itself.
        </p>
        <p>
          <strong>A heartbeat&rsquo;s URL is its only credential.</strong> Anyone who has it can report for your job. Keep it like a password, and make a new one if it leaks: the old one stops working at once.
        </p>

        <p>Connect only Stripe accounts and Supabase projects you may monitor. Supply a restricted Stripe key with Events and Webhook Endpoints read access only, or a Supabase publishable key. Stripe delivery alerts cover the account, not a particular endpoint. A Supabase name that stops resolving may be paused or deleted; health checks alone do not keep its database awake.</p>

        <h2>4. What you may not do</h2>
        <ul>
          <li>Break the law, or use Staygreen to harass, threaten or defame anyone.</li>
          <li>Point monitors at systems you aren&rsquo;t allowed to test, or use Staygreen to flood, scan or attack anyone&rsquo;s service.</li>
          <li>Publish on a status page someone else&rsquo;s personal data, or anything you have no right to publish.</li>
          <li>Use alerts to send email or messages to anyone who hasn&rsquo;t agreed to get them.</li>
          <li>Attempt to reach a workspace or account that isn&rsquo;t yours, or to work around a plan limit or a rate limit.</li>
          <li>Attack Staygreen itself: flooding it, scraping it at scale, probing it for vulnerabilities without our written permission, or interfering with anyone else&rsquo;s use of it.</li>
          <li>Resell access to Staygreen.</li>
        </ul>
        <p>We may remove content from a status page, or suspend a workspace, that breaks these terms or the law, and we will say why when we can.</p>

        <h2>5. Plans and payment</h2>
        <p>The limits for your plan are the ones listed on the <Link href="/pricing">pricing page</Link>.</p>
        <ul>
          <li>
            The Free plan allows commercial use. No card is required, and it doesn&rsquo;t expire.
          </li>
          <li>
            The Builder plan adds more apps and monitors, faster checks and the features listed on the <Link href="/pricing">pricing page</Link>; anything marked Coming soon there isn&rsquo;t part of it yet.{!isBuilt("billing") && " It isn’t on sale yet, and nothing takes payment. When it is, the rest of this section applies."}
          </li>
          <li>Builder is billed by Clerk through Stripe, and we never see your card details. Prices are in US dollars, and the price Clerk&rsquo;s checkout shows before you pay is what you are charged.</li>
          <li>Cancel at any time; Builder runs to the end of the period you paid for. Statutory consumer withdrawal rights are unaffected.</li>
          <li>If we change a price, we tell you before it applies to you, and you may cancel instead.</li>
          <li><strong>{REFUND_IF_CLOSED}</strong></li>
        </ul>

        <h2>6. Keeping your data</h2>
        <p>
          Deleting a monitor, an app or a status page deletes it at once, with everything under it; the <Link href="/legal/privacy">privacy policy</Link> says what that is. Deleting a whole workspace isn&rsquo;t built yet, and deleting your account or your organization in Clerk doesn&rsquo;t delete what the workspace holds, so its status pages would stay public. Until it is built, we delete a workspace on request.
        </p>

        <h2>7. Availability</h2>
        <p>
          We work to keep Staygreen up but don&rsquo;t promise uninterrupted service on any plan, and we may take it down for maintenance. There is no service level agreement unless we have signed one with you.
        </p>
        <p>
          A monitoring service can miss a failure, report one that isn&rsquo;t there, or report late. Don&rsquo;t make Staygreen the only thing that tells you about a failure that could harm someone.
        </p>

        <h2>8. Liability</h2>
        <div className="callout callout-info">
          <Info aria-hidden="true" />
          <p>
            Staygreen is provided as it is. To the extent the law allows, we are not liable for indirect or consequential loss, lost profits or lost data, including loss from a check that didn&rsquo;t run, a failure Staygreen didn&rsquo;t report, or a status page that showed the wrong state. Our total liability in any twelve-month period is limited to what you paid us in that period. Nothing here limits liability for death or personal injury caused by negligence, for intentional harm, or any other liability that can&rsquo;t be limited under Polish law, and if you are a consumer, your statutory rights are unaffected.
          </p>
        </div>

        <h2>9. Ending it</h2>
        <p>
          You may stop using Staygreen at any time. We may suspend or close a workspace that breaks these terms or the law. When a workspace is closed, what it holds is deleted as the privacy policy describes.
        </p>

        <h2>10. Law and disputes</h2>
        <p>
          Polish law governs these terms, and the courts of Warsaw have jurisdiction. If you are a consumer, this doesn&rsquo;t deprive you of the protection of the mandatory law of the country you live in, and you may bring proceedings where you live.
        </p>

        <h2>11. Changes</h2>
        <p>
          We may update these terms. The date at the top changes with them, and we tell workspace admins by email before a material change applies to them. Continuing to use Staygreen after that means you accept them.
        </p>

        <h2>12. Contact</h2>
        <p>
          {COMPANY.name}, {ADDRESS_LINE}
          {email ? (
            <>
              , or <a href={`mailto:${email}`}>{email}</a>
            </>
          ) : null}
          .
        </p>
      </article>
    </div>
  );
}
