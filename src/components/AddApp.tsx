"use client";

import { useState } from "react";
import { linkSchema } from "@/lib/page-input";
import { useActs, useHoldPoll } from "@/lib/workspace-store";

/** An app is a name for a group of monitors (and, later, one status page). The address is
 *  optional: given, Staygreen tries it and suggests its first checks (`SuggestedChecks`), and it
 *  prefills the first HTTP monitor and the status page's homepage link. `onAdded` gets the
 *  address as typed, empty for none. With `findsChecks`, the caller opens the suggested checks
 *  next, so the form stays busy and says what is happening until that screen arrives. */
export function AddApp({ onAdded, autoFocus, submitLabel = "Add app", findsChecks = false }: { onAdded?: (id: string, url: string) => void; autoFocus?: boolean; submitLabel?: string; findsChecks?: boolean }) {
  const acts = useActs();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<string | null>(null);
  // The host being tried while the suggested checks load, after the app was added.
  const [finding, setFinding] = useState<string | null>(null);
  useHoldPoll(!!(name || url));

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
    const r = await acts.addApp({ name: name.trim(), url: url.trim() });
    if (r.ok && findsChecks && url.trim()) {
      // Trying the address takes seconds, and the screen that shows the result is still loading:
      // without this the form looks finished and the next screen arrives unannounced (owner,
      // 2026-10-23). The form unmounts when the suggested checks open.
      setFinding(hostOf(url.trim()));
      onAdded?.(r.id, url.trim());
      return;
    }
    setBusy(false);
    if (!r.ok) {
      setErrors(r.fieldErrors ?? {});
      setReason(r.fieldErrors && Object.keys(r.fieldErrors).length ? null : r.reason);
      return;
    }
    setName("");
    setUrl("");
    onAdded?.(r.id, url.trim());
  }

  return (
    <form className="add-app" onSubmit={submit} noValidate>
      <div className="field">
        <label className="label" htmlFor="app-name">App name</label>
        <input
          id="app-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          autoFocus={autoFocus}
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? "app-name-err" : undefined}
        />
        {errors.name && <span id="app-name-err" className="error">{errors.name}</span>}
      </div>
      <div className="field">
        <label className="label" htmlFor="app-url">Address <span className="hint">optional</span></label>
        <input
          id="app-url"
          className="input"
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          aria-invalid={!!errors.url}
          aria-describedby={errors.url ? "app-url-err" : undefined}
        />
        {errors.url && <span id="app-url-err" className="error">{errors.url}</span>}
      </div>
      <div className="add-app-go">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          {finding ? "Finding checks…" : busy ? "Adding…" : submitLabel}
        </button>
      </div>
      {finding && <p className="t-2 span-all" role="status">Added. Trying {finding} to suggest its first checks…</p>}
      {reason && <p className="error span-all" role="alert">{reason}</p>}
    </form>
  );
}

/** The host a typed address names, for saying what is being tried; the address itself if it
 *  can't be read as a URL. */
function hostOf(address: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `https://${address}`).host || address;
  } catch {
    return address;
  }
}
