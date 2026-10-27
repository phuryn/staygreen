"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Loading, PageHead } from "@/components/Shell";
import { MonitorTable } from "@/components/MonitorTable";
import { StateBadge, StateIcon } from "@/components/State";
import { Copy } from "@/components/Copy";
import { UptimeBars } from "@/components/charts";
import { AddApp } from "@/components/AddApp";
import { AppLogo } from "@/components/AppLogo";
import { canDeleteApps, DeleteAppDialog } from "@/components/DeleteApp";
import { MoreMenu } from "@/components/MoreMenu";
import { OtherAppsNote } from "@/components/OtherApps";
import { BuilderTag } from "@/components/Tags";
import { openIncidents, pageHost, worst } from "@/lib/derive";
import { useAppSelection, usePoll, useWorkspace, type Workspace } from "@/lib/workspace-store";
import { calmHeadline, checkedSoFar, firstCount, scopeToApp, summarize } from "@/lib/app-selection";
import type { Monitor, State } from "@/lib/model";
import { dur, ms, pct, time, zone } from "@/lib/format";
import { limits, locations, limitsOf } from "@/lib/plans";
import { addAppGate } from "@/lib/upgrade";
import { agentBrief } from "@/lib/agent";

// An app's day is as good as its worst monitor that day. Every monitor's 90 days end on the same
// UTC day (`history.ts`), so index i is the same day for all of them.
function appDaily(ms_: Monitor[], days: number) {
  const len = 90;
  return Array.from({ length: days }, (_, k) => {
    const i = len - days + k;
    const known = ms_.map((m) => m.daily[i] ?? -1).filter((v) => v >= 0);
    return known.length ? Math.min(...known) : -1;
  });
}

/** " The newest median is 2.1 s in Toronto." when a location has reported one. */
function median(m: Monitor) {
  const r = m.reports.find((x) => x.p50 !== null);
  return r ? ` The newest median is ${ms(r.p50)} in ${locations[r.loc].city}.` : "";
}

function Kpis({ s }: { s: Workspace }) {
  const count = (st: State) => s.monitors.filter((m) => m.state === st).length;
  const open = openIncidents(s).length;
  const tiles: { st: State | "incidents"; n: number; label: string; href: string }[] = [
    firstCount(s.monitors),
    { st: "degraded", n: count("degraded"), label: "Degraded", href: "/app/monitors?state=degraded" },
    { st: "down", n: count("down"), label: "Down", href: "/app/monitors?state=down" },
    { st: "incidents", n: open, label: open === 1 ? "Open incident" : "Open incidents", href: "/app/incidents" },
  ];
  return (
    <section className="kpis" aria-label="Monitors by state">
      {tiles.map((t) => (
        <Link key={t.st} href={t.href} className={`kpi ${t.n > 0 && (t.st === "degraded" || t.st === "down") ? t.st : ""} ${t.n === 0 ? "zero" : ""}`}>
          <span className="kpi-n">{t.n}</span>
          <span className="kpi-l">
            {t.st !== "incidents" && <StateIcon state={t.st} size={14} />}
            <span className="kpi-word">{t.label}</span>
          </span>
        </Link>
      ))}
    </section>
  );
}

/** Where a new app goes next: with an address, the checks Staygreen suggests for it; without
 *  one, the add form (`docs/flows.md § First app`). */
const afterAdding = (id: string, url: string) => (url ? `/app/apps/${id}/checks` : `/app/monitors/new?app=${id}`);

const appsWord = (n: number) => (n === 1 ? "one app" : `${n} apps`);

/** The first visit: no app yet, so the one thing to do is name one. */
function FirstApp({ s }: { s: Workspace }) {
  const router = useRouter();
  return (
    <>
      <PageHead doc="Overview" title="Start with your app" sub="Name the app you want watched. Its monitors, incidents and status page hang off it. Give its address and Staygreen suggests its first checks." />
      {s.can["monitors:write"] ? (
        <section className="panel stack" aria-label="Add your first app">
          <AddApp autoFocus submitLabel="Add app" findsChecks onAdded={(id, url) => router.push(afterAdding(id, url))} />
          <p className="t-meta">
            {s.plan === "free"
              ? `Free includes ${appsWord(limits.free.apps)}, with its monitors and status page. Builder includes ${limits.builder.apps}.`
              : `Builder includes ${appsWord(limitsOf(s).apps)}, each with its own monitors and status page.`}
          </p>
        </section>
      ) : (
        <div className="empty"><strong>No apps in this workspace yet.</strong></div>
      )}
    </>
  );
}

