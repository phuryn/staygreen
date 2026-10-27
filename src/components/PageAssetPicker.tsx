"use client";

import { useRef, useState } from "react";
import { DeleteDialog } from "./DeleteDialog";
import { preparePageAsset } from "@/lib/page-asset-prepare";
import type { PageAssetKind } from "@/lib/page-assets";
import { useActs } from "@/lib/workspace-store";

/** Native file control, labelled progress/errors, and the kit's destructive confirmation. */
export function PageAssetPicker({ pageId, kind, url, onSaved }: {
  pageId: string; kind: PageAssetKind; url: string | null; onSaved: (url: string | null) => void;
}) {
  const acts = useActs();
  const input = useRef<HTMLInputElement>(null);
  const remove = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const label = kind === "logo" ? "Logo image" : "Favicon";
  const id = `pe-asset-${kind}`;

  async function upload(file?: File) {
    if (!file || busy) return;
    setError(null);
    setStatus("");
    setBusy(true);
    try {
      // The chosen file never leaves the browser: what is sent is the resized image the page
      // stores, far under Next's 1 MB action-body ceiling (`page-asset-prepare.ts`). The server
      // checks it again, so this is where the builder hears why, not where it is enforced.
      const prepared = await preparePageAsset(file, kind);
      if (!prepared.ok) { setError(prepared.reason); return; }
      const form = new FormData();
      form.set("file", prepared.file);
      const result = await acts.uploadPageAsset(pageId, kind, form);
      if (!result.ok) { setError(result.reason); return; }
      onSaved(result.url);
      setStatus(`${label} saved. Visitors see it on their next refresh.`);
    } catch {
      setError("The image couldn't be read. Choose it again.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="field">
      <label className="label" htmlFor={id}>{label}</label>
      {url && <img className="pe-asset-preview" src={url} alt={`Current ${kind}`} />}
      <input ref={input} id={id} className="input" type="file" disabled={busy}
        accept={kind === "logo" ? "image/png,image/jpeg,image/webp,image/svg+xml,.svg" : "image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico,image/svg+xml,.svg"}
        aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} aria-invalid={!!error} aria-busy={busy}
        onChange={(e) => void upload(e.target.files?.[0])} />
      <span className="hint" id={`${id}-hint`}>PNG, JPEG, WebP{kind === "favicon" ? ", ICO" : ""} or SVG, up to 10 MB. It&apos;s resized for the page and only its pixels are kept, so a photo&apos;s location and other details are dropped. Uploads save immediately.{kind === "favicon" && " Without one, the tab uses your logo."}</span>
      {error && <span className="error" id={`${id}-error`} role="alert">{error}</span>}
      <span className="hint" role="status">{busy ? `Uploading ${kind}…` : status}</span>
      {url && <div><button type="button" className="btn btn-sm" disabled={busy} onClick={() => remove.current?.showModal()}>Remove {kind}</button></div>}
      <DeleteDialog ref={remove} title={`Remove ${kind}?`} confirm={`Remove ${kind}`}
        run={() => acts.removePageAsset(pageId, kind)}
        onDone={() => { onSaved(null); setError(null); setStatus(`${label} removed.`); }}>
        <p>{kind === "logo" ? "The page returns to its accent mark and logo text. If the tab uses this logo, it returns to the Staygreen icon." : "The tab returns to your logo, or the Staygreen icon if there is no logo."} You can upload an image again.</p>
      </DeleteDialog>
    </div>
  );
}
