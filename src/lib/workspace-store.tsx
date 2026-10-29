"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useMounted } from "./use-mounted";
import { useRouter } from "next/navigation";
import { cloneDemo } from "@/app/(app)/app/clone/[slug]/actions";
import type { CloneReceipt } from "./demo-clone";
import { createToken, revokeToken } from "@/app/(app)/app/agents/actions";
import {
  ackIncident,
  addApp,
  addMonitor,
  addPage,
  addSuggestedChecks,
  deleteApp,
  deleteMonitor,
  deleteNote,
  deletePage,
  pauseMonitor,
  removeAppLogo,
  resumeMonitor,
  rotateHeartbeat,
  saveNote,
  savePage,
  reservePageDomain, verifyPageDomain, checkPageDomain, removePageDomain,
  suggestChecks,
  testMonitor,
  updateApp,
  updateMonitor,
  uploadAppLogo,
  uploadPageAsset,
  removePageAsset,
  type Result,
} from "@/app/(app)/app/actions";
import type { NoteState, Snapshot, Toast } from "./model";
import type { PageAssetKind } from "./page-assets";
import type { Picks } from "./suggestions";
import { ALL_APPS, readAppSelection, validAppSelection, writeAppSelection } from "./app-selection";
import { newerSnapshot } from "./navigation";
import { POLL_CHECK_MS, pollDue } from "./poll";

/* The dashboard's client side: what a screen reads, and how it writes.

   Each page loads the workspace on the server (`workspace.ts`) and hands it
   down in <WorkspaceSnapshot>. Every screen, and the shell around it, reads the
   newest copy any page has handed up, so the rail and the page never disagree
   for longer than one render. The newest is usually the page's own; it is an
   older one when the router shows a page it kept from a visit in the last 30
   seconds (`staleTimes`, `next.config.ts`), and then the screen shows what the
   last page brought rather than what that visit did.

   A write is a Server Action (`actions.ts`) through `useActs`, the one wrapper
   that turns a rejection into a sentence, toasts what happened, and refreshes
   the page so the next snapshot carries the change.

   The probes change monitors behind the builder's back, so a screen that shows
   them calls `usePoll`, and the root refreshes the page once a minute while it
   is in view (`poll.ts`), every five seconds instead while it shows a monitor
   that is about to get its first numbers (`useEagerPoll`). A form with unsaved
   input holds the poll
   (`useHoldPoll`), and so does every write until it has answered. A refresh
   keeps client state, so nothing typed would be lost; the hold is so a form
   never changes under the hand that's filling it. */

export type Workspace = Snapshot & { toasts: Toast[] };

type Root = {
  cloneReceipt: CloneReceipt | null;
  setCloneReceipt(receipt: CloneReceipt): void;
  latest: Snapshot | null;
  offer(s: Snapshot): void;
  now: number | null;
  toasts: Toast[];
  toast(t: Omit<Toast, "id" | "t">): void;
  dismiss(id: string): void;
  app: string;
  selectApp(app: string): void;
  /** Counts a screen that polls, a hold on the poll, or a wait for first numbers, until the
   *  returned function is called. */
  enlist(kind: Enlisted): () => void;
};

type Enlisted = "poll" | "hold" | "eager";

const RootCtx = createContext<Root | null>(null);
const PageCtx = createContext<Snapshot | null>(null);

const TOAST_MS = 9000;
const TICK_MS = 5000;

