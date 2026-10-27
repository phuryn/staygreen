"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { OrganizationSwitcher, UNSAFE_PortalProvider, UserButton } from "@clerk/nextjs";
import { Activity, Bell, Bot, CreditCard, Gauge, LayoutDashboard, LifeBuoy, Menu, PanelsTopLeft, Settings, Siren, X } from "lucide-react";
import { openIncidents } from "@/lib/derive";
import { isBuilt, isLive, type LaunchArea } from "@/lib/launch";
import { pendingPathOf } from "@/lib/navigation";
import { limitsOf } from "@/lib/plans";
import { useWorkspace, type Workspace } from "@/lib/workspace-store";
import { Logo } from "./Logo";
import { AppLine, AppRow } from "./AppSwitcher";
import { SoonTag } from "./Tags";
import { Toasts } from "./Toasts";
import { DocTitle } from "@/components/DocTitle";

// Every screen of the dashboard, in the order a builder meets the jobs. A screen whose area
// isn't built yet (`launch.ts`) is still listed, so the whole product is in view, and says
// "Soon" here and "Coming soon" on the screen; it never shows a control that does nothing.
// Its icons draw at stroke 1.75, as the type and channel icons do.
const nav: { href: string; label: string; icon: typeof Activity; area?: LaunchArea }[] = [
  { href: "/app", label: "Overview", icon: LayoutDashboard },
  { href: "/app/monitors", label: "Monitors", icon: Activity },
  { href: "/app/incidents", label: "Incidents", icon: Siren },
  { href: "/app/alerts", label: "Alerts", icon: Bell, area: "alerts" },
  { href: "/app/status-pages", label: "Status pages", icon: PanelsTopLeft },
  // Listed under the badge, the piece of it that works; its banner and pill say Coming soon there.
  { href: "/app/widget", label: "Widget and badge", icon: Gauge, area: "badge" },
  { href: "/app/agents", label: "Agents and API", icon: Bot, area: "agentMcp" },
];

const foot = [
  { href: "/app/billing", label: "Plan and billing", icon: CreditCard },
  { href: "/app/settings", label: "Settings", icon: Settings },
];

/** Where a click on a dashboard link is taking the builder, from the click until that screen is
 *  there: the rail marks it at once and the main panel says it is busy, so a click is answered
 *  before the server is (`docs/architecture.md § Feeds and polling`). A link to the screen already
 *  shown, to a new tab or away from the dashboard waits for nothing, so it marks nothing. */
function usePendingPath(path: string): string | null {
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    // Not `defaultPrevented`: `<Link>` itself prevents the default, to navigate in place.
    const onClick = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      const modified = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
      const to = pendingPathOf({ button: e.button, modified, href: a.href, target: a.target, download: a.hasAttribute("download") }, location);
      if (to) setPending(to);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  // The screen arrived, or the builder went elsewhere (back, a redirect): nothing is pending.
  useEffect(() => setPending(null), [path]);
  // A navigation that never lands (one a handler cancelled, a dropped connection) can't leave the
  // screen marked busy.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(null), 15_000);
    return () => clearTimeout(timer);
  }, [pending]);
  return pending;
}

