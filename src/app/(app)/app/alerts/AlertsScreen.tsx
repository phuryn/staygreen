"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Info, Trash2 } from "lucide-react";
import { Loading, PageHead } from "@/components/Shell";
import { BuilderTag, SoonTag } from "@/components/Tags";
import { StateBadge } from "@/components/State";
import { Copy } from "@/components/Copy";
import { Modal, ModalBody, ModalFoot } from "@/components/ui";
import { ChannelIcon } from "@/components/alerts/ChannelIcon";
import { composeOpened, composeResolved, linksFor, type Message } from "@/lib/alerts/compose";
import type { AlertsView, ChannelView, DeliveryView } from "@/lib/alerts/server";
import { dayTime, plural } from "@/lib/format";
import type { Incident } from "@/lib/model";
import { holds } from "@/lib/plans";
import { isLive } from "@/lib/launch";
import { useActs, useWorkspace, type Workspace } from "@/lib/workspace-store";
import {
  addAlertAddress,
  connectTelegram,
  removeAlertChannel,
  resendAlertConfirmation,
  sendTestAlert,
  setMyAlertEmail,
  telegramLinkState,
} from "./actions";
import type { Result } from "../actions";
import { AddChannels, RoutingSettings } from "./ChannelSettings";

/* Alerts (`spec.md § 5`, `docs/flows.md § Alerts`): where Staygreen tells a workspace something
   broke. Email, Telegram, Slack, Discord and signed webhooks share the durable outbox.
   New transports send only from the independent Worker (docs/channels.md).

   Every workspace's members get email at their own address with nothing to set up; on Builder,
   addresses that aren't a member's can be added, each confirmed by its owner first. A Telegram
   chat is bound with a one-time link. Every channel alerts every app until it is turned off for
   one. A test goes through the same receipts and sender as an alert, and the deliveries list is
   those receipts. The preview is the sender's own text (`src/lib/alerts/compose.ts`), built from
   the workspace's latest incident. */

const rules = [
  { area: "alertTiming", text: "Alert only after a few minutes down, and repeat while it stays down." },
  { area: "maintenanceWindows", text: "Maintenance windows that mute alerts and put a notice on your status page." },
] as const;

const stateTag: Record<ChannelView["state"], { text: string; tone: "up" | "unchecked" | "paused" }> = {
  on: { text: "On", tone: "up" },
  waiting: { text: "Waiting", tone: "unchecked" },
  expired: { text: "Link expired", tone: "unchecked" },
  stopped: { text: "Stopped", tone: "paused" },
};

/** One action's answer, toasted where the screen has nowhere else to say it. */
function useRun() {
  const router = useRouter();
  const acts = useActs();
  return async <T extends object>(call: () => Promise<Result<T>>, done?: (r: T) => { title: string; body?: string; tone?: "up" | "warn" | "info" } | null) => {
    let r: Result<T>;
    try {
      r = await call();
    } catch {
      r = { ok: false, reason: "Something went wrong before Staygreen answered. Reload the page to see whether it was done." };
    }
    if (r.ok) {
      const t = done?.(r);
      if (t) acts.toast({ tone: t.tone ?? "up", title: t.title, body: t.body });
      router.refresh();
    } else {
      acts.toast({ tone: "warn", title: "Not done", body: r.reason });
    }
    return r;
  };
}

/** What a channel row says under its name, from its state alone. */
function channelLine(c: ChannelView, view: AlertsView): string {
  if (c.audience === "members") {
    if (!view.members) return "Each member who can see monitors gets alert email at their own address. Staygreen couldn't read the member list just now.";
    if (!view.members.length) return "No member can see monitors, so nobody gets this email.";
    const on = view.members.filter((m) => !m.off).length;
    return `${on} of ${plural(view.members.length, "member")} get alert email at their own address: ${view.members.map((m) => `${m.name}${m.off ? " (turned off)" : ""}`).join(", ")}.`;
  }
  if (c.kind === "telegram") {
    switch (c.state) {
      case "on":
        return "Alerts arrive in this Telegram chat. Sending /stop there stops them.";
      case "stopped":
        return "This chat sent /stop, or removed the bot. Connect it again to get alerts there.";
      case "expired":
        return "The link wasn't used within its hour. Remove this and make a new one.";
      default:
        return "Waiting for Start to be pressed in Telegram.";
    }
  }
  if (c.kind === "slack") return "Incidents post to this Slack channel; recoveries reply in their thread.";
  if (c.kind === "discord") return "Alerts post through this Discord channel's webhook.";
  if (c.kind === "webhook") return "Signed deliveries go to your saved endpoint, with five retries over 30 minutes.";
  switch (c.state) {
    case "on":
      return "Gets every alert. Each email has a link to stop them.";
    case "stopped":
      return "Unsubscribed with the link in an alert. Nothing more is sent to it.";
    case "expired":
      return "The confirmation link expired before it was used. Send a new one.";
    default:
      return "Waiting for its owner to follow the confirmation link. Nothing is sent until then.";
  }
}

