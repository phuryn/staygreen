import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/public-metadata";
import Link from "next/link";
import { Info } from "lucide-react";
import { PAYLOAD_LIMIT } from "../../../../../ingest/src/handler";
import { USER_AGENT } from "@/checks/types";
import { SNIPPET_BYTES } from "@/checks/mask";
import { checkedFromNow, cities, list, locationsNow } from "@/components/landing/plan-copy";
import { isBuilt } from "@/lib/launch";
import { ADDRESS_LINE, COMPANY, DPA, FAILED_CHECKS_KEPT, LEGAL_UPDATED, legalContactEmail } from "@/lib/legal";
import { legalDate, SHAPES_UNTIL } from "@/lib/agent-shapes";
import { CONFIRM_MAX_AGE_SEC } from "@/lib/alerts/links";
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE } from "@/lib/theme-cookie";

export const metadata: Metadata = {
  ...publicPageMetadata("/legal/privacy"),
  title: "Privacy policy",
  description: "What Staygreen stores, why, for how long, who processes it, and the rights you have over it under the GDPR.",
};

const THEME_DAYS = THEME_COOKIE_MAX_AGE / 86_400;
/** How long an added address's confirmation link works (`src/lib/alerts/links.ts`). */
const CONFIRM_DAYS = CONFIRM_MAX_AGE_SEC / 86_400;
/** "StaygreenBot/1.0", the product token of the checks' user agent. */
const BOT = USER_AGENT.split(" ")[0];
const bytes = (n: number) => n.toLocaleString("en-US");
/** What a failed DNS check keeps: every resolver's answers, as returned (`checkDns`, `detail`). */
const DNS_KEPT = "every answer each resolver returned, in full and not masked, since those are public DNS records";

/* The privacy policy, from AskOne's (the same company, `src/lib/legal.ts`).

   Every factual claim here is checked against the code that makes it true: the tables in
   `supabase/migrations/`, the masker in `src/checks/mask.ts`, the heartbeat receiver in
   `ingest/`, the cookie in `src/lib/theme-cookie.ts`. Numbers are read from the code that
   enforces them, and the locations from `locationsNow()`: only where checks can run today.

   The heartbeat receiver ships with the checks, and until then the monitor's page says nothing
   receives pings (`HeartbeatUrl.tsx`, gated on `built.probes`). This page says the same from the
   same flag: what a job sends, and Cloudflare, which runs the receiver, appear only once it does. A policy that described a product not yet built would be the most expensive
   kind of lie, so what isn't automatic says so, and `tests/unit/legal-pages.test.ts` fails when
   an area this page says isn't built ships, or when a processor appears in the code that the
   page doesn't name. The page reads no session (`AGENTS.md § 1.3`). */
