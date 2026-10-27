"use client";

import { statusHost } from "@/lib/status-host";

import Link from "next/link";
import { useState } from "react";
import type { CSSProperties } from "react";
import { Copy } from "@/components/Copy";
import { Loading, PageHead } from "@/components/Shell";
import { BuilderTag } from "@/components/Tags";
import { themeClass } from "@/components/status/StatusPageView";
import { bannerFor, pageState, shownComponents, showsMark } from "@/components/status/data";
import { accentStyle } from "@/lib/accents";
import { badgeDataUrl, badgeFor, badgeMarkdown, badgePhrase } from "@/lib/badge";
import { has } from "@/lib/plans";
import { headline, viewFromSim } from "@/lib/public-page";
import type { StatusPage } from "@/lib/model";
import { useWorkspace, type Workspace } from "@/lib/workspace-store";
import { BannerPreview, PillPreview } from "./pieces";

/* The README address remains compatible with the app's public route. The banner and pill
   are served by the edge script; this workspace preview uses the same public headline and
   published-note boundary. Simulation affects only this screen. */

function Widget({ s, origin }: { s: Workspace; origin: string }) {
  const [pageId, setPageId] = useState(s.pages[0]?.id ?? "");
  const page = s.pages.find((p) => p.id === pageId) ?? s.pages[0];

  return (
    <>
      <PageHead
        title="Widget and badge"
        sub="Your status where your users already are: a banner in your app while something is wrong, a badge in your README and a pill in your footer."
      />

      <div className="callout callout-info">
        <p>
          One deferred script reads your status page&apos;s public summary. It draws nothing until the data arrives, and if the data can&apos;t be reached it stays empty. The README badge needs no script.
        </p>
      </div>

      {page ? (
        <section className="section" aria-labelledby="pv-h">
          <div className="section-head">
            <div className="cluster grow">
              {s.pages.length > 1 && (
                <div className="field wd-pick">
                  <label className="label" htmlFor="wd-page">Status page</label>
                  <select id="wd-page" className="select" value={page.id} onChange={(e) => setPageId(e.target.value)}>
                    {s.pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
              <h2 id="pv-h" className="t-section">Preview</h2>
            </div>
          </div>
          {/* Keyed by page, so a banner dismissed or simulated on one page doesn't carry to the next. */}
          <Preview key={page.id} s={s} page={page} origin={origin} />
        </section>
      ) : (
        <section className="section" aria-labelledby="np-h">
          <div className="panel empty">
            <strong id="np-h" className="t-section">The widget and badge read a status page</strong>
            <p className="t-2">Each piece shows one status page&apos;s state, so there&apos;s nothing to show until you have a page.</p>
            {s.can["pages:manage"] && <Link href="/app/status-pages" className="btn">Go to status pages</Link>}
          </div>
        </section>
      )}

      <p className="callout callout-info wd-privacy">
        <span>The widget sets no cookies and requests only your page&apos;s public summary, without cookies or a referrer. Dismissing a banner keeps only the update id in localStorage. Only published updates appear, never drafts.</span>
      </p>
    </>
  );
}

function Preview({ s, page, origin }: { s: Workspace; page: StatusPage; origin: string }) {
  const state = pageState(s, page);
  const mark = showsMark(s, page);
  const shown = shownComponents(page);
  const app = s.apps.find((a) => a.id === page.appId);
  const badge = badgeFor(viewFromSim(s, page));
  const markdown = badgeMarkdown(origin, page);
  const [simulate, setSimulate] = useState(false);
  const live = bannerFor(s, page);
  const [liveHidden, setLiveHidden] = useState(false);
  const [exampleHidden, setExampleHidden] = useState(false);
  // The example names one of the page's own components, as a real update would.
  const example = shown[0]?.name ?? page.components[0]?.name ?? "Sign-in";
  const caption = simulate
    ? "Simulated, with an example update. Dismissing it ends the simulation."
    : live
      ? liveHidden
        ? "Dismissed here. A user who dismisses it sees it again at your next update."
        : "Live: the banner your app would show right now, with the update you published."
      : `${exampleHidden ? "Example dismissed here." : "Example banner only, with a made-up update."} ${state === "up"
        ? "All is well, so your users see no banner."
        : "There is no live banner. It needs a degraded or down component enabled for the banner and a published update for its incident."}`;
  const look = `host-frame wd-stage ${themeClass(page)}`;
  const embed = `<script src="https://${statusHost()}/w.js" data-page="${page.slug}" defer></script>\n<div data-staygreen="banner"></div>\n<span data-staygreen="pill"></span>`;
  if (page.membersOnly) return <div className="panel empty"><h3>Members-only page</h3><p className="t-2">This page has no public summary, widget or badge. Choose a public page to embed it.</p></div>;

  return (
    <div className="panel panel-flush">
      <div className="wd-piece">
        <div className="stack-sm">
          <div className={look} style={accentStyle(page.accent) as CSSProperties}>
            {(simulate || !live) && !exampleHidden ? (
              <BannerPreview
                example
                state="degraded"
                text={`${example} is slow right now. We're looking into it and will post the next update here.`}
                href={`/s/${page.slug}`}
                onDismiss={() => { setSimulate(false); setExampleHidden(true); }}
              />
            ) : (
              live && !simulate &&
              !liveHidden && <BannerPreview state={live.state === "down" ? "down" : "degraded"} text={live.note.text} href={`/s/${page.slug}`} onDismiss={() => setLiveHidden(true)} />
            )}
            <div className="wd-test">
              <div className="wd-test-head">
                <strong>{app?.name ?? page.logoText}</strong>
                <span className="wd-test-tag">{simulate || !live ? "Example app" : "Your app"}</span>
              </div>
              <div className="wd-test-body" aria-hidden="true">
                <span className="wd-line" />
                <span className="wd-line wd-line-short" />
              </div>
            </div>
          </div>
          <p className="t-meta">{caption}</p>
        </div>
        <div className="wd-piece-text">
          <h3>In-app incident banner</h3>
          <p className="t-2">
            A line at the top of your app, there only while something your users rely on is degraded or down, with the update you published. While all is well it isn&apos;t there at all, and a user who dismisses it sees it again at your next update.
          </p>
          <p className="t-2">You choose which of the page&apos;s components can show it, so a part nobody would miss in the middle of a task, like your docs, never interrupts your app.</p>
          <label className="switch">
            <input type="checkbox" role="switch" checked={simulate} onChange={(e) => { setSimulate(e.target.checked); setExampleHidden(false); }} aria-describedby="wd-sim-h" />
            <span className="t-strong">Simulate an incident</span>
          </label>
          <span id="wd-sim-h" className="hint">Changes this preview only. It does not change your status page or the banner in your app.</span>
        </div>
      </div>

      <div className="wd-piece">
        <div className="stack-sm">
          <div className="wd-readme">
            <span className="wd-readme-file">README.md</span>
            <div className="wd-readme-body">
              <strong className="t-section">{app?.name ?? page.logoText}</strong>
              {/* What the route serves, drawn from this workspace: an image, so GitHub's light and dark look the same as here. */}
              <img className="sg-badge" src={badgeDataUrl(badge)} width={badge.width} height={badge.height} alt={badgePhrase(page)} />
            </div>
          </div>
          <div className="stack-sm">
            <strong>Paste this into your README</strong>
            <pre className="snippet wrap">{markdown}</pre>
            <div><Copy text={markdown} label="Copy Markdown" /></div>
          </div>
        </div>
        <div className="wd-piece-text">
          <h3>README badge</h3>
          <p className="t-2">It shows the same state as your status page and links to it. {mark ? "On Free it carries the Staygreen name." : "White label is on, so it shows only your page's name and its status."}</p>
          {mark && (
            <span className="row"><BuilderTag locked={!has(s.plan, "white_label")} /><span className="hint">Builder can remove the Staygreen name.</span></span>
          )}
        </div>
      </div>

      <div className="wd-piece">
        <div className={`${look} wd-stage-pad`} style={accentStyle(page.accent) as CSSProperties}>
          <div className="wd-foot">
            <span className="t-meta">{page.logoText}</span>
            <PillPreview state={state} title={headline(viewFromSim(s, page)).title} />
          </div>
        </div>
        <div className="wd-piece-text">
          <h3>Status pill</h3>
          <p className="t-2">For your footer, linking to your status page.</p>
        </div>
      </div>

      <div className="wd-piece">
        <div className="wd-piece-text">
          <h3>Add to your app</h3>
          <p className="t-2">Your users see a banner at the top of your app only while a component you enabled is degraded or down and its incident has an update you published. The banner shows that update. A status pill in your footer links to your status page. Both are plain neutral cards that Staygreen draws apart from your app&apos;s own styles, light or dark to match the visitor&apos;s device, not the tinted ones previewed here. On Free they carry a &ldquo;Powered by Staygreen&rdquo; line.</p>
          <p className="t-2">Put the banner slot at the top of your layout and the pill slot in its footer. Include the deferred script once. Allow https://{statusHost()} in your Content Security Policy&apos;s script-src and connect-src; if your app uses a nonce, give it to the script.</p>
          <p className="t-2">Both pieces stay empty until the public summary arrives, and disappear if it can&apos;t be read. A user can dismiss the banner until your next update.</p>
          <p className="t-2">Banner enabled for: {page.components.filter(c => c.inApp).map(c => c.name).join(", ") || "no components yet"}. Change this on the status page&apos;s Components panel.</p>
        </div>
        <div className="stack-sm"><pre className="snippet wrap">{embed}</pre><div><Copy text={embed} label="Copy embed" /></div></div>
      </div>
    </div>
  );
}

export function WidgetScreen({ origin }: { origin: string }) {
  const s = useWorkspace();
  return s ? <Widget s={s} origin={origin} /> : <Loading />;
}