function Overview({ workspace, add }: { workspace: Workspace; add: boolean }) {
  const router = useRouter();
  const { app, setApp } = useAppSelection(workspace);
  const s = scopeToApp(workspace, app);
  // The whole workspace's apps, never the chosen one's.
  const gate = addAppGate(workspace);
  const [adding, setAdding] = useState(add && gate === "open");
  const del = useRef<HTMLDialogElement>(null);
  const [doomed, setDoomed] = useState<string | null>(null);
  if (!s.apps.length) return <FirstApp s={s} />;

  const open = openIncidents(s);
  const degraded = s.monitors.filter((m) => m.state === "degraded");
  const L = limitsOf(s);
  const where = L.locations.map((l) => locations[l].city);
  const needs = open.length + degraded.length;
  // One app chosen: the heading is about that app alone, and never reads as the workspace's.
  const one = app === "all" ? null : s.apps[0];
  const inApp = one ? ` in ${one.name}` : "";
  const calm = calmHeadline(s.monitors, inApp);
  const title = !s.monitors.length
    ? one ? `Add a monitor to ${one.name}` : "Add a monitor to start"
    : needs === 0
      ? calm.text
      : needs === 1
        ? `One thing${inApp} needs you`
        : `${needs} things${inApp} need you`;
  // The headline's mark, so the answer is shape, word and colour at the top of the page: with
  // nothing to count, the rail's own rule (`calmHeadline`); otherwise the worst of what it counts,
  // so an incident open on a paused monitor still marks the page. No monitors, no mark.
  const mark: State | null = !s.monitors.length ? null : needs === 0 ? calm.state : worst([...open.map((i) => i.severity), ...degraded.map((m) => m.state)]);
  const elsewhere = one
    ? openIncidents(workspace).filter((i) => i.appId !== one.id).length + workspace.monitors.filter((m) => m.appId !== one.id && m.state === "degraded").length
    : 0;
  const cities = `${where.slice(0, -1).join(", ")} and ${where.at(-1)}`;

  return (
    <>
      <PageHead
        doc="Overview"
        title={mark ? <span className="head-mark"><StateIcon state={mark} size={24} />{title}</span> : title}
        sub={`${one ? one.name : s.apps.length === 1 ? "1 app" : `${s.apps.length} apps`}, ${s.monitors.length === 1 ? "1 monitor" : `${s.monitors.length} monitors`}, ${checkedSoFar(s.monitors)} from ${cities}.`}
        actions={s.can["monitors:write"] && <Link href="/app/monitors/new" className="btn btn-primary"><Plus aria-hidden="true" />Add monitor</Link>}
      />

      {elsewhere > 0 && (
        <div style={{ marginBottom: "var(--s-5)" }}>
          <OtherAppsNote onShowAll={() => setApp("all")}>{elsewhere === 1 ? "One thing needs you" : `${elsewhere} things need you`} in other apps.</OtherAppsNote>
        </div>
      )}

      <Kpis s={s} />

      {(open.length > 0 || degraded.length > 0) && (
        <section className="stack" aria-label="Needs attention" style={{ marginBottom: "var(--s-6)" }}>
          {open.map((i) => {
            const app = s.apps.find((a) => a.id === i.appId);
            return (
              <div key={i.id} className={`alarm ${i.severity === "degraded" ? "warn" : ""}`}>
                <StateIcon state={i.severity} size={20} />
                <div className="alarm-body">
                  <strong>{app?.name}: {i.title}</strong>
                  {(i.evidence.request || i.evidence.summary) && (
                    <span>
                      {i.evidence.request && <code className="code">{i.evidence.request}</code>} {i.evidence.summary}{i.evidence.summary && "."}
                    </span>
                  )}
                  <span className="t-meta">
                    {i.evidence.locations.length ? `Seen from ${i.evidence.locations.map((l) => locations[l].city).join(" and ")} since ` : "Since "}
                    {time(i.openedAt)} {zone(i.openedAt)}, {dur(s.now - i.openedAt)} ago. {i.ackedAt ? "Acknowledged." : "Not acknowledged yet."}
                  </span>
                </div>
                <div className="cluster">
                  <Link href={`/app/incidents/${i.id}`} className="btn btn-primary btn-sm">Open incident</Link>
                  <Copy text={agentBrief(s, i)} label="Copy for agent" />
                </div>
              </div>
            );
          })}
          {degraded.map((m) => {
            const app = s.apps.find((a) => a.id === m.appId);
            const ssl = m.type === "ssl" && m.ssl?.certDays != null;
            const text = ssl
              ? `The certificate for ${m.ssl!.host} expires in ${m.ssl!.certDays} days. Let's Encrypt certificates normally renew 30 days out, so auto-renew has probably stopped.`
              : `Three checks in a row took longer than ${ms(m.slowMs)}.${median(m)} Slow since ${time(m.stateSince)} ${zone(m.stateSince)}.`;
            return (
              <div key={m.id} className="alarm warn">
                <StateIcon state="degraded" size={20} />
                <div className="alarm-body">
                  <strong>{app?.name}: {ssl ? `${m.name} certificate expires soon` : `${m.name} is slow`}</strong>
                  <span>{text}</span>
                  <span className="t-meta">A warning, not an incident. {ssl ? "Reminders go out at 21, 7 and 1 days." : "Nothing is down."}</span>
                </div>
                <div className="cluster">
                  <Link href={`/app/monitors/${m.id}`} className="btn btn-sm">View monitor</Link>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <div className="stack-lg">
        {s.apps.map((a) => {
          const ms_ = s.monitors.filter((m) => m.appId === a.id);
          const page = s.pages.find((p) => p.appId === a.id);
          const status = summarize(ms_);
          const daily = appDaily(ms_, 30);
          const known = daily.filter((v) => v >= 0);
          const avg = known.length ? known.reduce((x, y) => x + y, 0) / known.length : null;
          return (
            <section key={a.id} className="app-block" aria-labelledby={`app-${a.id}`}>
              <div className="app-block-head">
                <div className="stack-sm" style={{ gap: 2 }}>
                  <h2 id={`app-${a.id}`}>
                    <AppLogo app={a} />
                    {a.name}
                    <StateBadge state={status.state} label={status.text} />
                  </h2>
                  <span className="t-meta">
                    {a.url && <>{a.url.replace(/^https?:\/\//, "")}. </>}
                    {page ? <>Status page at <Link className="link" href={`/s/${page.slug}`}>{pageHost(page)}</Link>.</> : "No status page yet."}
                  </span>
                </div>
                {(s.can["monitors:write"] || canDeleteApps(workspace)) && (
                  <div className="cluster">
                    {s.can["monitors:write"] && <>
                      <Link href={`/app/apps/${a.id}/checks`} className="btn btn-sm">Find missing checks</Link>
                      <Link href={`/app/monitors/new?app=${a.id}`} className="btn btn-sm"><Plus aria-hidden="true" />Add monitor</Link>
                    </>}
                    {/* Deleting an app is two clicks and a confirmation away, never one (owner, 2026-10-26). */}
                    {canDeleteApps(workspace) && (
                      <MoreMenu label={`More for ${a.name}`} items={[{ label: "Delete app", icon: <Trash2 aria-hidden="true" />, onSelect: () => { setDoomed(a.id); del.current?.showModal(); } }]} />
                    )}
                  </div>
                )}
                <div className="app-block-bars">
                  <UptimeBars daily={daily} now={s.now} label={`${a.name}, last 30 days`} height={24} compact />
                  <span className="t-meta num">{avg === null ? "No data yet" : `${pct(avg)} over 30 days`}</span>
                </div>
              </div>
              {ms_.length ? (
                <MonitorTable s={s} monitors={ms_} />
              ) : (
                <div className="empty">
                  <strong>No monitors on {a.name} yet.</strong>
                  {s.can["monitors:write"] && <Link href={`/app/monitors/new?app=${a.id}`} className="btn btn-sm btn-primary"><Plus aria-hidden="true" />Add the first one</Link>}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {s.can["monitors:write"] && (
        <section className="add-app-block" aria-label="Add another app">
          {gate === "builder" ? (
            // Free's one app is Builder's to lift. Arriving from the rail's Add app opens the offer.
            <BuilderTag offer="apps" control="btn" open={add}>Add another app</BuilderTag>
          ) : gate === "full" ? (
            <div className="cluster">
              <button type="button" className="btn" disabled aria-describedby="add-app-why"><Plus aria-hidden="true" />Add another app</button>
              <span id="add-app-why" className="t-2">Your plan includes {limitsOf(s).apps} apps, and they&apos;re all in use.</span>
            </div>
          ) : adding ? (
            <div className="panel stack">
              <h2 className="t-h3">Add another app</h2>
              <AddApp
                autoFocus
                findsChecks
                onAdded={(id, url) => {
                  if (url) return router.push(afterAdding(id, url));
                  // Show the new app even if the builder was looking at a different one.
                  setApp("all");
                  setAdding(false);
                  // Clears the rail's ?add=app, so its Add app opens the form again next time.
                  if (add) router.replace("/app", { scroll: false });
                }}
              />
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setAdding(true)}><Plus aria-hidden="true" />Add another app</button>
          )}
        </section>
      )}

      {canDeleteApps(workspace) && <DeleteAppDialog ref={del} s={workspace} appId={doomed} />}
    </>
  );
}

/** The rail's "Add app" lands here with ?add=app, which opens the form. Keyed on it, so
 *  following that link from this screen opens the form too. */
function FromAddress({ s }: { s: Workspace }) {
  const add = useSearchParams().get("add") === "app";
  return <Overview key={String(add)} workspace={s} add={add} />;
}

export function OverviewScreen() {
  const s = useWorkspace();
  usePoll();
  if (!s) return <Loading />;
  return (
    <Suspense>
      <FromAddress s={s} />
    </Suspense>
  );
}
