import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/public-metadata";
import Link from "next/link";
import { MAX_BODY_BYTES, MAX_REDIRECTS } from "@/checks/http";
import { RESOLVERS } from "@/checks/dns";
import { USER_AGENT } from "@/checks/types";
import { checkedFromNow, every, list } from "@/components/landing/plan-copy";
import { isBuilt } from "@/lib/launch";
import { ADDRESS_LINE, COMPANY, legalContactEmail } from "@/lib/legal";
import { DNS_INTERVAL_SEC, METHODS, SSL_INTERVAL_SEC } from "@/lib/monitor-input";
import { PAGE_ASSET_LIMIT } from "@/lib/page-assets";
import { limits } from "@/lib/plans";
import { TEST_BUDGET } from "@/lib/budgets";
import { HEALTH_BODY_BYTES } from "@/lib/health-body";
import { AT_ONCE, ICON_TRIES, MANIFEST_BYTES, PAGE_BYTES, SCRIPT_BYTES, SCRIPTS, STYLESHEET_BYTES, STYLESHEETS } from "@/lib/suggestion-checks";
import { HEALTH_PATHS } from "@/lib/suggestions";
import { MAX_DEPENDENCIES } from "@/lib/dependency-detect";

export const metadata: Metadata = {
  ...publicPageMetadata("/bot"),
  title: "StaygreenBot",
  description: "What StaygreenBot, Staygreen's checker, sends, where it comes from, how often, and how to have it stop checking your address.",
};

/** Bump when what the page says changes, not when the file does. */
const BOT_UPDATED = "24 October 2026";

/** What a failed check takes before it counts (`probe/runtime.ts`, the pause before a second
    look from the same probe; `probe/state.ts`, `DNS_DOWN_AFTER`). The probe isn't imported into a
    page, so `tests/unit/legal-pages.test.ts` reads both from its source. */
const RECHECK_AFTER_SEC = 20;
const DNS_FAILS_IN_A_ROW = 2;

const F = limits.free;
const B = limits.builder;
/** Who the public resolvers are, by the name their owners use. */
const RESOLVER_NAME: Record<(typeof RESOLVERS)[number]["id"], string> = { cloudflare: "Cloudflare", google: "Google" };

/* The address in the checks' user agent (`USER_AGENT`, `src/checks/types.ts`): what a site's
   owner finds when they look up the visitor in their logs. Every fact is read from the code that
   makes it true (the checks in `src/checks/`, the schedules in `src/lib/monitor-input.ts`, the
   plans in `src/lib/plans.ts`), and `tests/unit/legal-pages.test.ts` holds it there, including
   that the user agent still names a route that exists. No IP address is listed: they would name
   the provider the servers run on, which no page does (`AGENTS.md § 2.3`; `BACKLOG.md`). The
   page reads no session (`AGENTS.md § 1.3`). */
