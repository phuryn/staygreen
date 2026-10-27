"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppLogo } from "@/components/AppLogo";
import { Loading, PageHead } from "@/components/Shell";
import { SuggestedChecks } from "@/components/SuggestedChecks";
import type { App } from "@/lib/model";
import { linkSchema } from "@/lib/page-input";
import { useActs, useWorkspace } from "@/lib/workspace-store";

export function ChecksScreen({ id }: { id: string }) {
  const s = useWorkspace();
  const router = useRouter();
  const [saved, setSaved] = useState<{ id: string; url: string } | null>(null);
  if (!s) return <Loading />;
  const app = s.apps.find((a) => a.id === id);
  if (!app) return <Loading />;
  if (!s.can["monitors:write"]) return null;
  // Start after a successful save even if its snapshot refresh is still arriving. The scan
  // takes only the app id and reads the saved address again on the server.
  const address = app.url || (saved?.id === app.id ? saved.url : "");
  return (
    <>
      <PageHead
        doc={`Checks for ${app.name}`}
        back={{ href: "/app", label: "Overview" }}
        title={<span className="row"><AppLogo app={app} size={32} />Suggested checks for {app.name}</span>}
        sub="Find checks for this app's address and sign-in dependencies. Existing checks in this workspace are kept under Already covered."
      />
      <section className="panel" aria-label={`Suggested checks for ${app.name}`}>
        {address ? (
          <SuggestedChecks
            key={`${app.id}:${address}`}
            appId={app.id}
            address={address}
            skip={<Link href="/app" className="btn">Skip for now</Link>}
            onDone={() => router.push("/app")}
          />
        ) : (
          <AppAddressForm key={app.id} app={app} onSaved={(url) => setSaved({ id: app.id, url })} />
        )}
      </section>
    </>
  );
}

/** Uses Settings' save and validation; an address is needed only for this scan, not for jobs. */
export function AppAddressForm({ app, onSaved }: { app: App; onSaved: (url: string) => void }) {
  const acts = useActs();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const parsed = linkSchema.safeParse(url);
    setReason(null);
    if (!parsed.success || !parsed.data) {
      setError(parsed.success ? "Enter an address to find its checks." : parsed.error.issues[0].message);
      return;
    }
    setError(null);
    setBusy(true);
    const r = await acts.updateApp(app.id, { name: app.name, url: parsed.data });
    setBusy(false);
    if (!r.ok) {
      setError(r.fieldErrors?.url ?? null);
      setReason(r.fieldErrors?.url ? null : r.reason);
      return;
    }
    onSaved(parsed.data);
  }
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <p className="t-2">Add an address to find checks for {app.name}. An app that only receives job heartbeats can stay without one.</p>
      <div className="field">
        <label className="label" htmlFor="checks-address">App address</label>
        <input id="checks-address" className="input" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com" disabled={busy} aria-invalid={!!error} aria-describedby={error ? "checks-address-error" : undefined} />
        {error && <span id="checks-address-error" className="error">{error}</span>}
      </div>
      {reason && <p className="error" role="alert">{reason}</p>}
      <div className="cluster">
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>{busy ? "Saving…" : "Save and find checks"}</button>
        <Link href={`/app/monitors/new?app=${app.id}`} className="btn">Add a monitor yourself</Link>
        <Link href="/app" className="btn">Skip for now</Link>
      </div>
    </form>
  );
}
