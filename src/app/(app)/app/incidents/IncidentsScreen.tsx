"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loading, PageHead } from "@/components/Shell";
import { StateIcon } from "@/components/State";
import { Copy } from "@/components/Copy";
import { AppPicker } from "@/components/AppPicker";
import { OtherAppsNote } from "@/components/OtherApps";
import { agentBrief } from "@/lib/agent";
import { ago, dayTime, dur, plural } from "@/lib/format";
import { limitsOf } from "@/lib/plans";
import { useActs, useAppSelection, usePoll, useWorkspace, type Workspace } from "@/lib/workspace-store";

function Incidents({ s }: { s: Workspace }) {
  const router = useRouter();
  const acts = useActs();
  const { app, setApp } = useAppSelection(s);
  const list = s.incidents.filter((i) => app === "all" || i.appId === app).sort((a, b) => b.openedAt - a.openedAt);
  const open = list.filter((i) => !i.resolvedAt);
  const past = list.filter((i) => i.resolvedAt);
  // Open elsewhere: the choice must never make this screen say nothing is down.
  const elsewhere = s.incidents.filter((i) => !i.resolvedAt && app !== "all" && i.appId !== app).length;
  const appName = (id: string) => s.apps.find((a) => a.id === id)?.name ?? "Deleted app";
  const monName = (id: string) => s.monitors.find((m) => m.id === id)?.name ?? "Deleted monitor";
  const checked = s.monitors.some((m) => (app === "all" || m.appId === app) && (m.checked || (m.hb?.lastPingAt ?? 0) > 0));
  const lastClosed = past.reduce((t, i) => Math.max(t, i.resolvedAt ?? 0), 0);

  return (
    <>
      <PageHead
        title="Incidents"
        sub={`An incident opens when a failure is confirmed. History goes back ${limitsOf(s).historyLabel}.`}
        actions={
          s.apps.length > 1 && (
            <>
              <label className="sr-only" htmlFor="i-app">App</label>
              <AppPicker id="i-app" apps={s.apps} value={app} onChange={setApp} allApps />
            </>
          )
        }
      />

      <div className="stack-lg">
        <section className="stack" aria-labelledby="open">
          <h2 id="open" className="t-section">Open</h2>
          {open.length ? (
            open.map((i) => (
              <div key={i.id} className={`alarm ${i.severity === "degraded" ? "warn" : ""}`}>
                <StateIcon state={i.severity} size={20} />
                <div className="alarm-body">
                  <strong>{appName(i.appId)}: {i.title}</strong>
                  {(i.evidence.request || i.evidence.summary) && (
                    <span>{i.evidence.request && <code className="code">{i.evidence.request}</code>} {i.evidence.summary}{i.evidence.summary && "."}</span>
                  )}
                  <span className="t-meta">Open for {dur(s.now - i.openedAt)}. {i.ackedAt ? "Acknowledged." : "Not acknowledged yet."} {plural(i.notes.filter((n) => n.status === "published").length, "update")} published.</span>
                </div>
                <div className="cluster">
                  <Link href={`/app/incidents/${i.id}`} className="btn btn-primary btn-sm">Open incident</Link>
                  {!i.ackedAt && s.can["incidents:draft"] && <button type="button" className="btn btn-sm" onClick={() => acts.ack(i.id)}>Acknowledge</button>}
                  <Copy text={agentBrief(s, i)} label="Copy for agent" />
                </div>
              </div>
            ))
          ) : checked ? (
            // Calm, and still evidence: the up mark, and when the last incident closed.
            <div className="calm">
              <StateIcon state="up" size={20} />
              <p>
                <strong>{app === "all" ? "No open incidents." : `No open incidents in ${appName(app)}.`}</strong>{" "}
                <span>{lastClosed ? `The last one closed ${ago(lastClosed, s.now)}.` : app === "all" ? "Nothing is down right now." : "Nothing in it is down right now."}</span>
              </p>
            </div>
          ) : (
            // Nothing has been checked, so nothing can be called up: the hollow ring says so.
            <div className="calm">
              <StateIcon state="unchecked" size={20} />
              <p>
                <strong>{app === "all" ? "No incidents." : `No incidents in ${appName(app)}.`}</strong>{" "}
                <span>{app === "all" ? "Nothing has been checked yet." : "Nothing in it has been checked yet."}</span>
              </p>
            </div>
          )}
          {elsewhere > 0 && <OtherAppsNote onShowAll={() => setApp("all")}>{plural(elsewhere, "incident")} open in other apps.</OtherAppsNote>}
        </section>

        <section className="stack" aria-labelledby="past">
          <h2 id="past" className="t-section">Resolved</h2>
          {past.length ? (
            <>
              <div className="panel panel-flush scroll-x">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Incident</th>
                      {app === "all" && s.apps.length > 1 && <th scope="col" className="hide-sm">App</th>}
                      <th scope="col">Started</th>
                      <th scope="col" className="r">Lasted</th>
                      <th scope="col" className="hide-sm">Response</th>
                      <th scope="col" className="r">Updates</th>
                    </tr>
                  </thead>
                  <tbody>
                    {past.map((i) => (
                      <tr key={i.id} className="clickable" onClick={() => router.push(`/app/incidents/${i.id}`)}>
                        <td>
                          <Link href={`/app/incidents/${i.id}`} className="mon-name">{i.title}</Link>
                          <div className="t-meta">{monName(i.monitorId)}{i.evidence.summary ? `: ${i.evidence.summary}` : ""}</div>
                        </td>
                        {app === "all" && s.apps.length > 1 && <td className="hide-sm">{appName(i.appId)}</td>}
                        <td className="num">{dayTime(i.openedAt, s.now)}</td>
                        <td className="r num">{dur(i.resolvedAt! - i.openedAt)}</td>
                        <td className="hide-sm">{i.ackedAt ? <span className="t-2">Acknowledged after {dur(i.ackedAt - i.openedAt)}</span> : <span className="t-3">Not acknowledged</span>}</td>
                        <td className="r num">{i.notes.filter((n) => n.status === "published").length || <span className="t-3">None</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="t-meta">Each one closed after two passing checks in a row.</p>
            </>
          ) : (
            <p className="t-2">No resolved incidents in the last {limitsOf(s).historyLabel}.</p>
          )}
        </section>
      </div>
    </>
  );
}

export function IncidentsScreen() {
  const s = useWorkspace();
  usePoll();
  return s ? <Incidents s={s} /> : <Loading />;
}
