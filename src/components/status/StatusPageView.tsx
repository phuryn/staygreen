"use client";

// The public status page (spec.md § 6). The editor's preview renders this same component, so
// what the builder sees is what visitors get. It wears the builder's theme and accent, never
// the dashboard's: public-neutral tokens plus the page's own light, dark or follow-the-visitor,
// and the accent shaded for both themes so the stylesheet can pick the one shown (`accents.ts`).
//
// It renders a `PublicView` and nothing else (`@/lib/public-page`): the allowlist of what a
// visitor may see. The server renders it, so every time on it goes through `<When>`.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { StatusPage } from "@/lib/model";
import type { PublicIncident, PublicView } from "@/lib/public-page";
import { headline } from "@/lib/public-page";
import { dur, pct } from "@/lib/format";
import { UptimeBars, padDays } from "@/components/charts";
import { StateBadge, StateIcon } from "@/components/State";
import { When } from "@/components/When";
import { accentStyle } from "@/lib/accents";
import { noteWord } from "./data";

export function themeClass(p: Pick<StatusPage, "theme">) {
  return `public-neutral theme-${p.theme}`;
}

export function BrandMark({ size = 28 }: { size?: number }) {
  // Not a circle, triangle or square: those shapes mean a state on this page. It wears the
  // accent's mark shade, so it stands off the ground in either theme.
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true" className="sp-mark">
      <path d="M10 1h8a9 9 0 0 1 9 9v8a9 9 0 0 1-9 9H3a2 2 0 0 1-2-2V10a9 9 0 0 1 9-9z" fill="var(--accent)" />
    </svg>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Phone-sized pages show 30 days; the bars stay wide enough to tap and read. */
function useNarrow<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (w: number) => {
      if (w > 0) setNarrow(w < 560);
    };
    measure(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => measure(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, narrow] as const;
}

/** The page's frame: its brand, its theme and its accent, around whatever it shows. */
export function PublicFrame({ page, embedded, children }: { page: PublicView["page"]; embedded?: boolean; children: React.ReactNode }) {
  const brand = (
    <>
      {page.logoUrl ? <img className="sp-uploaded-logo" src={page.logoUrl} alt={page.logoText ? "" : page.name} /> : <BrandMark />}
      <span>{page.logoText}</span>
    </>
  );
  return (
    <div className={`sp ${themeClass(page)}${embedded ? " sp-embedded" : ""}`} style={accentStyle(page.accent) as CSSProperties}>
      <div className="sp-inner">
        <header className="sp-head">
          {page.homepage ? <a className="sp-brand" href={page.homepage}>{brand}</a> : <span className="sp-brand">{brand}</span>}
          {page.homepage && (
            <a className="sp-home" href={page.homepage}>
              Go to <span className="addr">{hostOf(page.homepage)}</span>
            </a>
          )}
        </header>
        {children}
        <footer className="sp-foot">{page.poweredBy ? <Link href="/" className="sp-foot-link">Powered by Staygreen</Link> : <span />}</footer>
      </div>
    </div>
  );
}

function Notes({ i, now }: { i: PublicIncident; now: number }) {
  return (
    <ol className="sp-notes">
      {i.notes.map((n) => (
        <li key={n.id}>
          <strong>{noteWord[n.state]}</strong>
          <p>{n.text}</p>
          <span className="t-meta"><When t={n.at} now={now} /></span>
        </li>
      ))}
    </ol>
  );
}

function Uptime({ daily, days, now, name, narrow }: { daily: number[]; days: number; now: number; name: string; narrow: boolean }) {
  const shown = padDays(daily, days);
  const known = shown.filter((v) => v >= 0);
  const avg = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  return (
    <>
      <UptimeBars daily={shown} now={now} label={name} compact height={narrow ? 30 : 32} />
      <div className="bars-foot t-meta">
        <span>{days} days ago</span>
        <span className="num">{avg === null ? "No data yet" : `${pct(avg)} uptime`}</span>
        <span>Today</span>
      </div>
    </>
  );
}

export function StatusPageView({ view, embedded, notice }: { view: PublicView; embedded?: boolean; notice?: ReactNode }) {
  const [ref, narrow] = useNarrow<HTMLDivElement>();
  const { page, components: comps, incidents, now } = view;
  const head = headline(view);
  const active = incidents.filter((i) => !i.resolvedAt);
  const past = incidents.filter((i) => i.resolvedAt);
  const days = Math.min(page.historyDays, narrow ? 30 : 90);
  // Inside the editor's preview the dashboard owns the page's h1.
  const Heading = embedded ? "h2" : "h1";

  return (
    <div ref={ref}>
      <PublicFrame page={page} embedded={embedded}>
        {notice}
        <section className={`sp-overall ${head.state}`} aria-live="polite">
          <StateIcon state={head.state} size={26} />
          <div className="sp-overall-text">
            <Heading>{head.title}</Heading>
            {head.detail && <p>{head.detail}</p>}
            {view.updatedAt && <p className="t-meta">Checked <When t={view.updatedAt} now={now} /></p>}
          </div>
        </section>

        {active.map((i) => (
          <section key={i.id} className="sp-active" aria-label="Current incident">
            <h2 className="sp-active-title">{i.title}</h2>
            <Notes i={i} now={now} />
          </section>
        ))}

        {comps.length > 0 && (
          <section className="sp-section" aria-labelledby="sp-c">
            <div className="sp-section-head">
              <h2 id="sp-c">Components</h2>
              <span className="t-meta">Uptime over the last {days} days</span>
            </div>
            <ul className="sp-comps">
              {comps.map((c) => (
                <li key={c.key} className="sp-comp">
                  <div className="sp-comp-head">
                    <span className="sp-comp-name">{c.name}</span>
                    <StateBadge state={c.state} publicFacing />
                  </div>
                  <Uptime daily={c.daily} days={days} now={now} name={c.name} narrow={narrow} />
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="sp-section" aria-labelledby="sp-h">
          <div className="sp-section-head">
            <h2 id="sp-h">Past incidents</h2>
          </div>
          {past.length === 0 ? (
            <p className="t-2">No incidents in the last {page.historyDays} days.</p>
          ) : (
            <ol className="sp-history">
              {past.map((i) => (
                <li key={i.id} className="sp-incident">
                  <div className="sp-incident-head">
                    <h3>{i.title}</h3>
                    <span className="t-meta"><When t={i.openedAt} now={now} />, lasted {dur((i.resolvedAt ?? now) - i.openedAt)}</span>
                  </div>
                  <Notes i={i} now={now} />
                </li>
              ))}
            </ol>
          )}
        </section>
      </PublicFrame>
    </div>
  );
}

/** One incident, at the short link alerts carry (`/i/<id>`), inside its page's frame. */
export function PublicIncidentView({ view, incidentId }: { view: PublicView; incidentId: string }) {
  const { page, now } = view;
  const i = view.incidents.find((x) => x.id === incidentId);
  const back = <Link href={`/s/${page.slug}`} className="link">See the whole status page</Link>;
  if (!i) {
    return (
      <PublicFrame page={page}>
        <section className="sp-section stack">
          <h1 className="t-title">This incident is no longer on the status page</h1>
          <p className="t-2">The page shows the last {page.historyDays} days of incidents, and this one is older.</p>
          <p>{back}</p>
        </section>
      </PublicFrame>
    );
  }
  const state = i.resolvedAt ? "up" : i.severity;
  return (
    <PublicFrame page={page}>
      <section className={`sp-overall ${state}`}>
        <StateIcon state={state} size={26} />
        <div className="sp-overall-text">
          <h1>{i.title}</h1>
          <p>
            {i.resolvedAt ? "Resolved" : "Ongoing"}. Started <When t={i.openedAt} now={now} />
            {i.resolvedAt ? `, lasted ${dur(i.resolvedAt - i.openedAt)}` : ""}.
          </p>
        </div>
      </section>
      <section className="sp-section" aria-label="Updates">
        <Notes i={i} now={now} />
      </section>
      <p>{back}</p>
    </PublicFrame>
  );
}

/** A public address with nothing behind it. */
export function PublicNotFound({ what }: { what: "page" | "incident" }) {
  return (
    <div className="sp public-neutral theme-visitor">
      <div className="sp-inner sp-plain">
        <div className="stack">
          <h1 className="t-title">{what === "page" ? "There is no status page at this address" : "There is no incident at this address"}</h1>
          <p className="t-2">
            {what === "page"
              ? "Check the link for typos, or ask the app's team for their status page address."
              : "The link may be mistyped, or the incident was never made public."}
          </p>
        </div>
      </div>
    </div>
  );
}
