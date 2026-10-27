"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { StateBadge, StateIcon } from "@/components/State";
import { SoonTag } from "@/components/Tags";
import { TypeIcon } from "@/components/TypeIcon";
import { areaLabel, launch, soonNote } from "@/lib/launch";
import type { MonitorType, State } from "@/lib/model";
import { firstCity, secondCity } from "./plan-copy";

// "What it catches": one failure per tab, each shown as the monitor that caught it, cropped
// from the real dashboard, on sample data. Coming soon types say so and can't pretend to have
// caught anything.

type Item = { type: MonitorType; tab: string; problem: string; how: ReactNode; frag: ReactNode };

function Frag({ app, name, state, label, children, foot }: { app: string; name: string; state: State; label?: string; children: ReactNode; foot: ReactNode }) {
  return (
    <div className="fx" data-ui>
      <div className="fx-head">
        <span className="fx-title">
          <span className="fx-app">{app}</span>
          <strong>{name}</strong>
        </span>
        <StateBadge state={state} label={label} />
      </div>
      <div className="fx-body">{children}</div>
      <div className="fx-foot">{foot}</div>
    </div>
  );
}

function Pass({ ok, what, got }: { ok: boolean; what: ReactNode; got: ReactNode }) {
  return (
    <li className={`fx-check ${ok ? "ok" : "bad"}`}>
      {ok ? <Check aria-label="Passed" /> : <X aria-label="Failed" />}
      <span>{what}</span>
      <span className="fx-got">{got}</span>
    </li>
  );
}

