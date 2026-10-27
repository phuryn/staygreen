"use client";

import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { Loading, PageHead } from "@/components/Shell";
import { MonitorTable } from "@/components/MonitorTable";
import { AppPicker } from "@/components/AppPicker";
import { useAppSelection, usePoll, useWorkspace, type Workspace } from "@/lib/workspace-store";
import { typeLabel } from "@/lib/model";
import type { MonitorType, State } from "@/lib/model";
import { isChecking } from "@/lib/history";
import { limitsOf } from "@/lib/plans";

function Monitors({ s }: { s: Workspace }) {
  const params = useSearchParams();
  const { app, setApp } = useAppSelection(s);
  const [type, setType] = useState<"all" | MonitorType>("all");
  const fromLink = params.get("state");
  const [state, setState] = useState<"all" | State | "checking">(
    fromLink === "up" || fromLink === "degraded" || fromLink === "down" || fromLink === "paused" || fromLink === "unchecked" || fromLink === "checking" ? fromLink : "all",
  );
  const [q, setQ] = useState("");
  const L = limitsOf(s);

  const list = useMemo(
    () =>
      s.monitors
        .filter((m) => app === "all" || m.appId === app)
        .filter((m) => type === "all" || m.type === type)
        .filter((m) => state === "all" || (isChecking(m) ? "checking" : m.state) === state)
        .filter((m) => !q || `${m.name} ${m.target}`.toLowerCase().includes(q.toLowerCase()))
        .sort((a, b) => rank(a.state) - rank(b.state)),
    [s, app, type, state, q],
  );
  const types = [...new Set(s.monitors.map((m) => m.type))];
  const used = s.monitors.filter((m) => !m.auto).length;

  return (
    <>
      <PageHead
        title="Monitors"
        sub={`${used} of ${L.monitors} on ${s.plan === "builder" ? "Builder" : "Free"}. Problems sort to the top.`}
        actions={s.can["monitors:write"] && <Link href={`/app/monitors/new${app !== "all" ? `?app=${app}` : ""}`} className="btn btn-primary"><Plus aria-hidden="true" />Add monitor</Link>}
      />
      <div className="filters" role="search" style={{ marginBottom: "var(--s-4)" }}>
        <label className="sr-only" htmlFor="f-q">Search monitors</label>
        <input id="f-q" className="input" type="search" placeholder="Search by name or address" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sr-only" htmlFor="f-app">App</label>
        <AppPicker id="f-app" apps={s.apps} value={app} onChange={setApp} allApps />
        <label className="sr-only" htmlFor="f-type">Type</label>
        <select id="f-type" className="select" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
          <option value="all">All types</option>
          {types.map((t) => <option key={t} value={t}>{typeLabel[t]}</option>)}
        </select>
        <label className="sr-only" htmlFor="f-state">State</label>
        <select id="f-state" className="select" value={state} onChange={(e) => setState(e.target.value as typeof state)}>
          <option value="all">Any state</option>
          <option value="down">Down</option>
          <option value="degraded">Degraded</option>
          <option value="up">Up</option>
          <option value="checking">Checking…</option>
          <option value="unchecked">Not checked yet</option>
          <option value="paused">Paused</option>
        </select>
      </div>
      <div className="panel panel-flush">
        {!s.monitors.length ? (
          <div className="empty">
            <strong>No monitors yet.</strong>
            <span className="t-meta">Add your app's address and Staygreen will check it from two cities once checks start.</span>
            {s.can["monitors:write"] && <Link href="/app/monitors/new" className="btn btn-sm btn-primary"><Plus aria-hidden="true" />Add monitor</Link>}
          </div>
        ) : list.length ? (
          <MonitorTable s={s} monitors={list} showApp={app === "all"} />
        ) : (
          <div className="empty">
            <strong>No monitors match these filters.</strong>
            <button type="button" className="btn btn-sm" onClick={() => { setApp("all"); setType("all"); setState("all"); setQ(""); }}>Clear filters</button>
          </div>
        )}
      </div>
    </>
  );
}

const rank = (s: State) => ({ down: 0, degraded: 1, up: 2, unchecked: 3, paused: 4 })[s];

/** State links from Overview reset the screen's local filters. The app choice lives in the
 *  workspace provider, never in the address, so a normal rail link cannot lose it. */
function FromAddress({ s }: { s: Workspace }) {
  const params = useSearchParams();
  return <Monitors key={params.get("state")} s={s} />;
}

export function MonitorsScreen() {
  const s = useWorkspace();
  usePoll();
  if (!s) return <Loading />;
  return (
    <Suspense>
      <FromAddress s={s} />
    </Suspense>
  );
}