export function WorkspaceRoot({ workspaceId, children }: { workspaceId: string; children: React.ReactNode }) {
  const [cloneReceipt, setCloneReceipt] = useState<CloneReceipt | null>(null);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const [app, selectApp] = useState(ALL_APPS);
  const [selectionReady, setSelectionReady] = useState(false);
  const router = useRouter();
  const enlisted = useRef({ poll: 0, hold: 0, eager: 0 });
  // When the newest snapshot arrived, or the last poll asked for one, by this browser's clock: a
  // snapshot's `loadedAt` is the server's, which can disagree with it.
  const lastAt = useRef(0);
  // The server's `loadedAt` of the newest snapshot offered, so a page the router kept, handing up
  // the copy it was rendered with, doesn't count as a new arrival and put the poll off.
  const newest = useRef(0);

  useEffect(() => {
    try {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      selectApp(readAppSelection(sessionStorage, workspaceId, navigation?.type));
    } catch { /* Accessing sessionStorage itself can throw when storage is blocked. */ }
    setSelectionReady(true);
  }, [workspaceId]);

  useEffect(() => {
    if (!selectionReady || !latest) return;
    const valid = validAppSelection(latest.apps, app);
    if (valid !== app) selectApp(valid);
    try { writeAppSelection(sessionStorage, workspaceId, valid); }
    catch { /* The in-memory choice still works without storage. */ }
  }, [app, latest, selectionReady, workspaceId]);

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const check = () => {
      const now = Date.now();
      const { poll, hold, eager } = enlisted.current;
      if (!pollDue({ polling: poll > 0, eager: eager > 0, visible: document.visibilityState === "visible", held: hold > 0, now, lastAt: lastAt.current })) return;
      lastAt.current = now;
      router.refresh();
    };
    const timer = setInterval(check, POLL_CHECK_MS);
    // A tab that comes back after a while catches up at once instead of on the next check.
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [router]);

  const enlist = useCallback((kind: Enlisted) => {
    enlisted.current[kind] += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      enlisted.current[kind] -= 1;
    };
  }, []);

  const offer = useCallback((s: Snapshot) => {
    if (s.loadedAt <= newest.current) return;
    newest.current = s.loadedAt;
    lastAt.current = Math.max(lastAt.current, Date.now());
    setLatest(s);
  }, []);
  const dismiss = useCallback((id: string) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, "id" | "t">) => {
      const id = `t${++seq.current}`;
      setToasts((ts) => [...ts.slice(-3), { ...t, id, t: Date.now() }]);
      setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ cloneReceipt, setCloneReceipt, latest, offer, now, toasts, toast, dismiss, app, selectApp, enlist }), [cloneReceipt, latest, offer, now, toasts, toast, dismiss, app, enlist]);
  return <RootCtx.Provider value={value}>{children}</RootCtx.Provider>;
}

/** Wraps a page's screen with the snapshot its server component loaded. */
export function WorkspaceSnapshot({ snapshot, children }: { snapshot: Snapshot; children: React.ReactNode }) {
  const root = useContext(RootCtx);
  const offer = root?.offer;
  useEffect(() => {
    offer?.(snapshot);
  }, [offer, snapshot]);
  return <PageCtx.Provider value={snapshot}>{children}</PageCtx.Provider>;
}

/** The workspace, or null before the first client render. Times are formatted in the browser's
 *  zone, so nothing time-shaped renders on the server, where the zone differs. */
export function useWorkspace(): Workspace | null {
  const root = useContext(RootCtx);
  const page = useContext(PageCtx);
  const mounted = useMounted();
  const snap = newerSnapshot(page, root?.latest ?? null);
  const now = root?.now ?? null;
  const toasts = root?.toasts;
  return useMemo(() => {
    if (!mounted || !snap) return null;
    return { ...snap, now: Math.max(snap.now, now ?? 0), toasts: toasts ?? [] };
  }, [mounted, snap, now, toasts]);
}

export function useCloneReceipt(appId: string) {
  const receipt = useContext(RootCtx)?.cloneReceipt;
  return receipt?.appId === appId ? receipt : null;
}

export function useToasts() {
  const root = useContext(RootCtx);
  return { toasts: root?.toasts ?? [], dismiss: root?.dismiss ?? (() => {}) };
}

/** A screen whose data the probes change: the root refreshes it while it shows (`poll.ts`). */
export function usePoll() {
  const enlist = useContext(RootCtx)?.enlist;
  useEffect(() => enlist?.("poll"), [enlist]);
}

/** Holds the poll while `held`: a form with input not yet saved. */
export function useHoldPoll(held: boolean) {
  const enlist = useContext(RootCtx)?.enlist;
  useEffect(() => (held ? enlist?.("hold") : undefined), [enlist, held]);
}

/** Polls every five seconds while `waiting`: what the screen shows includes a monitor about to
 *  get its first numbers (`awaitingNumbers`, `poll.ts`). It only speeds up a screen that already
 *  polls, and the holds above still apply. The screen works `waiting` out again on every render,
 *  so it lets go once every monitor it shows has numbers, or once the newest was saved two
 *  minutes ago. */
export function useEagerPoll(waiting: boolean) {
  const enlist = useContext(RootCtx)?.enlist;
  useEffect(() => (waiting ? enlist?.("eager") : undefined), [enlist, waiting]);
}

/** The rail and the collection filters write this one choice. Detail screens never use it. */
export function useAppSelection(s: Workspace | null) {
  const root = useContext(RootCtx);
  return { app: s ? validAppSelection(s.apps, root?.app ?? ALL_APPS) : ALL_APPS, setApp: root?.selectApp ?? (() => {}) };
}

// A throw can come after the server saved (a dropped connection), so this never claims either way.
const OUTAGE = "Something went wrong before Staygreen answered. Reload the page to see whether it was saved.";
// A test saves nothing, so there is nothing to reload for.
const TEST_OUTAGE = "Something went wrong before the test answered. Nothing was saved; try again in a moment.";

type NoteInput = { noteId: string | null; state: NoteState; text: string; publish: boolean };