const all: Item[] = [
  {
    type: "http",
    tab: "Wrong answer",
    problem: "Your API says 200 while the database is gone",
    how: <>Assertions on the JSON body, like <code className="code">$.db.ok == true</code>. A wrong value is an outage, even with a 200.</>,
    frag: (
      <Frag app="askone" name="API health" state="down" foot={`Failed from ${secondCity}, confirmed from ${firstCity} at 14:02.`}>
        <p className="fx-line"><code className="code">GET askone.org/api/health</code> returned 200 in 182 ms</p>
        <ul className="fx-checks">
          <Pass ok what="Status is 200" got="200" />
          <Pass ok={false} what={<><code className="code">$.db.ok</code> equals <code className="code">true</code></>} got="false" />
          <Pass ok what="Answers within 1.5 s" got="182 ms" />
        </ul>
        <pre className="fx-pre">{`{"status":"ok","db":{"ok":false,"error":"too many connections"}}`}</pre>
      </Frag>
    ),
  },
  {
    type: "heartbeat",
    tab: "Silent cron",
    problem: "Your cron ran, and sent nothing",
    how: <>Each job pings a heartbeat URL with the numbers it produced. <code className="code">emails_sent &gt; 0</code> fails the night it&rsquo;s 0, and a missing ping fails on time.</>,
    frag: (
      <Frag app="askone" name="Nightly digest emails" state="down" foot="Every day at 06:00. Alert sent at 06:01.">
        <table className="fx-table">
          <thead>
            <tr><th>Ping</th><th>emails_sent</th><th className="r">Rule</th></tr>
          </thead>
          <tbody>
            {[
              ["Mon 06:00", "412", true],
              ["Tue 06:00", "398", true],
              ["Wed 06:00", "405", true],
              ["Thu 06:00", "0", false],
            ].map(([t, n, ok]) => (
              <tr key={t as string} className={ok ? undefined : "bad"}>
                <td>{t}</td>
                <td className="num">{n}</td>
                <td className="r">{ok ? <span className="fx-pass"><Check aria-hidden="true" />&gt; 0</span> : <span className="fx-fail"><X aria-hidden="true" />not &gt; 0</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <pre className="fx-pre">{`curl -fsS "https://in.staygreen.io/hb_k3V9pQ2x?emails_sent=$SENT"`}</pre>
      </Frag>
    ),
  },
  {
    type: "stripe",
    tab: "Lost webhook",
    problem: "A customer paid, and your app never heard",
    how: "Stripe keeps its own record of the webhook deliveries that failed. Staygreen reads it with a restricted key that can read events and webhook endpoints, and nothing else.",
    frag: (
      <Frag app="askone" name="Stripe webhooks" state="down" foot="3 failed deliveries in the last hour. Read from Stripe at 14:33.">
        <ul className="fx-rows">
          {[
            ["checkout.session.completed", "500 from /api/stripe/webhook", "3 attempts", "14:31"],
            ["invoice.paid", "500 from /api/stripe/webhook", "2 attempts", "14:28"],
            ["customer.subscription.updated", "Timed out after 10 s", "2 attempts", "14:26"],
          ].map(([ev, why, n, t]) => (
            <li key={ev}>
              <StateIcon state="down" size={14} />
              <span className="fx-row-main"><code className="code">{ev}</code><span className="fx-sub">{why}, {n}</span></span>
              <span className="fx-time num">{t}</span>
            </li>
          ))}
        </ul>
      </Frag>
    ),
  },
  {
    type: "ssl",
    tab: "Expiring certificate",
    problem: "Your certificate quietly stops renewing",
    how: "Added for every host you monitor, with your domain's registration. Certificate reminders go out 21, 7 and 1 days before expiry, and domain reminders 30, 7 and 1 days before.",
    frag: (
      <Frag app="tutorbook" name="tutorbook.io" state="degraded" foot="Let's Encrypt renews 30 days out, so auto-renew has probably stopped.">
        <div className="fx-figs">
          <div><span className="fx-fig warn">6 days</span><span className="fx-sub">until the certificate expires</span></div>
          <div><span className="fx-fig">211 days</span><span className="fx-sub">until the domain expires</span></div>
        </div>
        <ul className="fx-checks">
          <Pass ok what="Reminder at 21 days" got="Sent 15 Oct" />
          <Pass ok what="Reminder at 7 days" got="Sent 29 Oct" />
          <li className="fx-check wait"><span className="fx-dot" aria-hidden="true" /><span>Reminder at 1 day</span><span className="fx-got">4 Nov</span></li>
        </ul>
      </Frag>
    ),
  },
  {
    type: "dns",
    tab: "Changed DNS",
    problem: "A DNS record changed, and traffic went elsewhere",
    how: "The record you expect, asked of two public resolvers every 10 minutes.",
    frag: (
      <Frag app="askone" name="status.askone.org" state="down" foot="Changed between 09:02 and 09:12. Both resolvers agree.">
        <dl className="fx-kv">
          <dt>Expected</dt>
          <dd><code className="code">CNAME from your page editor</code></dd>
          <dt>Got from 1.1.1.1</dt>
          <dd><code className="code">A 76.76.21.21</code></dd>
          <dt>Got from 8.8.8.8</dt>
          <dd><code className="code">A 76.76.21.21</code></dd>
        </dl>
      </Frag>
    ),
  },
  {
    type: "tcp",
    tab: "Dead socket",
    problem: "Your websocket server stopped taking connections",
    how: "A TCP connection and a TLS handshake to the port, from two locations.",
    frag: (
      <Frag app="quizroom" name="Realtime socket" state="down" foot="Last good connection at 16:40, TLS in 43 ms.">
        <ul className="fx-rows">
          <li><StateIcon state="down" size={14} /><span className="fx-row-main"><code className="code">rt.quizroom.app:443</code><span className="fx-sub">Connection refused from {secondCity}</span></span><span className="fx-time num">16:43</span></li>
          <li><StateIcon state="down" size={14} /><span className="fx-row-main"><code className="code">rt.quizroom.app:443</code><span className="fx-sub">Connection refused from {firstCity}</span></span><span className="fx-time num">16:43</span></li>
        </ul>
      </Frag>
    ),
  },
  { type: "mcp", tab: "MCP server", problem: "Your MCP server lost a tool, or its OAuth broke", how: soonNote.mcp, frag: null },
  {
    type: "supabase",
    tab: "Supabase pause",
    problem: "Your free Supabase project paused itself",
    how: soonNote.supabase,
    frag: (
      <Frag app="quizroom" name="Supabase project" state="down" label="Project paused" foot="Its address stopped resolving at 07:14, seen from both locations. The alert says paused or deleted and links the project's dashboard.">
        <ul className="fx-checks">
          <Pass ok={false} what="The project's address resolves" got="Not found" />
          <Pass ok={false} what={<>Auth health, <code className="code">/auth/v1/health</code></>} got="No answer" />
          <Pass ok={false} what="Storage status" got="No answer" />
        </ul>
        <p className="fx-line">Supabase pauses a free project after 7 days without database activity. A daily database read counts as activity.</p>
      </Frag>
    ),
  },
];

// What is coming sits after everything that runs, whichever types those are (owner, 2026-10-24).
const soonType = (x: Item) => launch[x.type as keyof typeof launch] === "soon";
const items = [...all.filter((x) => !soonType(x)), ...all.filter(soonType)];

// The spec asks for "Email me when it ships" here. Nothing stores an address yet (no list, no
// confirmation email), so a form would promise an email nobody sends. Until there is one, the
// panel offers what is real: a free workspace, where the type appears the day it ships.
function SoonPanel({ label }: { label: string }) {
  return (
    <div className="fx fx-soon" data-ui>
      <div className="fx-head">
        <span className="fx-title"><strong>{label}</strong></span>
        <SoonTag />
      </div>
      <div className="fx-body">
        <p>It isn&rsquo;t running yet, so you don&rsquo;t pay for it. When it ships, both plans include it, and it appears in your dashboard with the other monitor types.</p>
        <div><Link href="/sign-up" className="btn btn-ink">Start free</Link></div>
      </div>
    </div>
  );
}

export function Catches() {
  const [on, setOn] = useState(0);
  const id = useId();
  const it = items[on];
  const soon = launch[it.type as keyof typeof launch] === "soon";
  return (
    <div className="cx">
      <div className="cx-tabs" role="tablist" aria-label="Failures" aria-orientation="vertical">
        {items.map((x, i) => {
          const isSoon = launch[x.type as keyof typeof launch] === "soon";
          return (
            <button
              key={x.type}
              type="button"
              role="tab"
              id={`${id}-t${i}`}
              aria-selected={i === on}
              aria-controls={`${id}-p`}
              tabIndex={i === on ? 0 : -1}
              className={`cx-tab ${isSoon ? "soon" : ""}`}
              onClick={() => setOn(i)}
              onKeyDown={(e) => {
                const k = e.key;
                if (k !== "ArrowDown" && k !== "ArrowUp" && k !== "ArrowRight" && k !== "ArrowLeft") return;
                e.preventDefault();
                const n = (on + (k === "ArrowDown" || k === "ArrowRight" ? 1 : -1) + items.length) % items.length;
                setOn(n);
                document.getElementById(`${id}-t${n}`)?.focus();
              }}
            >
              <TypeIcon type={x.type} size={18} />
              <span>{x.tab}</span>
              {isSoon && <span className="cx-soon">Soon</span>}
            </button>
          );
        })}
      </div>
      <div className="cx-panel" role="tabpanel" id={`${id}-p`} aria-labelledby={`${id}-t${on}`} key={on}>
        <div className="cx-copy">
          <h3>{it.problem}</h3>
          <p>{it.how}</p>
        </div>
        {soon ? <SoonPanel label={areaLabel[it.type as keyof typeof launch]} /> : it.frag}
      </div>
    </div>
  );
}