export default function PrivacyPage() {
  const email = legalContactEmail();
  const receiving = isBuilt("probes");
  return (
    <div className="wrap band-tight">
      <article className="prose prose-doc">
        <h1 className="t-title">Privacy policy</h1>
        <p className="t-meta">Last updated {LEGAL_UPDATED}</p>

        <p>
          This policy explains what Staygreen stores, why, for how long, and what you can ask us to do about it. It describes what the software does today, and where something isn&rsquo;t automatic yet, it says so.
        </p>

        <h2>Who is responsible</h2>
        <p>
          <strong>{COMPANY.name}</strong>
          <br />
          {ADDRESS_LINE}
          <br />
          KRS {COMPANY.krs}, NIP {COMPANY.nip}, REGON {COMPANY.regon}
        </p>
        {email && (
          <p>
            Data protection enquiries: <a href={`mailto:${email}`}>{email}</a>
          </p>
        )}
        <p>
          {COMPANY.name} is the <strong>controller</strong> for the data described here. We have not appointed a Data Protection Officer; we are not required to.
        </p>

        <h2>Who Staygreen knows about</h2>
        <p>
          <strong>Builders</strong> sign in and set up apps, monitors and status pages in a workspace. <strong>Alert recipients</strong> get a workspace&rsquo;s alerts: its members by email, and the people and Telegram chats a member added. <strong>Visitors</strong> read a builder&rsquo;s status page without an account. Staygreen doesn&rsquo;t keep subscriber lists yet, so it holds no subscriber&rsquo;s address.
        </p>

        <h2>If you are a builder</h2>
        <p>
          Your account, meaning your email address, your name if your sign-in method provides one, how you sign in, and the workspaces you belong to, is held by <strong>Clerk</strong>, our sign-in provider, which also sends the emails that sign you in and records the browsers you sign in from to protect your account. Each workspace is a Clerk organization, and Clerk holds its name and its members too. Our own database stores only Clerk&rsquo;s identifiers: your organization&rsquo;s, on the workspace, and yours, beside each incident update you write, beside a count of the tests you ran recently, and beside each alert sent to you. We read your name from Clerk when an update&rsquo;s author is shown, and your email address and time zone when an alert is sent to you, and never copy them into our database.
        </p>
        <p>What a workspace holds:</p>
        <p>Stripe and Supabase monitors store your supplied key encrypted with AES-256-GCM, never display it again, and delete it with the monitor. Requests send it only to Stripe&apos;s API or your named Supabase project. Stripe supplies event payloads during a poll; Staygreen discards their customer data and keeps only event identifiers needed for recovery, types, counts, creation times and endpoint status in failure evidence. Supabase response bodies are discarded; only service status and a refused-check marker are kept. These vendors process requests under your account with them.</p>
        <ul>
          <li>
            <strong>Apps</strong>: a name, an address, a logo and a brand colour. A logo is an image you choose, or your app&rsquo;s own site icon when Staygreen suggests its checks; either way only its pixels are kept, at two sizes, with no metadata. The colour is the one found on your app&rsquo;s site when Staygreen suggests its checks, and a new status page starts with it.
          </li>
          <li>
            <strong>Monitors</strong>: a name, what each checks (an address, a host and port, or a DNS record), its schedule, the keyword and assertions it looks for, and whether it is paused. <strong>Header values you add to a monitor are encrypted (AES-256-GCM) before they are stored</strong>, are never shown again, and are deleted with the monitor.
          </li>
          <li>
            <strong>Heartbeat URLs</strong>: a hash of each heartbeat&rsquo;s token, which is how its pings are recognised, and an encrypted copy, so your workspace&rsquo;s admins can see the URL again on the monitor&rsquo;s page.
          </li>
          <li>
            <strong>Check results</strong>, which are never stored one by one. For each monitor we keep 5-minute summaries from each location (how many checks ran, how many failed, and their response times), a total for each day, every change of state, and the last {FAILED_CHECKS_KEPT} failed checks, each with its reason and what the check saw: for an HTTP check, the status and at most {bytes(SNIPPET_BYTES)} bytes of the response, masked (below); for a certificate, its expiry, issuer and name; for a DNS record, {DNS_KEPT}.
          </li>
          <li>
            <strong>Incidents</strong>: when each opened, was acknowledged and closed, the locations that saw it, the request, why it failed (for a DNS record, with the answers a resolver returned), the assertion that failed and what it got, and the masked snippet of the response; and the updates you write, with their author&rsquo;s Clerk identifier. An update stays private until you publish it.
          </li>
          {receiving ? (
            <li>
              <strong>What your jobs send to a heartbeat</strong>: only the newest ping, the newest <code className="code">/start</code> and the newest <code className="code">/fail</code>, each with when it arrived and its fields, cut to {bytes(PAYLOAD_LIMIT)} bytes. Each replaces the one before it of its kind. We also count the runs that have finished and the pings that arrived in the current minute, which is how a job stuck in a loop is held to a limit.
            </li>
          ) : (
            <li>
              <strong>What your jobs send to a heartbeat</strong>: nothing yet. Nothing receives heartbeat pings yet, so nothing a job sends reaches Staygreen.
            </li>
          )}
          <li>
            <strong>Alerts</strong>: where they go, and a receipt for every message. For the members&rsquo; email, a receipt holds the member&rsquo;s Clerk identifier, never their address, and the workspace keeps the identifiers of members who turned their own alert email off. An address a member added is stored as typed, with who added it and when it was confirmed or unsubscribed; until it is confirmed, only a hash of its confirmation link is kept. A Telegram chat is stored as Telegram&rsquo;s identifier for it and the name Telegram gave us when it was connected: a group&rsquo;s title, or the person&rsquo;s @username or name. Each receipt holds what it was about, when it was sent or why not, and the message&rsquo;s identifier at Postmark or Telegram. Email and chat message text is built again from the incident. A signed webhook keeps its masked payload on the receipt for consistent retries.
          </li>
          <li>
            <strong>Status pages</strong>: a name, an address, logo text, a homepage link (at first, the app&rsquo;s address), a colour and a theme, an uploaded logo and favicon (only their pixels), and the components you put on the page with the monitors behind each.
          </li>
        </ul>
        <p>
          <strong>Masking.</strong> Before {receiving ? <>a response snippet, the value an assertion got, or a heartbeat&rsquo;s fields are</> : "a response snippet or the value an assertion got is"} stored, one masker replaces email addresses, bearer tokens, JWTs, API keys, long hex or base64 strings, values under names such as <code className="code">password</code> or <code className="code">token</code>, and your monitor&rsquo;s own header values with &bull;&bull;&bull;. It works by recognising patterns, so keep personal data out of the responses you monitor{receiving && " and the fields your jobs send"} rather than relying on it. DNS answers aren&rsquo;t masked.
        </p>
        <p>
          <strong>What checks send, and from where.</strong> The servers that run checks send requests from {checkedFromNow()}, to the targets you add, on each monitor&rsquo;s schedule: an HTTP request with the method and headers you set, a TCP connection, or a TLS handshake to read a certificate. HTTP requests identify themselves as <code className="code">{BOT}</code>, unless you set a <code className="code">User-Agent</code> header of your own, which replaces it. They send the headers you stored, a <code className="code">Cookie</code> header too if you stored one. Cookies set by a response are used only within that check&rsquo;s redirect chain, respecting their domain, path and HTTPS scope; they are never kept across checks or logged, and their values are masked wherever a response&rsquo;s headers are shown. The site you monitor sees those requests and our servers&rsquo; IP addresses, as it would any visitor&rsquo;s. A DNS monitor asks Cloudflare&rsquo;s and Google&rsquo;s public resolvers for the record you name. When you test a monitor before saving it, or Staygreen suggests an app&rsquo;s checks from its address, the requests go from our hosting provider&rsquo;s servers instead, each time you do it, within the dashboard&rsquo;s limit on tests; what comes back is shown to you and not stored, except a site icon kept as the app&rsquo;s logo and the brand colour found on its site, kept with the app. The <Link href="/bot">StaygreenBot page</Link> says what each check sends.
        </p>
        {!isBuilt("probes") && <p>Scheduled checks haven&rsquo;t started for new workspaces yet: until they do, a monitor you add isn&rsquo;t checked and has no results.</p>}
        <p>
          <strong>Legal basis:</strong> performance of a contract (Art. 6(1)(b) GDPR). You asked us to watch your apps and publish what you choose.
        </p>

        <h2>If you get alerts</h2>
        <p>
          A workspace&rsquo;s members who can see its monitors get its alerts at the email address their Clerk account holds, with times in the time zone Clerk has for them, or in UTC. An alert names the app and the monitor, says what failed with the masked evidence and the locations that saw it, and links to the incident and the status page; a second message follows when it recovers. Someone without an account gets alerts only at an address a member added, and only after confirming it from the one email we send there first; an address not confirmed within {CONFIRM_DAYS} days gets nothing more unless a member sends it a new link. A Telegram chat gets alerts once a member opens a one-time link in it and presses Start.
        </p>
        <p>
          <strong>Stopping them.</strong> Every alert email has a link that stops them, with no sign-in, and mail apps that offer their own unsubscribe button use the same link. A member can turn their alert email back on in the dashboard. Sending <code className="code">/stop</code> in a Telegram chat, or removing the bot from it, stops alerts there.
        </p>
        <p>
          <strong>Legal basis:</strong> for members and the chats they connect, performance of a contract (Art. 6(1)(b) GDPR); for an address without an account, your consent (Art. 6(1)(a) GDPR), given by confirming and withdrawn by unsubscribing, which takes effect at once.
        </p>

        <p><strong>Custom domains</strong>: we store the hostname you attach to a status page, its CNAME target, when it was added and verified, and the DNS monitor that checks its CNAME. Unverified claims expire after seven days. Our status hosting provider serves public snapshots and their images; our certificate provider receives your hostname to issue HTTPS certificates, whose names appear in public certificate transparency logs. Members-only pages require workspace sign-in and have no public summary or badge. Subscriber lists remain Coming soon.</p>
        <h2>If you visit a status page</h2>
        <p>
          <strong>A status page is public.</strong> Anyone with its address can read it, and its README badge, which shows the page&rsquo;s name and overall state, appears wherever the builder put it. The page shows its name and logo, a link to the homepage the builder sets, its components with their state and daily uptime, and incidents with the updates the builder published. A new page starts with its app&rsquo;s address as that homepage, which is often an address one of its monitors checks. Otherwise it shows no monitor&rsquo;s address, settings or headers, and no unpublished update. What it says is the builder&rsquo;s.
        </p>
        <p>
          Staygreen records nothing about you when you read one: you need no account, we set no cookie of ours, and our database holds no IP address. Our hosting provider handles the request and, like any web host, sees your IP address. Like every page on Staygreen&rsquo;s own site, a status page loads Clerk&rsquo;s scripts from Clerk, which therefore sees your IP address too and can set the cookies described below. <strong>Legal basis:</strong> our legitimate interest (Art. 6(1)(f) GDPR) in serving the page and keeping the site secure.
        </p>

        <h2>The one-time scan and embedded widget</h2>
        <p>The public scan needs no account. It sends the app address to our checker and reads public responses, registry expiry information and, only when supplied, the service identified by your restricted Stripe or Supabase publishable key. Keys and results are used for that response only, never stored or logged. We keep short-lived abuse counters under a keyed hash of the caller&apos;s IP address, or its authenticated credential identity, with a shared global counter. They expire after at most ten minutes and are removed during subsequent admissions. Raw IP addresses are not stored in our database. The websites, registries and services contacted see the checker&apos;s request. Our legitimate interest in providing the requested check and preventing abuse is the legal basis.</p>
        <p>The embedded widget reads only a public status summary. It sends no cookies or referrer, performs no fingerprinting and uses no analytics. Dismissing a banner stores its published update id in localStorage on the host app&apos;s origin, until another dismissal replaces it or you clear that storage. Only published updates appear. Members-only pages have no public widget, summary or badge.</p>
        <h2>Cookies and browser storage</h2>
        <p>
          <strong>Staygreen uses essential cookies only.</strong> There is no cookie banner because there is nothing to consent to: no advertising, analytics or cross-site tracking cookies.
        </p>
        <ul>
          <li>
            <strong><code className="code">{THEME_COOKIE}</code></strong> remembers Light, Dark or System when you choose a theme in Settings. It holds only that word, lasts {THEME_DAYS} days and is SameSite=Lax. It is a first-party preference cookie with no identifier in it, and needs no consent banner.
          </li>
          <li>
            <strong>Clerk&rsquo;s cookies</strong> keep you signed in and protect sign-in. Clerk&rsquo;s scripts, which include its protection against automated sign-ups, run on every page of Staygreen&rsquo;s own site, including status pages served at our own site address, so some of its cookies are set before you ever sign in: on our address, one that records whether this browser is signed in, and on Clerk&rsquo;s own address, security cookies of the network in front of it, such as Cloudflare&rsquo;s <code className="code">__cf_bm</code>. Staygreen&rsquo;s own code reads one, <code className="code">__client_uat</code>, on the public pages, only to choose whether the header&rsquo;s button says Sign in or Open dashboard; both open the same page.
          </li>
          <li>
            <strong>Session storage.</strong> In the dashboard, the app you chose in the app switcher is kept in this tab&rsquo;s session storage, as your workspace&rsquo;s and the app&rsquo;s identifiers, so a reload keeps it. A new tab starts on all apps, and it goes when the tab closes.
          </li>
        </ul>
        <p>Staygreen runs no analytics: no script that records how its pages are used is loaded.</p>

          <h2>Who else processes it</h2>
          <p>When you connect Slack or Discord, that service receives the channel identifier and alert messages, including masked evidence and links. A signed webhook sends the same information to the endpoint you choose, under your arrangement with its operator.</p>
        <ul>
          <li>
            <strong>Clerk</strong>: accounts, workspaces, sign-in, its emails and the scripts every page loads{isBuilt("billing") ? ", and subscription billing" : ", and, once Builder is on sale, its billing"}.
          </li>
          <li>
            <strong>Supabase</strong>: the database, holding everything a workspace holds, listed above.
          </li>
          <li>
            <strong>Our hosting provider</strong>: serves Staygreen&rsquo;s site, the dashboard and status pages, and runs the tests and suggested checks you start from the dashboard.
          </li>
          <li>
            <strong>The servers that run checks</strong>, in {list(cities(locationsNow()))}, and the provider we rent them from: they read each monitor&rsquo;s settings and its encrypted headers, open the headers only to send the request, and write the results described above.
          </li>
          {receiving && (
            <li>
              <strong>Cloudflare</strong>: runs the address your scheduled jobs ping and passes each ping to the database. It sees the calling server&rsquo;s IP address and what the job sends, before it is masked.
            </li>
          )}
          <li>
            <strong>Anthropic</strong>: when Staygreen suggests an app&rsquo;s checks, its model may be asked to pick the app&rsquo;s brand colour among those found on the app&rsquo;s site and to propose checks for its health routes. It receives the app&rsquo;s host, those colours and at most two of the app&rsquo;s public health responses, with anything that looks like a secret masked; nothing about you or your workspace.
          </li>
          <li>
            <strong>Postmark</strong>: sends alert email, and the email that asks an added address to confirm. It receives each recipient&rsquo;s address and the message: the app&rsquo;s and monitor&rsquo;s names, what failed with the masked evidence, and the links. Open and link tracking are off.
          </li>
          <li>
            <strong>Telegram</strong>: delivers alerts to the chats connected to a workspace. It receives the chat&rsquo;s identifier and each message, and passes us the chat&rsquo;s name when it is connected and the commands sent to the bot.
          </li>
          <li>
            <strong>Stripe</strong>, through Clerk, if you buy Builder. We never see or store your card details.
          </li>
        </ul>
        <p>
          Each is a processor acting on our instructions under a data processing agreement. Where any of them processes data outside the European Economic Area, that transfer relies on the European Commission&rsquo;s Standard Contractual Clauses.
        </p>

        <h2>When you connect a coding agent</h2>
        <p>Clerk handles OAuth sign-in and consent. We verify the selected workspace and current membership on each call and store no OAuth access or refresh tokens. Your agent receives workspace monitoring data and can create monitors, pause them briefly and draft updates if its access allows it. The client you choose processes that data under its own terms.</p>
        <p>API tokens have a name and scope, a public identifier and a keyed hash; the secret value is shown once and is never stored. Revocation leaves a tombstone. Writes keep an activity record with the client name and resource identifier, plus a retry receipt with a keyed input fingerprint and the result. A provisioning receipt can include encrypted copies of the new heartbeat credentials, so the creating request can recover a lost reply; existing heartbeat credentials are not exposed to agents. Call logs record method, tool, result code, duration, client and a workspace or hashed actor identifier when known, including refused calls. They contain no request arguments, tokens, IP addresses or response bodies. Until {legalDate(SHAPES_UNTIL)}, a call to the MCP endpoint also records its shape, so we can learn what agent clients send: the names of its headers, parameters and metadata fields, never their values; the name, version and protocol version the client declares; the product names in its user agent; whether the calling address is one OpenAI publishes for ChatGPT, never the address; and an OAuth access token&rsquo;s age, lifetime and scope names, never the token. Admission counters use keyed identifiers.</p>
        <p>These records and the hourly and daily response-time summaries currently have no scheduled deletion. Workspace records are deleted with the workspace; counters and unattributed call logs are removed on request. Revoking a token stops its use but does not erase its activity.</p>

        <h2>How long we keep it</h2>
        <ul>
          <li>
            <strong>Your account</strong> is kept until it is deleted: by you, where Clerk&rsquo;s account settings offer it, or by us on request.
          </li>
          <li>
            <strong>What a workspace holds</strong> is kept until a member deletes it. Deleting a monitor deletes its headers, check results, incidents{receiving ? ", updates and heartbeat fields" : " and updates"} at once. Deleting an app deletes its monitors, its status page and its logo. Deleting a status page deletes its images, and its address stops answering.
          </li>
          <li>
            <strong>Check results</strong>: the 5-minute summaries, daily totals and changes of state are kept as long as their monitor. A monitor keeps its last {FAILED_CHECKS_KEPT} failed checks, and an older one is deleted when a newer one arrives.
          </li>
          {receiving && (
            <li>
              <strong>A heartbeat&rsquo;s fields</strong>: the newest of each kind, until the next one replaces it.
            </li>
          )}
          <li>
            <strong>Test counts</strong>, and counts of test alerts and confirmation emails: one per member and one per workspace, started again with each window, kept while the workspace exists.
          </li>
          <li>
            <strong>Alert receipts</strong> are kept as long as their incident, and a test&rsquo;s as long as the workspace. A removed channel&rsquo;s receipts stay in the list without it.
          </li>
          <li>
            <strong>Call shapes</strong> are recorded until {legalDate(SHAPES_UNTIL)} and kept with the call logs they belong to, until we remove them.
          </li>
          <li>
            <strong>An added address, chat or webhook channel</strong> is kept until a member removes it, unsubscribed, stopped or never confirmed included. Removing it deletes it at once.
          </li>
        </ul>
        <div className="callout callout-info">
          <Info aria-hidden="true" />
          <p>
            <strong>Being straight with you about deletion:</strong> nothing in Staygreen deletes on a schedule yet, so check results stay until their monitor is deleted. Deleting a whole workspace isn&rsquo;t built either, and deleting your account or your organization in Clerk doesn&rsquo;t delete what the workspace holds from our database: its monitors stay stored, its status pages stay public, and your Clerk identifier stays beside the incident updates you wrote and the alerts sent to you. In the meantime we delete on request, promptly, and you should ask (below).
          </p>
        </div>

        <h2>Your rights</h2>
        <p>Under the GDPR you may ask us to:</p>
        <ul>
          <li>tell you what we hold about you, and give you a copy (Art. 15);</li>
          <li>correct anything inaccurate (Art. 16);</li>
          <li>delete it (Art. 17);</li>
          <li>restrict what we do with it (Art. 18);</li>
          <li>hand it over in a portable form (Art. 20);</li>
          <li>object to processing based on legitimate interest (Art. 21).</li>
        </ul>
        <p>
          There is no charge, and we answer within one month. Write to us at the address above
          {email ? (
            <>
              {" "}
              or at <a href={`mailto:${email}`}>{email}</a>
            </>
          ) : null}
          . If you have only read status pages, we hold nothing about you to give back.
        </p>
        <p>
          You also have the right to complain to a supervisory authority. Ours is the <strong>{DPA.name}</strong>, {DPA.address}, <a href={DPA.url} rel="noreferrer">{DPA.url}</a>.
        </p>

          <h2>Security</h2>
          <p>Slack bot tokens, Discord webhook URLs and signed-webhook URLs and signing secrets are encrypted before storage, never shown after saving, and deleted when their channel is removed. A Slack installation keeps only a hash of its one-use connection state, bound to the member and workspace, for validation within ten minutes; consumed states are deleted and expired ones are cleaned up when that workspace starts another installation. Signed-webhook receipts retain the masked JSON payload so every retry carries the same event.</p>
        <p>
          Only our servers talk to the database, and no key that could read it is ever sent to a browser. Row-level security is on for every table with no policies, so a leaked public key reads nothing. The servers that run checks{receiving && " and the heartbeat receiver"} connect with database roles of their own, which can call only the functions they need and can&rsquo;t read a table directly. Header values and heartbeat URLs are encrypted with AES-256-GCM, and every change you make is checked on the server against the workspace that owns it.
        </p>

        <h2>Children</h2>
        <p>Staygreen is a tool for people who build software, and isn&rsquo;t directed at children under 16.</p>

        <h2>Changes</h2>
        <p>
          If this policy changes, we update the date at the top, and tell workspace admins by email before a material change applies. The <Link href="/legal/terms">terms of service</Link> are the other half of this.
        </p>
      </article>
    </div>
  );
}