/** Every write a screen makes. A form shows the failure itself (`inline`); a button's failure is
 *  toasted, because a button has nowhere else to say it. */
export function useActs() {
  const router = useRouter();
  const root = useContext(RootCtx);
  const toast = root?.toast;
  const setCloneReceipt = root?.setCloneReceipt;
  const enlist = root?.enlist;

  return useMemo(() => {
    async function run<T extends object>(call: () => Promise<Result<T>>, done: string | null, inline: boolean): Promise<Result<T>> {
      // No poll while a write is out: its own refresh brings the change.
      const release = enlist?.("hold");
      let r: Result<T>;
      try {
        r = await call();
      } catch {
        r = { ok: false, reason: OUTAGE };
      } finally {
        release?.();
      }
      if (r.ok) {
        if (done) toast?.({ tone: "up", title: done });
        router.refresh();
      } else if (!inline) {
        toast?.({ tone: "warn", title: "Not done", body: r.reason });
      }
      return r;
    }
    /** A call that changes nothing on screen: no toast and no refresh, and a throw (an edge refusal,
     *  a dropped connection) becomes a sentence like any other refusal. */
    async function ask<T extends object>(call: () => Promise<Result<T>>): Promise<Result<T>> {
      try {
        return await call();
      } catch {
        return { ok: false, reason: TEST_OUTAGE };
      }
    }
    return {
      createToken: (input: unknown) => run(() => createToken(input), "Token created", true),
      revokeToken: (id: string) => run(() => revokeToken(id), "Token revoked", true),
      testMonitor: (draft: unknown, monitorId: string | null) => ask(() => testMonitor(draft, monitorId)),
      cloneDemo: async (slug: string) => {
        const r = await run(() => cloneDemo(slug), null, true);
        if (r.ok) setCloneReceipt?.(r);
        return r as Awaited<ReturnType<typeof cloneDemo>>;
      },
      addApp: (input: { name: string; url: string }) => run(() => addApp(input), "App added", true),
      updateApp: (id: string, input: { name: string; url: string }) => run(() => updateApp(id, input), "App saved", true),
      uploadAppLogo: (id: string, form: FormData, opts?: { keep?: boolean }) => run(() => uploadAppLogo(id, form, opts), null, true),
      removeAppLogo: (id: string) => run(() => removeAppLogo(id), null, true),
      suggestChecks: (id: string) => ask(() => suggestChecks(id)),
      addSuggestedChecks: (id: string, picks: Picks) => run(() => addSuggestedChecks(id, picks), null, true),
      deleteApp: (id: string) => run(() => deleteApp(id), "App deleted", true),
      addMonitor: (draft: unknown) => run(() => addMonitor(draft), "Monitor added", true),
      updateMonitor: (id: string, draft: unknown) => run(() => updateMonitor(id, draft), "Monitor saved", true),
      deleteMonitor: (id: string) => run(() => deleteMonitor(id), "Monitor deleted", true),
      pause: (id: string, minutes: number | null) => run(() => pauseMonitor(id, minutes), "Monitor paused", false),
      resume: (id: string) => run(() => resumeMonitor(id), "Monitor resumed", false),
      rotateHeartbeat: (id: string) => run(() => rotateHeartbeat(id), null, true),
      ack: (id: string) => run(() => ackIncident(id), "Incident acknowledged", false),
      saveNote: (incidentId: string, note: NoteInput) => run(() => saveNote(incidentId, note), note.publish ? "Update published" : "Draft saved", true),
      deleteNote: (incidentId: string, noteId: string) => run(() => deleteNote(incidentId, noteId), "Draft deleted", false),
      addPage: (appId: string) => run(() => addPage(appId), "Status page created", false),
      reservePageDomain: (id: string, host: string) => run(() => reservePageDomain(id, host), null, true),
      verifyPageDomain: (id: string) => run(() => verifyPageDomain(id), null, true),
      checkPageDomain: (id: string) => ask(() => checkPageDomain(id)),
      removePageDomain: (id: string) => run(() => removePageDomain(id), null, true),
      savePage: (id: string, draft: unknown) => run(() => savePage(id, draft), "Status page saved", true),
      uploadPageAsset: (id: string, kind: PageAssetKind, form: FormData) => run(() => uploadPageAsset(id, kind, form), null, true),
      removePageAsset: (id: string, kind: PageAssetKind) => run(() => removePageAsset(id, kind), null, true),
      deletePage: (id: string) => run(() => deletePage(id), "Status page deleted", true),
      toast: (t: Omit<Toast, "id" | "t">) => toast?.(t),
    };
  }, [router, toast, enlist, setCloneReceipt]);
}

export type Acts = ReturnType<typeof useActs>;
