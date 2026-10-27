import type { Metadata } from "next";
import { publicPageMetadata } from "@/lib/public-metadata";
import Link from "next/link";
import { Catches } from "@/components/landing/Catches";
import { Comparison } from "@/components/landing/Comparison";
import { Disagree } from "@/components/landing/Disagree";
import { PlanCards } from "@/components/landing/PlanCards";
import { firstCity, secondCity } from "@/components/landing/plan-copy";
import { StateBadge, StateIcon } from "@/components/State";
import { SoonTag } from "@/components/Tags";
import { isBuilt, isLive } from "@/lib/launch";
import { limits } from "@/lib/plans";

export const metadata: Metadata = {
  ...publicPageMetadata("/"),
  title: { absolute: "Staygreen: monitoring for apps you built yourself" },
  description: "Uptime checks that read what your app returns, heartbeats for your crons, Stripe webhook failures, a paused Supabase project, SSL and domain expiry, a status page on your domain, and an MCP server for your coding agent.",
};

// The page shows the product working in every section instead of describing it. Each section
// changes ground (white, black, cobalt, white, tone) so it reads as its own thing at a glance.
//
// What it says about the product describes launch day; what it lets a visitor *do* is only
// what this build runs (`src/lib/launch.ts`, `built`). Every number comes from the plan module.

const F = limits.free;

// The hero's second button: the scan once it runs, and pricing until then.
const second = isBuilt("scan") ? { href: "/scan", label: "Scan your app" } : { href: "/pricing", label: "See pricing" };

