"use client";

import { useState } from "react";
import Link from "next/link";
import { Pencil, Trash2 } from "lucide-react";
import { AppLogo } from "@/components/AppLogo";
import { AppLogoPicker } from "@/components/AppLogoPicker";
import { MoreMenu } from "@/components/MoreMenu";
import { SuggestedChecks } from "@/components/SuggestedChecks";
import { plural } from "@/lib/format";
import type { App } from "@/lib/model";
import { linkSchema } from "@/lib/page-input";
import { useActs, type Workspace } from "@/lib/workspace-store";

/* An app in Settings (`docs/flows.md § Editing an app`): its name, address and logo, with the
   rules adding one has. A new address changes no monitor; once it is saved, Staygreen tries it
   and offers its checks, as it does for a new app, and nothing is added unless ticked. */

export function AppRow({ s, app, onDelete }: { s: Workspace; app: App; onDelete: (() => void) | null }) {
  const [editing, setEditing] = useState(false);
  // The address the builder just saved, whose checks are on offer.
  const [offered, setOffered] = useState<string | null>(null);
  const n = s.monitors.filter((m) => m.appId === app.id).length;
  const page = s.pages.find((p) => p.appId === app.id);
  const edit = s.can["monitors:write"];

  return (
    <li className="app-row">
      <div className="channel-row">
        <AppLogo app={app} size={32} />
        <span className="stack-sm pb-tight">
          <strong className="wrap-anywhere">{app.name}</strong>
          <span className="t-2 wrap-anywhere">
            {app.url ? app.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "No address"}. {plural(n, "monitor")}{page ? ", one status page" : ""}.
          </span>
        </span>
        <span className="cluster app-row-actions">
          {edit && <Link href={`/app/apps/${app.id}/checks`} className="btn btn-sm">Find missing checks</Link>}
          {edit && !editing && (
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)} aria-label={`Edit ${app.name}`}><Pencil aria-hidden="true" />Edit</button>
          )}
          {/* Delete is behind "…", even with its confirmation (owner, 2026-10-26). */}
          {onDelete && <MoreMenu label={`More for ${app.name}`} items={[{ label: "Delete app", icon: <Trash2 aria-hidden="true" />, onSelect: onDelete }]} />}
        </span>
      </div>
      {editing && (
        <div className="app-edit stack">
          <AppForm
            app={app}
            onClose={(changed) => {
              setEditing(false);
              setOffered(changed || null);
            }}
          />
          <AppLogoPicker app={app} />
        </div>
      )}
      {offered && (
        <div className="app-edit stack">
          <h3 className="t-h3">Checks for the new address</h3>
          <p className="t-2">Its monitors still check what they did. Staygreen tried the new address once; add what it suggests, or leave them as they are.</p>
          <SuggestedChecks
            key={offered}
            appId={app.id}
            address={offered}
            skip={<button type="button" className="btn" onClick={() => setOffered(null)}>Not now</button>}
            onDone={() => setOffered(null)}
          />
        </div>
      )}
    </li>
  );
}

/** `onClose` gets the new address when one was saved, else null or an empty one. */
function AppForm({ app, onClose }: { app: App; onClose: (changedUrl: string | null) => void }) {
  const acts = useActs();
  const [name, setName] = useState(app.name);
  // As the form opened: the refresh after saving may land before `onClose` runs.
  const [was] = useState(app.url ?? "");
  const [url, setUrl] = useState(was);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<string | null>(null);
  const id = `app-${app.id}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const local: Record<string, string> = {};
    if (!name.trim()) local.name = "Give the app a name";
    const link = linkSchema.safeParse(url);
    if (!link.success) local.url = link.error.issues[0].message;
    setErrors(local);
    setReason(null);
    if (Object.keys(local).length) return;
    setBusy(true);
    const r = await acts.updateApp(app.id, { name: name.trim(), url: url.trim() });
    setBusy(false);
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      setReason(r.fieldErrors && Object.keys(r.fieldErrors).length ? null : r.reason);
      return;
    }
    onClose(url.trim() !== was ? url.trim() : null);
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="field">
        <label className="label" htmlFor={`${id}-name`}>App name</label>
        <input id={`${id}-name`} className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
          aria-invalid={!!errors.name} aria-describedby={errors.name ? `${id}-name-err` : undefined} />
        {errors.name && <span id={`${id}-name-err`} className="error">{errors.name}</span>}
      </div>
      <div className="field">
        <label className="label" htmlFor={`${id}-url`}>Address <span className="hint">optional</span></label>
        <input id={`${id}-url`} className="input" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com"
          aria-invalid={!!errors.url} aria-describedby={`${id}-url-hint${errors.url ? ` ${id}-url-err` : ""}`} />
        <span id={`${id}-url-hint`} className="hint">Changing it changes no monitor. Once it&apos;s saved, Staygreen tries the new address and offers its checks.</span>
        {errors.url && <span id={`${id}-url-err`} className="error">{errors.url}</span>}
      </div>
      {reason && <p className="error" role="alert">{reason}</p>}
      <div className="cluster">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save app"}</button>
        <button type="button" className="btn" disabled={busy} onClick={() => onClose(null)}>Cancel</button>
      </div>
    </form>
  );
}
