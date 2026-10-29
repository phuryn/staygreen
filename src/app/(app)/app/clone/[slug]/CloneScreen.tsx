"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useOrganization } from "@clerk/nextjs";
import { AppLogo } from "@/components/AppLogo";
import { MonitorIdentity } from "@/components/MonitorTable";
import { Loading, PageHead } from "@/components/Shell";
import { BuilderTag } from "@/components/Tags";
import type { DemoPreview } from "@/lib/demo-clone";
import { useActs, useWorkspace } from "@/lib/workspace-store";
import type { CloneResult } from "./actions";

export function CloneScreen({ slug, demo }: { slug: string; demo: DemoPreview }) {
  const s = useWorkspace();
  const acts = useActs();
  const router = useRouter();
  const { organization } = useOrganization();
  const workspaceName = organization?.name.trim();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Extract<CloneResult, { ok: false }> | null>(null);
  if (!s) return <Loading />;
  if (!s.can["monitors:write"] || !s.can["pages:manage"]) return null;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setResult(null);
    const r = await acts.cloneDemo(slug);
    setBusy(false);
    if (!r.ok) { setResult(r); return; }
    router.push(`/app/apps/${r.appId}/checks`);
  }
  return <>
    <PageHead title={`Clone ${demo.page.name}`} sub={workspaceName ? `Copy into ${workspaceName}.` : "Copy this demo into your workspace."} />
    <form className="panel stack" onSubmit={submit}>
      <div className="stack-sm">
        <h2 className="t-section row"><AppLogo app={demo.app} size={32} />{demo.app.name}</h2>
        <p className="addr">{demo.app.url || "No app address"}</p>
        <p>Your copy starts members-only. Publish it from the status page editor when you&apos;re ready.</p>
        <p className="t-2">The app&apos;s branding and page layout are copied. History, incidents, subscribers and custom domains stay behind.</p>
      </div>
      <section className="stack-sm" aria-label="Checks to copy">
        <h2 className="t-section">Checks to copy</h2>
        <p className="t-2">Checks that fit your plan are copied in the page&apos;s component order, with your plan&apos;s interval and locations.</p>
        {demo.monitors.some(m => m.copyable) ? <CloneChecks monitors={demo.monitors.filter(m => m.copyable)} /> : <p className="t-2">No checks can be copied from this page.</p>}
      </section>
      {demo.monitors.some(m => !m.copyable) && <section className="stack-sm" aria-label="Checks not copied">
        <h2 className="t-section">Checks not copied</h2>
        <CloneChecks monitors={demo.monitors.filter(m => !m.copyable)} needsKey />
      </section>}
      <p className="t-2">Next, see the suggested checks for this app, with the copied checks under Already covered.</p>
      {result && <div className="callout callout-warn" role="alert"><div className="stack-sm">
        <p>{result.reason}</p>
        {result.duplicateAppId && <Link className="link" href={`/app/apps/${result.duplicateAppId}/checks`}>Open your app</Link>}
        {result.appLimit && s.plan === "free" && <BuilderTag locked offer="apps" id="clone-app-offer" />}
      </div></div>}
      <div><button className="btn btn-primary" type="submit" disabled={busy} aria-busy={busy}>{busy ? "Cloning…" : "Clone"}</button></div>
    </form>
  </>;
}

function CloneChecks({ monitors, needsKey = false }: { monitors: DemoPreview["monitors"]; needsKey?: boolean }) {
  return <div className="scroll-x"><table className="table">
    <thead className="sr-only"><tr><th>Monitor</th>{needsKey && <th>Why it is not copied</th>}</tr></thead>
    <tbody>{monitors.map((m, i) => <tr key={i}>
      <td><MonitorIdentity monitor={m.copyable ? m : { name: m.name, type: m.type }} /></td>
      {needsKey && <td className="t-meta">needs your own key</td>}
    </tr>)}</tbody>
  </table></div>;
}
