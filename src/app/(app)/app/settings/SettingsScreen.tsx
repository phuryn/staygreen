"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useClerk, useOrganization } from "@clerk/nextjs";
import { canDeleteApps as mayDeleteApps, DeleteAppDialog } from "@/components/DeleteApp";
import { Loading, PageHead } from "@/components/Shell";
import { BuilderMark, BuilderTag, SoonTag } from "@/components/Tags";
import { currentTheme, setTheme, type ThemeChoice } from "@/components/theme";
import { has, limits, limitsOf } from "@/lib/plans";
import { isLive } from "@/lib/launch";
import { plural } from "@/lib/format";
import { addAppGate } from "@/lib/upgrade";
import { useWorkspace, type Workspace } from "@/lib/workspace-store";
import { AppRow } from "./AppSettings";

/* The workspace is a Clerk organization (`AGENTS.md § 2.3`), so its name, logo and
   members are Clerk's own screen, opened as a modal (`docs/architecture.md`): never a
   form of ours that would have to keep up with it. What is ours is listed below it.

   One card per section, a row per setting: what it is on the left, its control on the right
   (`.set-row`, `design/kit.css`). */

const themes: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "Match my device" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function Settings({ s }: { s: Workspace }) {
  const { organization } = useOrganization();
  const clerk = useClerk();
  const [theme, setT] = useState<ThemeChoice>("system");
  useEffect(() => setT(currentTheme()), []);
  const builder = has(s.plan, "history_1y");
  const name = organization?.name ?? "This workspace";
  const del = useRef<HTMLDialogElement>(null);
  const [doomed, setDoomed] = useState<string | null>(null);
  const canDeleteApps = mayDeleteApps(s);

  return (
    <>
      <PageHead title="Settings" sub="This workspace's name and members, its apps, how the dashboard looks, and what's coming for your data." />

      <section className="section" aria-labelledby="ws-h">
        <h2 id="ws-h" className="t-section">Workspace</h2>
        <div className="panel panel-flush">
          <div className="set-row">
            <div className="set-row-text">
              <strong className="wrap-anywhere">{name}</strong>
              {organization && <span className="t-2">{plural(organization.membersCount, "member")}</span>}
              <p className="t-2 prose">Rename the workspace, change its logo, and invite or remove members.</p>
            </div>
            <div className="set-row-control">
              <button type="button" className="btn" onClick={() => clerk.openOrganizationProfile()}>Manage name and members</button>
            </div>
            <p className="callout callout-info set-row-wide">
              <span>Staygreen has one role for now, admin, and it can do everything. Invite people as admins: anyone with another role can&apos;t open this workspace.</span>
            </p>
          </div>
        </div>
      </section>

      {(s.can["monitors:write"] || (canDeleteApps && s.apps.length > 0)) && (
        <section id="apps" className="section" aria-labelledby="ap-h">
          <div className="section-head">
            <h2 id="ap-h" className="t-section">Apps</h2>
            {/* The overview's add flow, so an app added here gets its suggested checks too (owner,
                2026-10-23: the apps were listed here with no way to add one). */}
            {s.can["monitors:write"] && (addAppGate(s) === "full" ? (
              <span className="t-2">All {limitsOf(s).apps} apps on your plan are in use.</span>
            ) : (
              <Link href="/app?add=app" className="btn btn-sm">
                {addAppGate(s) === "builder" ? <BuilderMark /> : <Plus aria-hidden="true" />}Add app
                {addAppGate(s) === "builder" && <span className="sr-only"> (Builder)</span>}
              </Link>
            ))}
          </div>
          {s.apps.length === 0 ? (
            <div className="panel"><p className="t-2">No apps yet.</p></div>
          ) : <ul className="panel panel-flush" role="list">
            {s.apps.map((a) => (
              <AppRow key={a.id} s={s} app={a} onDelete={canDeleteApps ? () => { setDoomed(a.id); del.current?.showModal(); } : null} />
            ))}
          </ul>}
        </section>
      )}

      <section className="section" aria-labelledby="th-h">
        <h2 id="th-h" className="t-section">Appearance</h2>
        <div className="panel panel-flush">
          <div className="set-row">
            <div className="set-row-text">
              <strong id="th-l">Theme</strong>
              <span className="hint">Saved in this browser. Your status pages keep their own theme, which you set in each page&apos;s editor.</span>
            </div>
            <div className="set-row-control">
              <div className="seg st-seg" role="radiogroup" aria-labelledby="th-l">
                {themes.map((t) => (
                  <label key={t.id}>
                    <input type="radio" name="theme" checked={theme === t.id} onChange={() => { setTheme(t.id); setT(t.id); }} />
                    <span>{t.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" aria-labelledby="ex-h">
        <div className="section-head">
          <h2 id="ex-h" className="t-section cluster">CSV export <BuilderTag locked={!builder} offer="history" />{!isLive("csvExport") && <SoonTag />}</h2>
        </div>
        <div className="panel panel-flush">
          <div className="set-row">
            <p className="t-2 prose">Builder keeps {limits.builder.historyLabel} of daily uptime. Free keeps {limits.free.historyLabel}. CSV export is planned for daily uptime and incidents, including when each opened, was acknowledged and recovered.</p>
          </div>
        </div>
      </section>

      {s.can["workspace:delete"] && (
        <section className="section" aria-labelledby="dz-h">
          <h2 id="dz-h" className="t-section cluster">Delete the workspace <SoonTag /></h2>
          <div className="panel panel-flush pb-danger">
            <div className="set-row">
              <div className="set-row-text">
                <p className="t-2 prose">
                  Deleting {name} will remove every monitor, status page and incident in it at once, and nothing can be recovered afterwards. It isn&apos;t built yet.
                </p>
                {organization?.adminDeleteEnabled && (
                  <p className="t-2 prose">
                    Until it is, don&apos;t delete the workspace from Manage name and members. That removes everyone&apos;s access, but its monitors stay stored and its status pages stay public.
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      <DeleteAppDialog ref={del} s={s} appId={doomed} />
    </>
  );
}

export function SettingsScreen() {
  const s = useWorkspace();
  return s ? <Settings s={s} /> : <Loading />;
}
