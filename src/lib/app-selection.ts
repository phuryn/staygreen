import { worst } from "./derive";
import { isChecking } from "./history";
import type { Sim, State } from "./model";

export const ALL_APPS = "all";
const STORAGE_KEY = "sg-app-selection";

/** A hidden switcher must never leave an invisible filter behind. This also rejects ids from
 *  another workspace and apps deleted since the choice was made. */
export function validAppSelection(apps: Pick<Sim, "apps">["apps"], app: string): string {
  return apps.length > 1 && apps.some((a) => a.id === app) ? app : ALL_APPS;
}

/** Only these collection screens follow the choice. Detail and creation routes keep their
 *  own item; choosing in the rail there (or on a workspace screen) goes to Overview. */
export function appSelectionDestination(path: string): string {
  return ["/app", "/app/monitors", "/app/incidents", "/app/status-pages"].includes(path) ? path : "/app";
}

/** A view, never the source for plan usage, authorization or the row under the logo (`appRow`). */
export function scopeToApp<T extends Pick<Sim, "apps" | "monitors" | "incidents" | "pages">>(s: T, app: string): T {
  const selected = validAppSelection(s.apps, app);
  if (selected === ALL_APPS) return s;
  return {
    ...s,
    apps: s.apps.filter((a) => a.id === selected),
    monitors: s.monitors.filter((m) => m.appId === selected),
    incidents: s.incidents.filter((i) => i.appId === selected),
    pages: s.pages.filter((p) => p.appId === selected),
  };
}

export type StatusLine = { state: State; text: string };

/** A set of monitors in a few words: the worst state with its count, and never an all-clear for
 *  something nobody has checked. */
export function summarize(monitors: Pick<Sim, "monitors">["monitors"]): StatusLine {
  const st = worst(monitors.map((m) => m.state));
  const count = (x: State) => monitors.filter((m) => m.state === x).length;
  if (st === "down") return { state: st, text: `${count("down")} down` };
  if (st === "degraded") return { state: st, text: `${count("degraded")} degraded` };
  if (!monitors.length) return { state: "unchecked", text: "No monitors yet" };
  if (st === "paused") return { state: st, text: "All paused" };
  if (st === "unchecked" || count("unchecked")) {
    const pending = monitors.filter(isChecking).length;
    const fresh = count("unchecked") - pending;
    const text = pending && fresh ? `Checking ${pending}… and ${fresh} not checked yet` : pending ? "Checking…" : "Not checked yet";
    return { state: "unchecked", text };
  }
  return { state: st, text: "All up" };
}

/** The overview's headline when nothing is open or degraded: an all-clear only where `summarize`
 *  gives one, so the page's head and the rail beside it never disagree. A monitor added beside
 *  one that is up, a failure no second location has confirmed, and a set that is all paused each
 *  keep their own word and shape, in the words their rows use: "Not checked yet" before any
 *  check, "Checking…" once a probe has checked it (`history.ts`). `inApp` is " in {app}"
 *  when one app is chosen. */
export function calmHeadline(monitors: Pick<Sim, "monitors">["monitors"], inApp = ""): StatusLine {
  const line = summarize(monitors);
  if (line.state === "up") return { state: "up", text: `Everything${inApp} is working` };
  if (line.state === "paused") return { state: "paused", text: `Every monitor${inApp} is paused` };
  if (line.state !== "unchecked") return line;
  if (!monitors.some((m) => m.checked)) return { state: "unchecked", text: `Nothing${inApp} checked yet` };
  const fresh = monitors.filter((m) => m.state === "unchecked" && !m.checked).length;
  const pending = monitors.filter(isChecking).length;
  const checking = `Checking ${pending} ${pending === 1 ? "monitor" : "monitors"}${inApp}…`;
  const notChecked = (n: number) => (n === 1 ? `1 monitor${inApp} not checked yet` : `${n} monitors${inApp} not checked yet`);
  const text = pending && fresh ? `${checking} and ${fresh} not checked yet` : pending ? checking : notChecked(fresh);
  return { state: "unchecked", text };
}

