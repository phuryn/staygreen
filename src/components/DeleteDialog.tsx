"use client";

import { useId, useState, type ReactNode, type Ref } from "react";
import type { Result } from "@/app/(app)/app/actions";

/** The one confirmation every delete asks for: what goes with it, then "Keep it" or the delete.
 *  Opened with `ref.current.showModal()`. A refusal stays in the dialog; a success closes it and
 *  hands over to `onDone`, which usually leaves the page the thing was on. */
export function DeleteDialog({ ref, title, confirm, run, onDone, children }: {
  ref: Ref<HTMLDialogElement>;
  title: string;
  confirm: string;
  run: () => Promise<Result>;
  onDone?: () => void;
  children: ReactNode;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(dialog: HTMLDialogElement | null) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await run();
    setBusy(false);
    if (!r.ok) {
      setError(r.reason);
      return;
    }
    dialog?.close();
    onDone?.();
  }

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={id}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      onClose={() => setError(null)}
    >
      <div className="dialog-body stack-sm">
        <h2 id={id} className="t-section wrap-anywhere">{title}</h2>
        {children}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn" disabled={busy} onClick={(e) => e.currentTarget.closest("dialog")?.close()}>Keep it</button>
        <button type="button" className="btn btn-danger" disabled={busy} aria-busy={busy} onClick={(e) => remove(e.currentTarget.closest("dialog"))}>{busy ? "Deleting…" : confirm}</button>
      </div>
    </dialog>
  );
}