export default function Landing() {
  return (
    <>
      <section className="wrap lp-hero" aria-labelledby="hero-h">
        <h1 id="hero-h" className="lp-h1">
          <span>Your app is up.</span>
          <span>Is it working?</span>
        </h1>
        <div className="lp-hero-row">
          <div className="lp-hero-copy">
            <p className="lp-lead">
              A ping only checks that your server answers. Staygreen checks what it answers, that your crons did their job, and that Stripe&rsquo;s webhooks arrived.
            </p>
            <div className="cluster">
              <Link href="/sign-up" className="btn btn-primary btn-lg">Start free</Link>
              <Link href={second.href} className="btn btn-lg">{second.label}</Link>
            </div>
            <p className="lp-free">Free for {F.monitors} monitors, with commercial use. No card.</p>
          </div>
          <Disagree />
        </div>
      </section>

      <section id="checks" className="lp-sec lp-first" aria-labelledby="checks-h">
        <div className="wrap">
          <div className="lp-head">
            <h2 id="checks-h" className="lp-h2">Failures that pass a ping</h2>
            <p className="lp-lead">Each one is a check you add in a minute, or that your coding agent adds for you. Coming soon means it isn&rsquo;t running yet, and you don&rsquo;t pay for it.</p>
          </div>
          <Catches />
        </div>
      </section>

      <section className="lp-sec lp-black theme-dark" aria-labelledby="alert-h">
        <div className="wrap lp-split">
          <div className="al" role="figure" aria-label="Example alert in Telegram">
            <div className="al-msg">
              <div className="al-from"><strong>Staygreen</strong><span className="num">14:02</span></div>
              <div className="al-title"><StateIcon state="down" size={20} />askone: API health is down</div>
              <p><code className="code">GET /api/health</code> returned 200, but <code className="code">$.db.ok == true</code> got <code className="code">false</code>.</p>
              <p className="t-meta">Failed from {secondCity}, confirmed from {firstCity}.</p>
              <pre className="snippet wrap">{`{"db":{"ok":false,"error":"too many connections"}}`}</pre>
              <div className="al-buttons">
                <span className="btn">Acknowledge</span>
                <span className="btn">Pause 1 h</span>
                <span className="btn">Draft update</span>
              </div>
            </div>
            <div className="al-msg small">
              <div className="al-from"><strong>Staygreen</strong><span className="num">14:08</span></div>
              <div className="al-title"><StateIcon state="up" size={20} />askone: API health recovered</div>
              <p className="t-meta">Down for 6 minutes.</p>
            </div>
          </div>
          <div className="lp-text">
            <h2 id="alert-h" className="lp-h2">Alerts that say what broke</h2>
            <p className="lp-lead">
              A failed request is checked again from a second location before anyone is woken. The alert carries the request, what it got and the response, so you can start fixing from your phone.
            </p>
            <ul className="lp-points">
              <li>Email, Telegram, Slack, Discord or a signed webhook</li>
              <li>A recovery notice when it&rsquo;s fixed</li>
              <li>On Telegram, acknowledge or pause from the message itself</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="lp-sec lp-cobalt" aria-labelledby="users-h">
        <div className="wrap lp-split">
          <div className="lp-text">
            <h2 id="users-h" className="lp-h2">Your users see it too</h2>
            <p className="lp-lead">
              <strong>A status page on your own domain{!isLive("customDomains") && <> <SoonTag /></>}, in your colours.</strong> And a banner inside your app while something is wrong, so people don&rsquo;t have to go looking.{!isLive("widget") && <> <SoonTag /></>}
            </p>
            <p className="lp-lead">You write the update, or your agent drafts it for you to publish. Free includes {F.statusPages === 1 ? "one page" : `${F.statusPages} pages`} with HTTPS on your domain{!isLive("customDomains") && <> <SoonTag /></>}.</p>
          </div>
          <div className="lsp public-neutral theme-light" role="figure" aria-label="AskOne's status page and in-app banner">
            <div className="lsp-banner">
              <StateIcon state="degraded" size={18} />
              <span><strong>Live voting is having problems.</strong> We&rsquo;re on it. <u>status.askone.org</u></span>
            </div>
            <div className="lsp-page">
              <div className="lsp-head"><strong>AskOne status</strong><span className="t-meta">status.askone.org</span></div>
              <div className="lsp-overall"><StateIcon state="degraded" size={20} />Partial outage</div>
              <ul className="lsp-rows">
                {[
                  { n: "Website", s: "up" as const, w: "Operational" },
                  { n: "Live Q&A rooms", s: "up" as const, w: "Operational" },
                  { n: "Live voting", s: "down" as const, w: "Outage" },
                  { n: "Sign-in", s: "up" as const, w: "Operational" },
                ].map((c) => (
                  <li key={c.n}><span>{c.n}</span><StateBadge state={c.s} label={c.w} /></li>
                ))}
              </ul>
              <div className="lsp-note">
                <strong>Identified at 14:05</strong>
                <span>A deploy left the vote worker stopped. It&rsquo;s restarting, and votes cast meanwhile are saved.</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-sec" aria-labelledby="agent-h">
        <div className="wrap lp-split">
          <div className="lp-text">
            <h2 id="agent-h" className="lp-h2">Your coding agent can read it</h2>
            <p className="lp-lead">
              Staygreen has an MCP server and a REST API on every plan. Ask Claude Code or Codex what&rsquo;s broken and it gets the evidence, not a guess. It can set up monitoring for a new app from its URL.
            </p>
            {!isLive("agentMcp") && <SoonTag />}
          </div>
          <pre className="terminal lp-terminal" aria-label="Example Claude Code session">
            <span className="you">{"> Is anything broken in askone?"}</span>{"\n\n"}
            <span className="tool">{"  staygreen: get_incidents(app: \"askone\", state: \"open\")"}</span>{"\n\n"}
            {`One open incident since 14:02: API health. /api/health returns 200, but $.db.ok is false from ${secondCity} and ${firstCity}. The body says "too many connections". Your pool max is 10 in lib/db.ts.\n\n`}
            {"Raise it to 25 and draft a status update for you to publish?"}{"\n\n"}
            <span className="you">{"> yes"}</span>{"\n\n"}
            <span className="tool">{"  staygreen: draft_incident_update(incident: \"inc_7Qa2\", state: \"identified\", text: \"…\")"}</span>{"\n"}
            <span className="ok">{"  Draft saved. It's not public until you publish it."}</span>
          </pre>
        </div>
      </section>

      <section className="lp-sec lp-tone" aria-labelledby="price-h">
        <div className="wrap">
          <div className="lp-head">
            <h2 id="price-h" className="lp-h2">Free for most apps</h2>
            <p className="lp-lead">Builder is for when you run several apps, or want checks every minute.</p>
          </div>
          <PlanCards />
          <p className="lp-plans-foot"><Link href="/pricing" className="link">Compare everything in each plan</Link></p>
          <Comparison />
        </div>
      </section>

      <section className="wrap lp-close" aria-labelledby="close-h">
        <h2 id="close-h" className="lp-h2">Know it works, not just that it&rsquo;s up</h2>
        <div className="cluster">
          <Link href="/sign-up" className="btn btn-primary btn-lg">Start free</Link>
          <Link href={second.href} className="btn btn-lg">{second.label}</Link>
        </div>
      </section>
    </>
  );
}
