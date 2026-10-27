"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Modal, ModalBody, ModalFoot } from "@/components/ui";
import { BuilderTag } from "@/components/Tags";
import { Copy } from "@/components/Copy";
import { AppPicker } from "@/components/AppPicker";
import { holds } from "@/lib/plans";
import type { AlertsView } from "@/lib/alerts/server";
import type { Workspace } from "@/lib/workspace-store";
import { addWebhookChannel, connectSlack, saveAlertRouting } from "./actions";
import { channelInput } from "@/lib/alerts/channel-input";

const lost = "Something went wrong before Staygreen answered. Reload the page to see whether it was saved.";

export function AddChannels({ ready }: { ready: boolean }) {
  const router = useRouter();
  const [kind, setKind] = useState<"discord" | "webhook" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const close = () => { setKind(null); setUrl(""); setSecret(""); setLabel(""); setError(""); setFields({}); };
  const slack = async () => {
    setBusy(true); setError("");
    try { const r = await connectSlack(); if (r.ok) window.location.assign(r.url); else setError(r.reason); }
    catch { setError(lost); }
    finally { setBusy(false); }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault(); setError(""); setFields({});
    const parsed = channelInput.safeParse({ kind, label, url, secret });
    if (!parsed.success) { setFields(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]))); return; }
    setBusy(true);
    try {
      const r = await addWebhookChannel({ kind, label, url, secret });
      if (r.ok) { close(); router.refresh(); }
      else if (r.fieldErrors) setFields(r.fieldErrors); else setError(r.reason);
    } catch { setError(lost); }
    finally { setBusy(false); }
  };
  return <div className="stack-sm">
    <div className="cluster">
      <button className="btn" type="button" disabled={!ready || busy} onClick={slack}>Add to Slack</button>
      <button className="btn" type="button" disabled={busy} onClick={() => { setError(""); setKind("discord"); }}>Discord</button>
      <button className="btn" type="button" disabled={busy} onClick={() => { setError(""); setKind("webhook"); }}>Signed webhook</button>
    </div>
    {!ready && <p className="hint">Slack isn&apos;t configured yet.</p>}
    {!kind && error && <p role="alert" className="t-down">{error}</p>}
    <Modal open={kind !== null} onClose={close} undismissable={busy}>
      <form onSubmit={save}>
        <ModalBody title={kind === "discord" ? "Connect Discord" : "Add a signed webhook"}>
          <div className="stack">
            <label className="field"><span className="label">Channel name</span><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={120} autoComplete="off" aria-invalid={!!fields.label} aria-describedby="channel-name-hint" /><span id="channel-name-hint" className={fields.label ? "error" : "hint"}>{fields.label ?? "A name to recognize this destination in routing."}</span></label>
            <label className="field"><span className="label">{kind === "discord" ? "Discord webhook URL" : "HTTPS endpoint"}</span>
              <input className="input" type="password" value={url} onChange={(e) => setUrl(e.target.value)} required maxLength={2048} autoComplete="new-password" aria-invalid={!!fields.url} aria-describedby="channel-url-hint" />
              <span id="channel-url-hint" className={fields.url ? "error" : "hint"}>{fields.url ?? (kind === "discord" ? "In your Discord channel, open Integrations → Webhooks and copy its webhook URL. The address is hidden after saving." : "A public HTTPS address on port 443. Redirects are refused; the address is hidden after saving.")}</span>
            </label>
            {kind === "webhook" && <>
              <label className="field"><span className="label">Signing secret</span><input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} minLength={32} maxLength={256} required autoComplete="new-password" aria-invalid={!!fields.secret} aria-describedby="channel-secret-hint" />
                <span id="channel-secret-hint" className={fields.secret ? "error" : "hint"}>{fields.secret ?? "Copy this into your receiver before saving. Staygreen cannot show it again."}</span></label>
              <div className="cluster"><button className="btn" type="button" onClick={() => setSecret(Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""))}>Generate secret</button>{secret && <Copy text={secret} />}</div>
              <p className="hint">Verify Staygreen-Signature as HMAC-SHA256 of timestamp + &quot;.&quot; + raw body. Accept a timestamp within five minutes and deduplicate the body&apos;s id. Five retries follow at 1, 3, 7, 15 and 30 minutes.</p>
            </>}
            {error && <p role="alert" className="t-down">{error}</p>}
          </div>
        </ModalBody>
        <ModalFoot><button className="btn" type="button" disabled={busy} onClick={close}>Cancel</button><button className="btn btn-primary" disabled={busy} type="submit">{busy ? "Saving…" : "Add channel"}</button></ModalFoot>
      </form>
    </Modal>
  </div>;
}

