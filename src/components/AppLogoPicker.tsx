"use client";

import { useRef, useState } from "react";
import { AppLogo } from "./AppLogo";
import { DeleteDialog } from "./DeleteDialog";
import type { App } from "@/lib/model";
import { appLogoForm } from "@/lib/page-asset-prepare";
import { useActs } from "@/lib/workspace-store";

/** An app's logo, chosen or removed. The status page images' pipeline (`PageAssetPicker`): resized
 *  in the browser to a small square, only its pixels kept, checked again on the server. A favicon
 *  copy is made beside it, for the app's next status page (`appLogoForm`). */
export function AppLogoPicker({ app }: { app: Pick<App, "id" | "name" | "logoUrl"> }) {
  const acts = useActs();
  const input = useRef<HTMLInputElement>(null);
  const remove = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const id = `app-logo-${app.id}`;

  async function upload(file?: File) {
    if (!file || busy) return;
    setError(null);
    setStatus("");
    setBusy(true);
    try {
      const prepared = await appLogoForm(file);
      if (!prepared.ok) { setError(prepared.reason); return; }
      const result = await acts.uploadAppLogo(app.id, prepared.form);
      if (!result.ok) { setError(result.reason); return; }
      setStatus("Logo saved.");
    } catch {
      setError("The image couldn't be read. Choose it again.");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="field">
      <label className="label" htmlFor={id}>Logo</label>
      <span className="row">
        <AppLogo app={app} size={32} />
        <input ref={input} id={id} className="input grow" type="file" disabled={busy}
          accept="image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,.ico,image/svg+xml,.svg"
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`} aria-invalid={!!error} aria-busy={busy}
          onChange={(e) => void upload(e.target.files?.[0])} />
      </span>
      <span className="hint" id={`${id}-hint`}>PNG, JPEG, WebP, ICO or SVG, up to 10 MB. It&apos;s shown beside the app&apos;s name, resized to a small square, and only its pixels are kept. A new status page for the app starts with it as its logo and tab icon. Uploads save immediately.</span>
      {error && <span className="error" id={`${id}-error`} role="alert">{error}</span>}
      <span className="hint" role="status">{busy ? "Uploading logo…" : status}</span>
      {app.logoUrl && <div><button type="button" className="btn btn-sm" disabled={busy} onClick={() => remove.current?.showModal()}>Remove logo</button></div>}
      <DeleteDialog ref={remove} title="Remove logo?" confirm="Remove logo"
        run={() => acts.removeAppLogo(app.id)}
        onDone={() => { setError(null); setStatus("Logo removed."); }}>
        <p>{app.name} goes back to its first letter beside its name. You can upload an image again.</p>
      </DeleteDialog>
    </div>
  );
}
