"use client";

import { statusHost } from "@/lib/status-host";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Loading, PageHead } from "@/components/Shell";
import { StateBadge } from "@/components/State";
import { BuilderTag } from "@/components/Tags";
import { Copy } from "@/components/Copy";
import { AppPicker } from "@/components/AppPicker";
import { pageHost, pageUrl } from "@/lib/derive";
import { limitsOf } from "@/lib/plans";
import { plural } from "@/lib/format";
import { pageState, shownComponents } from "@/components/status/data";
import { useActs, useAppSelection, useWorkspace, type Workspace } from "@/lib/workspace-store";
import { scopeToApp } from "@/lib/app-selection";

function StatusPages({ s }: { s: Workspace }) {
  const router = useRouter();
  const acts = useActs();
  const { app } = useAppSelection(s);
  const view = scopeToApp(s, app);
  const L = limitsOf(s);
  const free = view.apps.filter((a) => !s.pages.some((p) => p.appId === a.id));
  const [appId, setAppId] = useState(free[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const chosen = free.some((a) => a.id === appId) ? appId : (free[0]?.id ?? "");
  const atLimit = s.pages.length >= L.statusPages;
  // Free's limit is Builder's to lift, so the button stays and carries the Builder mark; Builder's
  // own limit has nothing above it, so there the button is disabled and the sentence says why.
  const gated = atLimit && s.plan === "free";
  const manage = s.can["pages:manage"];
  const blocked = atLimit || free.length === 0 || busy;

  async function add() {
    if (blocked || !chosen) return;
    setBusy(true);
    const r = await acts.addPage(chosen);
    if (r.ok) router.push(`/app/status-pages/${r.id}`);
    else setBusy(false);
  }

  return (
    <>
      <PageHead
        title="Status pages"
        sub={<>One public page per app, at its own <span className="addr">{statusHost()}</span> address. {s.pages.length} of {L.statusPages} used on {s.plan === "builder" ? "Builder" : "Free"}.</>}
      />

      {manage && s.apps.length > 0 && (
        <section className="spl-new" aria-label="New status page">
          <div className="field">
            <label className="label" htmlFor="spl-app">App</label>
            <AppPicker id="spl-app" apps={free} value={chosen} onChange={setAppId} disabled={atLimit}
              emptyMessage={app === "all" ? "Every app has a page" : "This app has a page"} />
          </div>
          {gated ? (
            <BuilderTag offer="statusPages" control="btn btn-primary">New status page</BuilderTag>
          ) : (
            <button type="button" className="btn btn-primary" disabled={blocked} aria-busy={busy} aria-describedby={atLimit || free.length === 0 ? "spl-why" : undefined} onClick={add}>
              <Plus aria-hidden="true" />
              {busy ? "Making the page…" : "New status page"}
            </button>
          )}
          {(atLimit || free.length === 0) && (
            <div id="spl-why" className="spl-why">
              {gated ? (
                <span className="t-2">Free includes {plural(L.statusPages, "status page")}, and {s.pages.length === 1 ? "you're using it" : `you're using ${s.pages.length}`}.</span>
              ) : atLimit ? (
                <span className="t-2">Builder includes {L.statusPages} status pages, and all of them are in use.</span>
              ) : (
                <span className="t-2">{app === "all" ? "Every app already has a status page. Add an app first." : "This app already has a status page. Choose All apps to see the others."}</span>
              )}
            </div>
          )}
        </section>
      )}

      {view.pages.length === 0 ? (
        <div className="panel empty">
          <strong className="t-section">{app === "all" ? "No status pages yet" : "No status page for this app yet"}</strong>
          <p className="t-2">
            {s.apps.length
              ? "A status page tells your users what is working, in your brand. It starts with one component for each HTTP monitor of the app."
              : <>A status page belongs to an app. <Link href="/app" className="link">Add your first app</Link> to make one.</>}
          </p>
        </div>
      ) : (
        <div className="panel panel-flush">
          <div className="scroll-x">
            <table className="table spl-table">
              <thead>
                <tr>
                  <th>Page</th>
                  <th>Visitors see</th>
                  <th className="hide-sm">Address</th>
                  <th className="r hide-sm">Components</th>
                  <th className="r"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {view.pages.map((p) => {
                  const app = s.apps.find((a) => a.id === p.appId);
                  // Only reachable by leaving the Builder simulation; the page is still served (BACKLOG.md).
                  const over = s.pages.indexOf(p) >= L.statusPages;
                  const shown = shownComponents(p).length;
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link href={`/app/status-pages/${p.id}`} className="row-link">{p.name}</Link>
                        <div className="t-meta">{app?.name}{over ? ". Over your plan's limit" : ""}</div>
                        <div className="t-meta spl-addr-sm"><span className="addr">{pageHost(p)}</span><Copy text={pageUrl(p)} label="Copy address" icon /></div>
                      </td>
                      <td>
                        {shown === 0 ? <span className="t-3">Nothing yet</span> : <StateBadge state={pageState(s, p)} publicFacing />}
                      </td>
                      <td className="hide-sm"><div className="spl-addr-cell"><span className="addr spl-addr">{pageHost(p)}</span><Copy text={pageUrl(p)} label="Copy address" icon /></div></td>
                      <td className="r num hide-sm">
                        {p.components.length}
                        {shown < p.components.length && <div className="t-meta">{p.components.length - shown} without a monitor</div>}
                      </td>
                      <td className="r">
                        <div className="spl-actions">
                          {manage && <Link href={`/app/status-pages/${p.id}`} className="btn btn-sm">Edit page</Link>}
                          <Link href={`/s/${p.slug}`} className="btn btn-sm" target="_blank">View public page</Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

export function StatusPagesScreen() {
  const s = useWorkspace();
  return s ? <StatusPages s={s} /> : <Loading />;
}