export function RoutingSettings({ s, view, manage }: { s: Workspace; view: AlertsView; manage: boolean }) {
  const [appId, setApp] = useState(s.apps[0]?.id ?? "");
  const [monitorId, setMonitor] = useState<string | null>(null);
  const [severity, setSeverity] = useState<"all" | "incident" | "warning">("all");
  if (!s.apps.length) return null;
  return <section className="section" aria-labelledby="rt-h">
    <div className="section-head"><h2 id="rt-h" className="t-section">Which alerts go where</h2></div>
    <div className="panel stack">
      <p className="t-2">Monitors use their app&apos;s default channels unless you override them. On Builder, incidents and warnings can use different channels. Recoveries follow the opening alert&apos;s severity.</p>
      <div className="stack">
        <div className="field"><label className="label" htmlFor="routing-app">App</label><AppPicker id="routing-app" apps={s.apps} value={appId} onChange={(id) => { setApp(id); setMonitor(null); }} /></div>
        <label className="field"><span className="label">Applies to</span><select className="select" value={monitorId ?? ""} onChange={(e) => setMonitor(e.target.value || null)}><option value="">App defaults</option>{s.monitors.filter((m) => m.appId === appId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label className="field"><span className="label">Alert severity</span><select className="select" value={severity} onChange={(e) => setSeverity(e.target.value as typeof severity)}><option value="all">All alerts</option><option value="incident" disabled={!holds(s, "alert_rules")}>Incidents{!holds(s, "alert_rules") ? " (Builder)" : ""}</option><option value="warning" disabled={!holds(s, "alert_rules")}>Warnings{!holds(s, "alert_rules") ? " (Builder)" : ""}</option></select></label>
      </div>
      {!holds(s, "alert_rules") && <BuilderTag offer="alertRules">Route by severity</BuilderTag>}
      <RouteForm key={`${appId}:${monitorId}:${severity}:${JSON.stringify(view.routes)}`} {...{ appId, monitorId, severity, view, manage }} />
    </div>
  </section>;
}

function RouteForm({ appId, monitorId, severity, view, manage }: { appId: string; monitorId: string | null; severity: "all" | "incident" | "warning"; view: AlertsView; manage: boolean }) {
  const router = useRouter();
  const existing = view.routes.find((r) => r.channelIds.length > 0 && r.appId === appId && r.monitorId === monitorId && r.severity === severity);
  const fallback = view.routes.filter((r) => r.channelIds.length > 0 && r.appId === appId && (r.monitorId === null || r.monitorId === monitorId) &&
    (r.severity === "all" || r.severity === severity)).sort((a, b) => Number(b.monitorId !== null) - Number(a.monitorId !== null) || Number(b.severity !== "all") - Number(a.severity !== "all"))[0];
  const inherited = fallback?.channelIds ?? view.channels.filter((c) => !c.appsOff.includes(appId)).map((c) => c.id);
  const [custom, setCustom] = useState(!!existing);
  const [ids, setIds] = useState(existing?.channelIds ?? inherited);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const save = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setNotice("");
    try { const r = await saveAlertRouting({ appId, monitorId, severity, channelIds: custom ? ids : null }); setNotice(r.ok ? "Routing saved." : r.reason); if (r.ok) router.refresh(); }
    catch { setNotice(lost); }
    finally { setBusy(false); }
  };
  return <form className="stack" onSubmit={save}>
    <label className="check"><input type="checkbox" checked={custom} disabled={!manage || busy} onChange={(e) => setCustom(e.target.checked)} /><span>Choose channels for this rule</span></label>
    {!custom && <p className="hint">{monitorId ? "Uses the app's channels, or this monitor's All alerts rule when one exists." : severity === "all" ? "Uses all channels except any previously turned off for this app. New channels are included." : "Uses the app's All alerts rule."}</p>}
    {custom && <fieldset className="stack-sm"><legend className="label">Send to</legend>{view.channels.map((c) => <label key={c.id} className="check"><input type="checkbox" disabled={!manage || busy} checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((id) => id !== c.id))} /><span>{c.label}{c.state !== "on" ? ` (${c.state})` : ""}</span></label>)}{ids.length === 0 && <p className="hint">Saving with no channels removes this rule and uses inherited channels.</p>}</fieldset>}
    {manage && <div className="cluster"><button className="btn btn-primary" disabled={busy} type="submit">{busy ? "Saving…" : "Save routing"}</button></div>}
    {notice && <p role="status" className="hint">{notice}</p>}
  </form>;
}