function Rail({ s, at, onNavigate }: { s: Workspace | null; at: string; onNavigate?: () => void }) {
  const isOn = (href: string) => (href === "/app" ? at === "/app" : at.startsWith(href));
  const L = s ? limitsOf(s) : null;
  const used = s?.monitors.filter((m) => !m.auto).length ?? 0;
  const hb = s?.monitors.filter((m) => m.type === "heartbeat").length ?? 0;
  // Every app's, like the other-apps line under the switcher: an app chosen there can't hide an
  // outage in another.
  const open = s ? openIncidents(s).length : 0;
  return (
    <div className="rail-inner">
      <div className="rail-top">
        <Link href="/app" className="rail-brand" onClick={onNavigate}>
          <Logo />
        </Link>
      </div>

      {s && <AppRow s={s} onNavigate={onNavigate} />}

      <nav aria-label="Main" className="rail-group">
        <ul>
          {nav.map((n) => (
            <li key={n.href}>
              <Link href={n.href} className="rail-link" aria-current={isOn(n.href) ? "page" : undefined} onClick={onNavigate}>
                <n.icon aria-hidden="true" strokeWidth={1.75} />
                <span className="grow">{n.label}</span>
                {n.href === "/app/incidents" && open > 0 && <span className="rail-count num">{open} open</span>}
                {n.area && !isBuilt(n.area) && <span className="rail-soon">Soon</span>}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="rail-foot">
        {s && L && (
          <Link href="/app/billing" className="plan-box" onClick={onNavigate} aria-label={`${s.plan === "builder" ? "Builder" : "Free"} plan: ${used} of ${L.monitors} monitors, ${hb} of ${L.heartbeats} heartbeats. Plan and billing`}>
            <span className="spread">
              <strong>{s.plan === "builder" ? "Builder" : "Free"}</strong>
              <span className="t-meta num">{used} of {L.monitors} monitors</span>
            </span>
            <span className={`meter ${used / L.monitors > 0.9 ? "full" : ""}`}>
              <span style={{ width: `${Math.min(100, (used / L.monitors) * 100)}%` }} />
            </span>
            <span className="t-meta"><span className="num">{hb} of {L.heartbeats}</span> heartbeats, {L.httpIntervalMin}-minute checks</span>
          </Link>
        )}
        <nav aria-label="Workspace settings" className="rail-group">
          <ul>
            {foot.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="rail-link" aria-current={isOn(n.href) ? "page" : undefined} onClick={onNavigate}>
                  <n.icon aria-hidden="true" strokeWidth={1.75} />
                  <span className="grow">{n.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {/* The public /support page, the same one the site's footer links: one place for
            everyone, so a member's question and a stranger's get the same answers. */}
        <nav aria-label="Help" className="rail-group">
          <ul>
            <li>
              <Link href="/support" className="rail-link" onClick={onNavigate}>
                <LifeBuoy aria-hidden="true" strokeWidth={1.75} />
                <span className="grow">Support</span>
              </Link>
            </li>
          </ul>
        </nav>
        <div className="rail-user">
          <div className="rail-org">
            <OrganizationSwitcher hidePersonal afterSelectOrganizationUrl="/app" afterCreateOrganizationUrl="/app" />
          </div>
          <UserButton />
        </div>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const s = useWorkspace();
  const drawer = useRef<HTMLDialogElement>(null);
  const path = usePathname();
  const pending = usePendingPath(path);
  const at = pending ?? path;
  useEffect(() => {
    drawer.current?.close();
  }, [path]);
  return (
    <div className="shell">
      <a href="#main" className="skip">Skip to content</a>
      <aside className="rail" aria-label="Workspace">
        <Rail s={s} at={at} />
      </aside>
      <header className="topbar">
        <Link href="/app" aria-label="Overview">
          <Logo />
        </Link>
        {s && <AppLine s={s} />}
        <button type="button" className="btn btn-icon btn-quiet" aria-label="Open menu" onClick={() => drawer.current?.showModal()}>
          <Menu aria-hidden="true" />
        </button>
      </header>
      <dialog ref={drawer} className="drawer" aria-label="Menu" onClick={(e) => { if (e.target === drawer.current) drawer.current?.close(); }}>
        <button type="button" className="btn btn-icon btn-quiet drawer-x" aria-label="Close menu" onClick={() => drawer.current?.close()}>
          <X aria-hidden="true" />
        </button>
        {/* A modal dialog is the top layer and makes the page behind it inert, so Clerk's switcher
            and account menus, portaled to <body> by default, would open under it and out of reach.
            Inside the drawer they portal into it instead. */}
        <UNSAFE_PortalProvider getContainer={() => drawer.current}>
          {/* The drawer scrolls here, so the menus portaled into the drawer itself aren't clipped
              to its width: the workspace switcher's is wider than a phone's drawer. */}
          <div className="drawer-scroll">
            <Rail s={s} at={at} onNavigate={() => drawer.current?.close()} />
          </div>
        </UNSAFE_PortalProvider>
      </dialog>
      <main id="main" className="main" aria-busy={pending ? true : undefined}>
        {children}
      </main>
      <Toasts />
    </div>
  );
}

/** A screen's panel for an area that isn't built yet (`launch.ts`): what it will do, then the
 *  plain truth about when. Never a control: nothing on it pretends to work. */
export function SoonPanel({ id, title, area, children, when }: { id: string; title: string; area: LaunchArea; children: React.ReactNode; when?: string }) {
  return (
    <section className="panel stack soon-panel" aria-labelledby={id}>
      <div className="row"><h2 id={id} className="t-section">{title}</h2><SoonTag /></div>
      {children}
      <p className="t-2">
        {when ??
          (isLive(area)
            ? "It's being built now, and it's included in every plan."
            : "It isn't on sale yet, because we haven't finished proving it works. We'd rather tell you that than sell a screen. Your plan already includes it, so there's nothing to upgrade when it ships.")}
      </p>
    </section>
  );
}

/** What a screen shows while its first client render is pending. */
export function Loading() {
  return <div className="loading t-meta">Loading your workspace…</div>;
}

// The browser tab takes `doc`, or the title when it is plain text.
export function PageHead({ title, sub, actions, back, doc }: { title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode; back?: { href: string; label: string }; doc?: string }) {
  const tab = doc ?? (typeof title === "string" ? title : undefined);
  return (
    <header className="page-head">
      {tab && <DocTitle title={`${tab} – Staygreen`} />}
      {back && (
        <Link href={back.href} className="back">
          {back.label}
        </Link>
      )}
      <div className="spread page-head-row">
        <div className="stack-sm grow">
          <h1 className="t-title">{title}</h1>
          {sub && <div className="t-2">{sub}</div>}
        </div>
        {actions && <div className="cluster">{actions}</div>}
      </div>
    </header>
  );
}
