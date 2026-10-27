"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { appRow, appSelectionDestination, summarize, type AppRow as Row } from "@/lib/app-selection";
import { limits, limitsOf } from "@/lib/plans";
import { addAppGate } from "@/lib/upgrade";
import { useAppSelection, type Workspace } from "@/lib/workspace-store";
import { AppLogo } from "./AppLogo";
import { StateIcon } from "./State";
import { BuilderMark } from "./Tags";

/** The app's state under its name, then, with one app of several chosen, what is wrong in the
 *  others. Each line is a shape, a word and a colour, like every state in the product. */
function StatusLines({ row }: { row: Row }) {
  return (
    <span className="rail-app-status">
      {[row.status, row.others].map((line, i) =>
        line ? (
          <span key={i} className={`rail-sum ${line.state}`}>
            <StateIcon state={line.state} size={12} />
            {line.text}
          </span>
        ) : null,
      )}
    </span>
  );
}

/** The app row under the logo in the rail and the phone drawer: the app's name with its state,
 *  and with two or more apps the switcher in place of the name. Nothing until there is an app. */
export function AppRow({ s, onNavigate }: { s: Workspace; onNavigate?: () => void }) {
  const { app } = useAppSelection(s);
  const row = appRow(s, app);
  if (!row) return null;
  return (
    <div className="rail-app">
      {s.apps.length > 1 ? (
        <AppSwitcher s={s} onNavigate={onNavigate} />
      ) : (
        <span className="rail-app-one"><AppLogo app={s.apps[0]} size={20} /><span className="rail-app-name">{row.label}</span></span>
      )}
      <StatusLines row={row} />
    </div>
  );
}

/** The same row on the phone's top bar, where the drawer holds the switcher. */
export function AppLine({ s }: { s: Workspace }) {
  const { app } = useAppSelection(s);
  const row = appRow(s, app);
  if (!row) return null;
  return (
    <div className="topbar-app">
      <span className="topbar-app-name">{row.label}</span>
      <StatusLines row={row} />
    </div>
  );
}

/** The kit's native popover, shared by the desktop rail and the phone drawer. */
export function AppSwitcher({ s, onNavigate }: { s: Workspace; onNavigate?: () => void }) {
  const { app, setApp } = useAppSelection(s);
  const path = usePathname();
  const router = useRouter();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const lastOnOpen = useRef(false);
  const anchor = useRef<DOMRect | null>(null);

  useEffect(() => {
    const close = (event: Event) => {
      // The list itself can scroll when a workspace has many apps; it stays open then.
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      // A navigation can scroll the document after the sticky rail's menu opened. If the
      // control stayed put, the menu is still correctly placed and must keep that click.
      const box = trigger.current?.getBoundingClientRect();
      const was = anchor.current;
      if (event.type === "scroll" && box && was && box.left === was.left && box.bottom === was.bottom && box.width === was.width) return;
      menu.current?.hidePopover();
    };
    window.addEventListener("resize", close);
    document.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      document.removeEventListener("scroll", close, true);
    };
  }, []);

  if (s.apps.length < 2) return null;
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
  function choose(value: string) {
    setApp(value);
    menu.current?.hidePopover();
    trigger.current?.focus();
    onNavigate?.();
    const destination = appSelectionDestination(path);
    if (destination !== path) router.push(destination);
  }
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    const options = items();
    const index = options.indexOf(document.activeElement as HTMLElement);
    let next: number | undefined;
    if (event.key === "ArrowDown") next = (index + 1) % options.length;
    if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = options.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      options[next]?.focus();
    } else if (event.key === "Tab") {
      menu.current?.hidePopover();
      trigger.current?.focus();
    }
  }
  const label = s.apps.find((a) => a.id === app)?.name ?? "All apps";
  return (
    <div className="rail-switcher">
      <button
        ref={trigger} type="button" className="btn rail-switch" popoverTarget={id}
        aria-haspopup="menu" aria-label={`App: ${label}`}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          lastOnOpen.current = event.key === "ArrowUp";
          menu.current?.showPopover();
        }}
      >
        <span className="grow">{label}</span><ChevronDown aria-hidden="true" />
      </button>
      <div
        ref={menu} id={id} popover="auto" className="pop rail-app-menu" role="menu" aria-label="Choose app"
        onKeyDown={onKey}
        onBeforeToggle={(event) => {
          if (event.newState !== "open" || !trigger.current) return;
          const box = trigger.current.getBoundingClientRect();
          anchor.current = box;
          Object.assign(event.currentTarget.style, {
            left: `${box.left}px`, top: `${box.bottom}px`, width: `${box.width}px`,
            maxHeight: `calc(100dvh - ${box.bottom}px - var(--s-3))`,
          });
        }}
        onToggle={(event) => {
          if (event.newState !== "open") return;
          const options = items();
          (lastOnOpen.current ? options.at(-1) : options.find((item) => item.getAttribute("aria-checked") === "true"))?.focus();
          lastOnOpen.current = false;
        }}
      >
        <button type="button" role="menuitemradio" aria-checked={app === "all"} tabIndex={-1} className="rail-app-option" onClick={() => choose("all")}>All apps</button>
        {s.apps.map((a) => {
          const status = summarize(s.monitors.filter((m) => m.appId === a.id));
          return (
            <button key={a.id} type="button" role="menuitemradio" aria-checked={app === a.id} aria-label={`${a.name}, ${status.text}`} tabIndex={-1} className="rail-app-option" onClick={() => choose(a.id)}>
              {/* The same shapes as everywhere else, the hollow ring for Not checked yet included. */}
              <StateIcon state={status.state} size={12} />
              <AppLogo app={a} size={20} />
              {/* Named by aria-label, which carries the state's word: read from its content, the name would have no state at all. */}
              <span className="grow">{a.name}</span>
            </button>
          );
        })}
        {s.can["monitors:write"] && addAppGate(s) === "full" ? (
          // Every app Builder includes is in use: say so here rather than send the builder to a
          // disabled button on the overview.
          <span role="menuitem" aria-disabled="true" tabIndex={-1} className="rail-app-option rail-app-add t-2">
            <Plus aria-hidden="true" />All {limitsOf(s).apps} apps in use
          </span>
        ) : s.can["monitors:write"] && (
          <Link href="/app?add=app" role="menuitem" tabIndex={-1} className="rail-app-option rail-app-add" onClick={() => { menu.current?.hidePopover(); onNavigate?.(); }}>
            {/* Past Free's one app it lands on the overview with the Builder offer open, and says so first. */}
            {addAppGate(s) === "builder" ? <BuilderMark /> : <Plus aria-hidden="true" />}Add app
            {addAppGate(s) === "builder" && <span className="sr-only"> (Builder)</span>}
          </Link>
        )}
      </div>
    </div>
  );
}