/** How much of a set the probes have checked, for the line under the overview's headline:
 *  "checked" only when every monitor has been. */
export function checkedSoFar(monitors: Pick<Sim, "monitors">["monitors"]): string {
  const n = monitors.filter((m) => m.checked).length;
  return n === 0 ? "to be checked" : n === monitors.length ? "checked" : `${n} checked so far`;
}

export type FirstCount = { st: State; n: number; label: string; href: string };

/** The overview's first count. It counts only what its label says and what its link lists: Up
 *  never takes in paused monitors, whose rows say Paused. With nothing up it counts the monitors
 *  that say why, in their rows' words: "Not checked yet" only before a probe's first window,
 *  "Checking…" once a failure no second location confirmed has one (`history.ts`), then Paused. */
export function firstCount(monitors: Pick<Sim, "monitors">["monitors"]): FirstCount {
  const count = (x: State) => monitors.filter((m) => m.state === x).length;
  const up = count("up");
  const unchecked = count("unchecked");
  if (unchecked && !up) {
    const pending = monitors.filter(isChecking).length;
    return pending
      ? { st: "unchecked", n: pending, label: "Checking…", href: "/app/monitors?state=checking" }
      : { st: "unchecked", n: unchecked, label: "Not checked yet", href: "/app/monitors?state=unchecked" };
  }
  if (!up && count("paused")) return { st: "paused", n: count("paused"), label: "Paused", href: "/app/monitors?state=paused" };
  return { st: "up", n: up, label: "Up", href: "/app/monitors?state=up" };
}

export type AppRow = {
  /** The one app's name, the chosen app's, or "All apps". */
  label: string;
  /** The state of what the label names. */
  status: StatusLine;
  /** With one app of several chosen, the others that are degraded or down: the choice is how a
   *  builder looks at one app, never how an outage in another goes unseen. */
  others: StatusLine | null;
};

/** The row under the logo, in the rail and on the phone's top bar. Nothing with no app. */
export function appRow(s: Pick<Sim, "apps" | "monitors">, app: string): AppRow | null {
  if (!s.apps.length) return null;
  const chosen = s.apps.length === 1 ? s.apps[0] : s.apps.find((a) => a.id === validAppSelection(s.apps, app));
  if (!chosen) return { label: "All apps", status: summarize(s.monitors), others: null };
  const rest = s.apps.filter((a) => a.id !== chosen.id).map((a) => worst(s.monitors.filter((m) => m.appId === a.id).map((m) => m.state)));
  const down = rest.filter((x) => x === "down").length;
  const degraded = rest.filter((x) => x === "degraded").length;
  const parts = [down && `${down} down`, degraded && `${degraded} degraded`].filter(Boolean);
  return {
    label: chosen.name,
    status: summarize(s.monitors.filter((m) => m.appId === chosen.id)),
    others: parts.length ? { state: down ? "down" : "degraded", text: `Other apps: ${parts.join(", ")}` } : null,
  };
}

/** Reload/history restore this tab's choice. A fresh document visit resets it, including a
 *  new tab whose opener copied sessionStorage. Storage may be unavailable; navigation still works. */
export function readAppSelection(storage: Pick<Storage, "getItem" | "removeItem">, workspaceId: string, navigationType?: string): string {
  try {
    if (navigationType !== "reload" && navigationType !== "back_forward") {
      storage.removeItem(STORAGE_KEY);
      return ALL_APPS;
    }
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (value && typeof value === "object" && "workspaceId" in value && value.workspaceId === workspaceId && "app" in value && typeof value.app === "string") return value.app;
  } catch { /* A preference must not prevent the workspace from opening. */ }
  return ALL_APPS;
}

export function writeAppSelection(storage: Pick<Storage, "setItem">, workspaceId: string, app: string): void {
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ workspaceId, app })); }
  catch { /* Keep the in-memory choice when browser storage is disabled or full. */ }
}
