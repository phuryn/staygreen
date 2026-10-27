"use client";

import Link from "next/link";
import { useState } from "react";
import { Bot, Check, ExternalLink, X } from "lucide-react";
import { Loading, PageHead } from "@/components/Shell";
import { StateBadge } from "@/components/State";
import { Copy } from "@/components/Copy";
import { pageHost } from "@/lib/derive";
import { isBuilt } from "@/lib/launch";
import { agentBrief } from "@/lib/agent";
import { dayTime, dur, time, timeSec, zone } from "@/lib/format";
import { locations } from "@/lib/plans";
import { useActs, useHoldPoll, usePoll, useWorkspace, type Workspace } from "@/lib/workspace-store";
import type { Incident, Note, NoteState } from "@/lib/model";

const states: { id: NoteState; label: string; hint: string }[] = [
  { id: "investigating", label: "Investigating", hint: "You know something's wrong" },
  { id: "identified", label: "Identified", hint: "You know why" },
  { id: "monitoring", label: "Monitoring", hint: "A fix is out, you're watching it" },
  { id: "resolved", label: "Resolved", hint: "It's over" },
];
const ORDER: NoteState[] = ["investigating", "identified", "monitoring", "resolved"];

function IncidentDetail({ s, id }: { s: Workspace; id: string }) {
  const acts = useActs();
  const i = s.incidents.find((x) => x.id === id);
  if (!i) {
    return (
      <div className="empty">
        <h1 className="t-title">This incident isn&apos;t here any more</h1>
        <p className="t-2">It may be older than your plan&apos;s history, or its monitor was deleted.</p>
        <Link href="/app/incidents" className="btn">Back to incidents</Link>
      </div>
    );
  }
  const app = s.apps.find((a) => a.id === i.appId);
  const m = s.monitors.find((x) => x.id === i.monitorId);
  const page = s.pages.find((p) => p.appId === i.appId);
  const open = !i.resolvedAt;
  const deliveries = s.deliveries.filter((d) => d.incidentId === i.id);
  const published = i.notes.filter((n) => n.status === "published").sort((a, b) => b.at - a.at);
  const drafts = i.notes.filter((n) => n.status === "draft");
  const onPage = !!page?.components.some((c) => c.monitorIds.includes(i.monitorId));

  return (
    <>
      <PageHead
        back={{ href: "/app/incidents", label: "Incidents" }}
        title={i.title}
        sub={
          <span className="cluster">
            {app && <span>{app.name}</span>}
            {m ? <Link href={`/app/monitors/${m.id}`} className="link">{m.name}</Link> : <span className="t-3">Deleted monitor</span>}
          </span>
        }
        actions={
          <>
            {open && !i.ackedAt && s.can["incidents:draft"] && <button type="button" className="btn btn-primary" onClick={() => acts.ack(i.id)}>Acknowledge</button>}
            <Copy text={agentBrief(s, i)} label="Copy for agent" className="btn" />
          </>
        }
      />

      <div className="stack-lg">
        <div className="hero-state">
          {open ? <StateBadge state={i.severity} label="Open" size={22} /> : <StateBadge state="up" label="Resolved" size={22} />}
          <span className="t-2">
            {open
              ? `Since ${time(i.openedAt)} ${zone(i.openedAt)}, ${dur(s.now - i.openedAt)}. ${i.ackedAt ? `Acknowledged at ${time(i.ackedAt)}.` : "Nobody has acknowledged it yet."}`
              : `${dayTime(i.openedAt, s.now)} to ${time(i.resolvedAt!)} ${zone(i.resolvedAt!)}, ${dur(i.resolvedAt! - i.openedAt)}.`}
          </span>
        </div>

        <div className="detail-grid">
          <div className="stack-lg">
            <Evidence i={i} />
            <Updates s={s} i={i} published={published} drafts={drafts} pageLabel={page ? pageHost(page) : null} onPage={onPage} inApp={!!page?.components.some((c) => c.inApp && c.monitorIds.includes(i.monitorId))} />
          </div>

          <aside className="stack">
            <section className="panel panel-tight stack-sm" aria-labelledby="tl">
              <h2 id="tl" className="t-section">Timeline</h2>
              <ol className="timeline">
                {(i.timeline.length ? i.timeline : [{ t: i.openedAt, text: "Opened" }]).map((t, k) => (
                  <li key={k}>
                    <time className="num t-meta" dateTime={new Date(t.t).toISOString()}>{timeSec(t.t)}</time>
                    <span>{t.text}</span>
                  </li>
                ))}
              </ol>
            </section>

            {deliveries.length > 0 && (
              <section className="panel panel-tight stack-sm" aria-labelledby="sent">
                <h2 id="sent" className="t-section">Alerts sent</h2>
                <ul className="stack-sm">
                  {deliveries.map((d) => {
                    const c = s.channels.find((x) => x.id === d.channelId);
                    return (
                      <li key={d.id} className="spread">
                        <span>{c?.label ?? "Removed channel"} <span className="t-meta">{d.event.replace("incident.", "")}</span></span>
                        <span className="row t-meta num">{d.ok ? <Check width={14} className="state-icon up" aria-label="Delivered" /> : <X width={14} className="t-down" aria-label="Failed" />}{time(d.t)}</span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            <section className="panel panel-tight stack-sm" aria-labelledby="pub">
              <h2 id="pub" className="t-section">Public</h2>
              {page ? (
                <>
                  <p className="t-2">
                    {!onPage
                      ? `${m?.name ?? "This monitor"} isn't a component on ${pageHost(page)}, so nothing about this incident shows there.`
                      : published.length
                        ? `${published.length} update${published.length > 1 ? "s are" : " is"} on ${pageHost(page)}.`
                        : `Nothing about this is on ${pageHost(page)} yet. Its component shows its state either way.`}
                  </p>
                  <Link href={`/s/${page.slug}`} className="link row" target="_blank">View the status page<ExternalLink width={14} aria-hidden="true" /></Link>
                </>
              ) : (
                <p className="t-2">{app?.name ?? "This app"} has no status page. <Link href="/app/status-pages" className="link">Make one</Link> to tell people what&apos;s happening.</p>
              )}
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

function Evidence({ i }: { i: Incident }) {
  const e = i.evidence;
  return (
    <section className="panel stack" aria-labelledby="ev">
      <div className="section-head">
        <h2 id="ev" className="t-section">What failed</h2>
        <span className="t-meta">Kept as it was at the time</span>
      </div>
      <dl className="kv">
        {e.request && (
          <>
            <dt>Check</dt>
            <dd><code className="code wrap-anywhere">{e.request}</code></dd>
          </>
        )}
        <dt>Result</dt>
        <dd className="t-down">{e.summary || i.title}</dd>
        {e.assertion && (
          <>
            <dt>Assertion</dt>
            <dd><code className="code">{e.assertion}</code>{e.got !== undefined && <>, got <code className="code">{e.got}</code></>}</dd>
          </>
        )}
        {e.locations.length > 0 && (
          <>
            <dt>Seen from</dt>
            <dd>{e.locations.map((l) => locations[l].city).join(", then ")}</dd>
          </>
        )}
      </dl>
      {e.snippet && (
        <div className="stack-sm">
          <span className="label">Response</span>
          <pre className="snippet wrap">{e.snippet}</pre>
          <span className="t-meta">Tokens, keys and email addresses are masked before the snippet is stored.</span>
        </div>
      )}
    </section>
  );
}

function Updates({ s, i, published, drafts, pageLabel, onPage, inApp }: { s: Workspace; i: Incident; published: Note[]; drafts: Note[]; pageLabel: string | null; onPage: boolean; inApp: boolean }) {
  const acts = useActs();
  const open = !i.resolvedAt;
  const lastState = published[0]?.state;
  // The next update usually moves the story forward; a pick overrides that until it's sent.
  const next: NoteState = !open ? "resolved" : lastState ? ORDER[Math.min(ORDER.indexOf(lastState) + 1, 3)] : "investigating";
  const [picked, setPicked] = useState<NoteState | null>(null);
  const state = picked ?? next;
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<"publish" | "draft" | string | null>(null);
  const [composing, setComposing] = useState(open);
  useHoldPoll(!!text || editing !== null);
  const canDraft = s.can["incidents:draft"];
  const canPublish = s.can["incidents:publish"];
  const subject = s.pages.find((p) => p.appId === i.appId)?.components.find((c) => c.monitorIds.includes(i.monitorId))?.name ?? s.monitors.find((m) => m.id === i.monitorId)?.name ?? "it";

  async function save(publish: boolean) {
    if (busy) return;
    if (!text.trim()) {
      setErr("Write what people should know. One or two plain sentences is enough.");
      return;
    }
    setErr(null);
    setBusy(publish ? "publish" : "draft");
    const r = await acts.saveNote(i.id, { noteId: editing, state, text: text.trim(), publish });
    setBusy(null);
    if (!r.ok) {
      setErr(r.fieldErrors?.text ?? r.reason);
      return;
    }
    setText("");
    setEditing(null);
    setPicked(null);
  }

  async function publishDraft(n: Note) {
    if (busy) return;
    setErr(null);
    setBusy(n.id);
    const r = await acts.saveNote(i.id, { noteId: n.id, state: n.state, text: n.text, publish: true });
    setBusy(null);
    if (!r.ok) setErr(r.reason);
  }

  function edit(n: Note) {
    setEditing(n.id);
    setPicked(n.state);
    setText(n.text);
    setComposing(true);
    document.getElementById("update")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const where = pageLabel ? (onPage ? `On ${pageLabel}${inApp && isBuilt("widget") ? " and in your app's banner" : ""}` : `Not a component on ${pageLabel}`) : "This app has no status page yet";

  return (
    <section className="panel stack" aria-labelledby="upd">
      <div className="section-head">
        <h2 id="upd" className="t-section">Updates for your users</h2>
        <span className="t-meta">{where}</span>
      </div>

      {drafts.map((n) => (
        <div key={n.id} className="note draft">
          <div className="spread">
            <span className="row">
              {n.byAgent && <Bot width={16} aria-hidden="true" />}
              <strong>Draft by {n.author}</strong>
              <span className="tag">{states.find((x) => x.id === n.state)?.label}</span>
            </span>
            <span className="t-meta num">{time(n.at)}</span>
          </div>
          <p>{n.text}</p>
          {canDraft && (
            <div className="cluster">
              {canPublish && <button type="button" className="btn btn-sm btn-primary" disabled={!!busy || !onPage} aria-busy={busy === n.id} onClick={() => publishDraft(n)}>{busy === n.id ? "Publishing…" : "Publish update"}</button>}
              <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => edit(n)}>Edit</button>
              <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => acts.deleteNote(i.id, n.id)}>Discard</button>
            </div>
          )}
        </div>
      ))}

      {canDraft && !composing && !editing && (
        <div className="cluster">
          <button type="button" className="btn btn-sm" onClick={() => setComposing(true)}>{open ? "Post an update" : "Add a follow-up"}</button>
          {!open && <span className="t-meta">For what caused it and what you changed. It shows under this incident on your status page.</span>}
        </div>
      )}
      {canDraft && (composing || editing) && (
        <div id="update" className="stack" style={{ scrollMarginTop: "var(--s-5)" }}>
          <fieldset className="field">
            <legend className="label">{editing ? "Edit the draft" : "Post an update"}</legend>
            <div className="seg" role="radiogroup" aria-label="Incident state">
              {states.map((x) => (
                <label key={x.id} title={x.hint}>
                  <input type="radio" name="note-state" checked={state === x.id} onChange={() => setPicked(x.id)} />
                  <span>{x.label}</span>
                </label>
              ))}
            </div>
            <span className="hint">{states.find((x) => x.id === state)?.hint}.</span>
          </fieldset>
          <div className="field">
            <label className="label sr-only" htmlFor="note">Update</label>
            <textarea
              id="note"
              className="textarea"
              rows={3}
              maxLength={2000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={placeholder(state, subject)}
              aria-invalid={!!err}
              aria-describedby={err ? "note-err" : undefined}
            />
            {err && <span className="error" id="note-err" role="alert">{err}</span>}
          </div>
          <div className="cluster">
            {canPublish && (
              <button type="button" className="btn btn-primary" onClick={() => save(true)} disabled={!!busy || !onPage} aria-busy={busy === "publish"}>
                {busy === "publish" ? "Publishing…" : "Publish update"}
              </button>
            )}
            <button type="button" className="btn" onClick={() => save(false)} disabled={!!busy} aria-busy={busy === "draft"}>{busy === "draft" ? "Saving…" : "Save draft"}</button>
            {(editing || !open) && <button type="button" className="btn" disabled={!!busy} onClick={() => { setEditing(null); setText(""); setPicked(null); setComposing(open); setErr(null); }}>Cancel</button>}
          </div>
          {canPublish && !onPage && <p className="t-meta">Publishing needs a status page that shows {subject}. Save a draft for now.</p>}
          {!canPublish && <p className="t-meta">Publishing isn&apos;t part of your role. Save a draft, and someone who can publish will see it here.</p>}
        </div>
      )}

      {published.length > 0 && (
        <ol className="stack" aria-label="Published updates">
          {published.map((n) => (
            <li key={n.id} className="note">
              <div className="spread">
                <strong>{states.find((x) => x.id === n.state)?.label}</strong>
                <span className="t-meta num">{dayTime(n.at, s.now)} {zone(n.at)}</span>
              </div>
              <p>{n.text}</p>
              <span className="t-meta">{n.byAgent ? `Drafted by ${n.author}` : `By ${n.author}`}</span>
            </li>
          ))}
        </ol>
      )}

      {!drafts.length && !published.length && !canDraft && <p className="t-2">No updates yet.</p>}
    </section>
  );
}

function placeholder(state: NoteState, subject: string) {
  switch (state) {
    case "investigating":
      return `${subject} isn't working right now. We're looking into it.`;
    case "identified":
      return `We found the cause and are fixing it. ${subject} should be back shortly.`;
    case "monitoring":
      return `A fix is out and ${subject} is working again. We're keeping an eye on it.`;
    default:
      return `${subject} is working normally again. Nothing you did was lost.`;
  }
}

export function IncidentScreen({ id }: { id: string }) {
  const s = useWorkspace();
  usePoll();
  return s ? <IncidentDetail s={s} id={id} /> : <Loading />;
}