export default function BotPage() {
  const email = legalContactEmail();
  return (
    <div className="wrap band-tight">
      <article className="prose prose-doc">
        <h1 className="t-title">StaygreenBot</h1>
        <p className="t-meta">Last updated {BOT_UPDATED}</p>

        <p>
          StaygreenBot is the checker of Staygreen, a monitoring service for apps people build. It visits the addresses a Staygreen user added to a monitor, to tell them whether their app is up and working. When a user adds an app, it also reads the app&rsquo;s address, a few common health routes on its site and some of what its page links to, to suggest checks (below). If it reached you, someone added your address, or an app whose page links to it. It doesn&rsquo;t crawl and doesn&rsquo;t read <code className="code">robots.txt</code>.
        </p>
        <p>
          Its requests carry the user agent <code>{USER_AGENT}</code>, unless the user who added the address set a <code className="code">User-Agent</code> header of their own, which replaces it.
        </p>

        <h2>Where it comes from</h2>
        <p>
          Scheduled checks come from servers in {checkedFromNow()}. Each check runs from one of them in turn. An HTTP or TCP check that fails, or a certificate that can&rsquo;t be reached, is made again at once from another of them, or about {RECHECK_AFTER_SEC} seconds later from the same server when no other is running, and only a second failure counts. A certificate that is invalid counts at once, and a DNS record counts once {DNS_FAILS_IN_A_ROW} checks in a row fail, since the resolvers answer the same from anywhere. The servers&rsquo; IP addresses aren&rsquo;t published; the user agent is how to recognise a check.
        </p>
        {!isBuilt("probes") && <p>Scheduled checks haven&rsquo;t started for new workspaces yet.</p>}
        <p>
          A Staygreen user can also test a monitor before saving it, or have Staygreen suggest checks for an app&rsquo;s address. Those requests are sent when the user acts: a test once, and a suggestion each time the user adds the app, changes its address or opens its suggested checks, together at most {TEST_BUDGET.member.limit} times in {TEST_BUDGET.member.windowSec / 60} minutes for one user and {TEST_BUDGET.workspace.limit} an hour for a workspace. They come from our hosting provider&rsquo;s servers, with the same user agent.
        </p>

        <h2>What a check sends</h2>
        <ul>
          <li>
            <strong>HTTP</strong>: one request to the address the user gave, with the method they chose ({list(METHODS)}), <code className="code">Accept: */*</code>, and the headers they stored, such as a key for their own app, which go only to the site they were added for. A stored header replaces StaygreenBot&rsquo;s own of the same name, its user agent included. It follows at most {MAX_REDIRECTS} redirects, reads at most the first {MAX_BODY_BYTES / 1024} KB of a response, and opens a new connection every time. Cookies a response sets are sent back within that redirect chain only, respecting Domain, Path and Secure. They are never kept across checks or logged, and their values are masked wherever a response&rsquo;s headers are shown. A stored <code className="code">Cookie</code> header takes precedence on its original origin.
          </li>
          <li>
            <strong>TCP</strong>: a connection to the host and port the user gave, with a TLS handshake if they asked for one, and nothing sent over it.
          </li>
          <li>
            <strong>Certificates</strong>: a TLS handshake on port 443, to read the certificate&rsquo;s expiry, issuer and names. No HTTP request.
          </li>
          <li>
            <strong>DNS</strong>: nothing sent to you directly. Staygreen asks {list(RESOLVERS.map((r) => `${RESOLVER_NAME[r.id]}’s (${r.server})`))} public resolvers for the record, and they may ask your name servers.
          </li>
          <li>
            <strong>Suggesting an app&rsquo;s checks</strong> requests, once each: the address, following at most {MAX_REDIRECTS} redirects and reading at most {PAGE_BYTES / 1024} KB; {list(HEALTH_PATHS)} on its site, without following redirects, reading at most {HEALTH_BODY_BYTES / 1024} KB of each; its certificate; the web app manifest its page names (at most {MANIFEST_BYTES / 1024} KB), at most {STYLESHEETS} of its stylesheets on the same site ({STYLESHEET_BYTES / 1024} KB each) and at most {SCRIPTS} of its scripts on the same origin ({SCRIPT_BYTES / 1024} KB each), read for its brand colour, API host and whether it uses Supabase; if the app has no logo yet, at most {ICON_TRIES} of the icons its page or manifest names (or <code className="code">/favicon.ico</code>), which may be on another host, reading at most {PAGE_ASSET_LIMIT / 1024} KB of each; and, when the page names a Supabase project, that project&rsquo;s Auth and Storage health on Supabase. At most {AT_ONCE} of these are open to the app&rsquo;s site at a time. The same limit covers all hosts and DNS reads. It also checks up to {MAX_DEPENDENCIES} sign-in frontends named by the page (4 s and {SCRIPT_BYTES / 1024} KB each), the app domain&rsquo;s nameservers and first-party sign-in CNAMEs. Provider detection reads the page already fetched; it makes no extra discovery request.
          </li>
        </ul>
        <p>Suggestions also try health paths on the final origin after a redirect and on one same-domain app linked by Log in, Sign in, Login, Dashboard, App or Console. They check an API host named by the page or its scripts, or found in DNS with addresses a random name doesn&rsquo;t get: five health paths, the root, then one random path if the root returns JSON 401 or 404. For a subdomain, they may read the apex and www to find the same brand&apos;s website. SMTP discovery, with the same DNS proof, tries port 587, then TLS on 465. All of this shares the same {AT_ONCE}-operation limit and 25-second deadline.</p>
        <p>Staygreen refuses addresses on private networks, and checks again after every DNS answer and at every redirect.</p>
        <p>If your bot protection answers a check with a challenge, the check fails and Staygreen asks its user to let StaygreenBot through. It never tries to solve a challenge.</p>

        <h2>How often</h2>
        <p>
          For each monitor: HTTP and TCP {every(F.httpIntervalMin)} on the Free plan and {every(B.httpIntervalMin)} on Builder, certificates every {SSL_INTERVAL_SEC / 3600} hours, and DNS records every {DNS_INTERVAL_SEC / 60} minutes. A failed HTTP or TCP check, or a certificate that couldn&rsquo;t be reached, adds one more. A Free workspace can add at most {F.perHost} monitors on one host, besides the certificate check Staygreen adds with the first HTTPS one.
        </p>

        <h2>If you didn&rsquo;t ask for this</h2>
        <p>
          If StaygreenBot is checking an address of yours and you don&rsquo;t want it to, write to{" "}
          {email ? <a href={`mailto:${email}`}>{email}</a> : <>{COMPANY.name}, {ADDRESS_LINE}</>} with the address, and the checks against it are stopped.
        </p>
        <p>
          What Staygreen keeps from a check is in our <Link href="/legal/privacy">privacy policy</Link>.
        </p>
      </article>
    </div>
  );
}