function Alerts({ s, view }: { s: Workspace; view: AlertsView }) {
  const [adding, setAdding] = useState<"email" | "telegram" | null>(null);
  const [removing, setRemoving] = useState<ChannelView | null>(null);
  const manage = s.can["channels:manage"];
  const teammates = holds(s, "notify_teammates");
  const live = view.channels.filter((c) => c.state === "on");
  const latest = [...s.incidents].sort((a, b) => b.openedAt - a.openedAt)[0];

  return (
    <>
      <PageHead
        title="Alerts"
        sub="Where Staygreen tells you something broke, and when it's fixed. A failed check is checked again before it alerts, except an expired or invalid certificate, which alerts at once; a heartbeat alerts once its grace window passes."
      />

      {!view.email.ready && (
        <p className="callout callout-warn">
          <Info aria-hidden="true" />
          <span>Email isn&apos;t set up on this server, so no alert email is sent from it. Its receipts wait until it is.</span>
        </p>
      )}
      {view.email.ready && view.email.redirectTo && (
        <p className="callout callout-info">
          <Info aria-hidden="true" />
          <span>
            Development: every email goes to <span className="addr">{view.email.redirectTo}</span> instead of its recipient, and the deliveries below say so.
          </span>
        </p>
      )}

      <section className="section" aria-labelledby="ch-h">
        <div className="section-head">
          <h2 id="ch-h" className="t-section">Channels</h2>
          <span className="t-meta">{plural(live.length, "channel")} sending</span>
        </div>
        <div className="panel panel-flush">
          {view.channels.map((c) => (
            <ChannelRow key={c.id} c={c} view={view} now={s.now} manage={manage} teammates={teammates} onRemove={() => setRemoving(c)} />
          ))}
        </div>
        {manage && (
          <div className="stack-sm">
            <span className="label">Add a channel</span>
            <div className="cluster">
              <button type="button" className="btn" disabled={!view.telegram.ready} aria-describedby={view.telegram.ready ? undefined : "tg-off"} onClick={() => setAdding("telegram")}>
                <ChannelIcon kind="telegram" />
                Telegram
              </button>
              {teammates ? (
                <button type="button" className="btn" disabled={!view.email.ready} onClick={() => setAdding("email")}>
                  <ChannelIcon kind="email" />
                  Teammate&apos;s email
                </button>
              ) : (
                <BuilderTag offer="teammates" control="btn">Teammate&apos;s email</BuilderTag>
              )}
            </div>
            {!view.telegram.ready && <span id="tg-off" className="hint">Telegram isn&apos;t set up on this server yet.</span>}
            <AddChannels ready={view.slack.ready} />
          </div>
        )}
      </section>

      <RoutingSettings s={s} view={view} manage={manage} />

      <section className="section" aria-labelledby="rl-h">
        <div className="section-head">
          <h2 id="rl-h" className="t-section cluster">Alert timing and maintenance <BuilderTag locked={!holds(s, "alert_rules")} offer="alertRules" /></h2>
        </div>
        <div className="panel stack-sm">
          <p className="t-2">Alerts follow your routing as soon as a failure is confirmed. These Builder timing rules come later:</p>
          <ul className="pb-bullets">
            {rules.map((r) => <li key={r.area}>{r.text} {!isLive(r.area) && <SoonTag />}</li>)}
          </ul>
        </div>
      </section>

      <section className="section" aria-labelledby="pv-h">
        <div className="section-head">
          <h2 id="pv-h" className="t-section">What an alert says</h2>
          {latest && (
            <span className="t-meta">
              Built from your latest incident, <Link className="link" href={`/app/incidents/${latest.id}`}>{latest.title}</Link>
            </span>
          )}
        </div>
        {latest ? (
          <Preview s={s} inc={latest} appUrl={view.appUrl} />
        ) : (
          <div className="panel empty">
            <span className="t-2">When you have an incident, this shows the messages it sends, built from that incident.</span>
          </div>
        )}
      </section>

      <Deliveries s={s} view={view} />

      <ConnectTelegram open={adding === "telegram"} onClose={() => setAdding(null)} />
      <AddAddress open={adding === "email"} onClose={() => setAdding(null)} />
      <RemoveDialog c={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

function ChannelRow({ c, view, now, manage, teammates, onRemove }: { c: ChannelView; view: AlertsView; now: number; manage: boolean; teammates: boolean; onRemove: () => void }) {
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const last = view.deliveries.find((d) => d.channelId === c.id);
  const me = view.members?.find((m) => m.you);
  const tag = stateTag[c.state];
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const test = () =>
    act(() =>
      run(() => sendTestAlert(c.id), (r) =>
        r.sent
          ? { title: "Test sent", body: c.audience === "members" ? "It went to you, at your own address." : `It went to ${c.label}.` }
          : { tone: "warn", title: "Test not sent yet", body: r.detail ?? undefined },
      ),
    );

  return (
    <div className="channel-row pb-chan">
      <span className="channel-icon"><ChannelIcon kind={c.kind} /></span>
      <div className="stack-sm pb-tight">
        <span className="cluster">
          <strong className="wrap-anywhere">{c.label}</strong>
          <StateBadge state={tag.tone} label={tag.text} />
          {c.audience === "address" && <BuilderTag locked={!teammates} offer="teammates" />}
        </span>
        <span className="t-2">{channelLine(c, view)}</span>
        {last && <span className="t-meta">Last delivery {dayTime(last.at, now).toLowerCase()}: {statusBadge[last.status].label.toLowerCase()}.</span>}
      </div>
      <div className="cluster pb-chan-actions">
        {c.state === "on" && manage && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={test}>
            {c.audience === "members" ? "Send me a test" : "Send test"}
          </button>
        )}
        {c.audience === "members" && me && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(() => run(() => setMyAlertEmail(me.off), () => ({ title: me.off ? "Your alert email is on" : "Your alert email is off" })))}>
            {me.off ? "Turn mine on" : "Turn mine off"}
          </button>
        )}
        {c.audience === "address" && (c.state === "waiting" || c.state === "expired") && manage && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => act(() => run(() => resendAlertConfirmation(c.id), (r) => (r.sent ? { title: "Confirmation sent again" } : { tone: "warn", title: "Not sent", body: r.detail })))}>
            Send the link again
          </button>
        )}
        {c.audience !== "members" && manage && (
          <button type="button" className="btn btn-sm btn-quiet btn-icon" aria-label={`Remove ${c.label}`} onClick={onRemove}>
            <Trash2 aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function MessageCard({ m, label }: { m: Message; label: string }) {
  return (
    <div className="msg al-msg">
      <span className="t-meta">{label}</span>
      <strong className="wrap-anywhere">{m.subject}</strong>
      {m.lines.map((l, i) => (l ? <span key={i} className="wrap-anywhere">{l}</span> : null))}
    </div>
  );
}

function Preview({ s, inc, appUrl }: { s: Workspace; inc: Incident; appUrl: string }) {
  const app = s.apps.find((a) => a.id === inc.appId);
  const m = s.monitors.find((x) => x.id === inc.monitorId);
  const page = s.pages.find((p) => p.appId === inc.appId);
  const about = { appName: app?.name ?? "Your app", monitorName: m?.name ?? inc.title, monitorType: m?.type ?? "http", pageSlug: page?.slug ?? null };
  const links = linksFor(appUrl, inc.id, about.pageSlug);
  const opened = composeOpened(inc, about, links);
  const resolved = inc.resolvedAt ? composeResolved(inc, about, links, "up") : null;
  return (
    <div className="panel stack-sm">
      <div className="preview-phone">
        <MessageCard m={opened} label="When it opens, by email and on Telegram" />
        {resolved && <MessageCard m={resolved} label="When it recovers" />}
      </div>
      <p className="t-meta">
        The sender&apos;s own text, with times in UTC here; a member&apos;s email uses their own time zone when Clerk has one. An email ends with why it was sent and a link to stop them, a Telegram message with how to stop them.
      </p>
    </div>
  );
}

const statusBadge: Record<DeliveryView["status"], { state: "up" | "down" | "unchecked" | "paused"; label: string }> = {
  sent: { state: "up", label: "Sent" },
  failed: { state: "down", label: "Failed" },
  skipped: { state: "paused", label: "Skipped" },
  pending: { state: "unchecked", label: "Waiting" },
  sending: { state: "unchecked", label: "Sending" },
};
const eventWord = { opened: "Opened", resolved: "Recovered", test: "Test" } as const;

function Deliveries({ s, view }: { s: Workspace; view: AlertsView }) {
  const [all, setAll] = useState(false);
  const rows = all ? view.deliveries : view.deliveries.slice(0, 12);
  return (
    <section className="section" aria-labelledby="dl-h">
      <div className="section-head">
        <h2 id="dl-h" className="t-section">Deliveries</h2>
        <span className="t-meta">One receipt per message and recipient, written before it is sent.</span>
      </div>
      {view.deliveries.length === 0 ? (
        <div className="panel empty"><span className="t-2">Nothing sent yet. Send a test from a channel above, and its receipt shows here.</span></div>
      ) : (
        <div className="panel panel-flush">
          <div className="scroll-x pb-clip">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">To</th>
                  <th scope="col">Event</th>
                  <th scope="col">Incident</th>
                  <th scope="col">Receipt</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td className="num">{dayTime(d.at, s.now)}</td>
                    <td>
                      <span className="row pb-gap-1">
                        {d.kind && <ChannelIcon kind={d.kind} size={14} />}
                        <span className="wrap-anywhere">{d.to}</span>
                      </span>
                    </td>
                    <td>{eventWord[d.event]}</td>
                    <td className="pb-title-cell">
                      {d.incidentId ? <Link className="link" href={`/app/incidents/${d.incidentId}`}>{d.incidentTitle ?? d.incidentId}</Link> : <span className="t-3">None</span>}
                    </td>
                    <td>
                      <span className="stack-sm pb-tight">
                        <StateBadge state={statusBadge[d.status].state} label={statusBadge[d.status].label} />
                        {d.detail && <span className="t-meta">{d.detail}</span>}
                        {d.providerId && (
                          <span className="t-meta">
                            {d.kind === "email" ? "Postmark" : d.kind === "telegram" ? "Telegram message" : d.kind === "slack" ? "Slack message" : d.kind === "discord" ? "Discord message" : "Delivery"} <code className="code">{d.providerId}</code>
                            {d.redirected ? ", to the development address" : ""}
                          </span>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {view.deliveries.length > 12 && (
            <div className="pb-table-foot">
              <button type="button" className="btn btn-sm" onClick={() => setAll((v) => !v)} aria-expanded={all}>
                {all ? "Show the latest 12" : `Show all ${view.deliveries.length}`}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ConnectTelegram({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [link, setLink] = useState<{ id: string; link: string; expiresInMin: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ label: string | null; already: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLink(null);
    setDone(null);
    setError(null);
    connectTelegram().then(
      (r) => {
        if (cancelled) return;
        if (r.ok) setLink(r);
        else setError(r.reason);
      },
      () => {
        if (!cancelled) setError("Something went wrong before Staygreen answered. Close this and try again.");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Waits for the bot to see Start: the chat is bound by the bot's update, not by this page.
  useEffect(() => {
    if (!open || !link || done) return;
    const timer = setInterval(async () => {
      try {
        const r = await telegramLinkState(link.id);
        if (r.ok && r.state !== "waiting") {
          setDone({ label: r.label, already: r.state === "gone" });
          router.refresh();
        }
      } catch {
        // The next tick asks again.
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [open, link, done, router]);

  const close = () => {
    onClose();
    router.refresh();
  };

  return (
    <Modal open={open} onClose={close}>
      <ModalBody title="Connect Telegram">
        {error ? (
          <p className="callout callout-warn"><span>{error}</span></p>
        ) : done ? (
          <p className="callout callout-up" role="status">
            <span>
              {done.already
                ? "That chat was already connected to this workspace. It gets alerts again, and a test alert is on its way there."
                : `Connected${done.label ? ` to ${done.label}` : ""}. A test alert is on its way to that chat, and it now gets every alert for your apps.`}
            </span>
          </p>
        ) : !link ? (
          <p className="t-2" role="status">Making a link…</p>
        ) : (
          <ol className="steps">
            <li className="step now" aria-current="step">
              <span className="step-n num" aria-hidden="true">1</span>
              <div className="stack-sm">
                <strong>Open this link where you want alerts, and press Start</strong>
                <span className="hint">It works once, within {link.expiresInMin} minutes, and binds the chat that presses Start. Anyone with it could bind theirs, so keep it to yourself.</span>
                <span className="cluster">
                  <a className="btn btn-primary" href={link.link} target="_blank" rel="noreferrer">Open Telegram</a>
                  <Copy text={link.link} label="Copy link" />
                </span>
              </div>
            </li>
            <li className="step">
              <span className="step-n num" aria-hidden="true">2</span>
              <div className="stack-sm">
                <strong>A test alert arrives in the chat</strong>
                <span className="hint" role="status">Waiting for Start to be pressed…</span>
              </div>
            </li>
          </ol>
        )}
      </ModalBody>
      <ModalFoot>
        <button type="button" className={done ? "btn btn-primary" : "btn"} onClick={close}>{done ? "Done" : "Close"}</button>
      </ModalFoot>
    </Modal>
  );
}

function AddAddress({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ address: string; ok: boolean; detail?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setAddress("");
      setError(null);
      setSent(null);
    }
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await addAlertAddress({ address });
      if (r.ok) {
        setSent({ address: address.trim().toLowerCase(), ok: r.sent, detail: r.detail });
        router.refresh();
      } else {
        setError(r.fieldErrors?.address ?? r.reason);
      }
    } catch {
      setError("Something went wrong before Staygreen answered. Reload the page to see whether it was added.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <ModalBody title="Add a teammate's email">
          {sent ? (
            <p className={`callout ${sent.ok ? "callout-up" : "callout-warn"}`} role="status">
              <span>
                {sent.ok
                  ? `A confirmation link is on its way to ${sent.address}. Alerts start once it's followed, within 7 days.`
                  : `${sent.address} is added, but the confirmation email didn't go: ${sent.detail ?? "try again."} Send the link again from its row.`}
              </span>
            </p>
          ) : (
            <>
              <p className="t-2">For someone who should get alerts without a Staygreen account. They get a confirmation email first, and nothing else until they follow its link. Members get alerts already.</p>
              <div className="field">
                <label className="label" htmlFor="al-addr">Email address</label>
                <input
                  id="al-addr"
                  className="input"
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  placeholder="oncall@yourapp.com"
                  value={address}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "al-addr-err" : undefined}
                  onChange={(e) => setAddress(e.target.value)}
                />
                {error && <span id="al-addr-err" className="error">{error}</span>}
              </div>
            </>
          )}
        </ModalBody>
        <ModalFoot>
          {sent ? (
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={busy}>Send confirmation</button>
            </>
          )}
        </ModalFoot>
      </form>
    </Modal>
  );
}

function RemoveDialog({ c, onClose }: { c: ChannelView | null; onClose: () => void }) {
  const run = useRun();
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={!!c} onClose={onClose}>
      {c && (
        <>
          <ModalBody title={`Remove ${c.label}?`}>
            <p className="t-2">Staygreen stops sending there at once. Its past deliveries stay in the list.</p>
          </ModalBody>
          <ModalFoot>
            <button type="button" className="btn" onClick={onClose}>Keep it</button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await run(() => removeAlertChannel(c.id), () => ({ tone: "info", title: `${c.label} removed`, body: "Nothing more is sent there." }));
                  if (r.ok) onClose();
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove channel
            </button>
          </ModalFoot>
        </>
      )}
    </Modal>
  );
}

export function AlertsScreen({ view }: { view: AlertsView }) {
  const s = useWorkspace();
  return s ? <Alerts s={s} view={view} /> : <Loading />;
}
