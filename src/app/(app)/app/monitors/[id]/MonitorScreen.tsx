"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { KeyRound, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { Loading, PageHead } from "@/components/Shell";
import { StateBadge, StateIcon } from "@/components/State";
import { ResponseChart, UptimeBars, padDays } from "@/components/charts";
import { Copy } from "@/components/Copy";
import { DeleteDialog } from "@/components/DeleteDialog";
import { Flag } from "@/components/Flag";
import { BuilderTag, SoonTag } from "@/components/Tags";
import { TypeIcon } from "@/components/TypeIcon";
import { HeartbeatUrl } from "@/components/HeartbeatUrl";
import { pageHost } from "@/lib/derive";
import { certCell, domainCell, type ExpiryCell } from "@/lib/expiry";
import { everyLabel, newestReport, noNumber, recoveryNote, reportedWhen, reportResult, reportState, stateLabel, versionSince, type MonitorHistory } from "@/lib/history";
import { awaitingNumbers } from "@/lib/poll";
import { hostOf, isCreatable } from "@/lib/monitor-input";
import { typeLabel } from "@/lib/model";
import { ago, dayTime, dur, ms, pct, time, until, zone } from "@/lib/format";
import { locationIds, locations, limitsOf } from "@/lib/plans";
import { agentBrief } from "@/lib/agent";
import { isBuilt } from "@/lib/launch";
import { useActs, useEagerPoll, usePoll, useWorkspace, type Workspace } from "@/lib/workspace-store";
import type { HeartbeatLatest, Monitor, ReceivedPing, Uptime } from "@/lib/model";

const DAY = 86_400_000;

function MonitorDetail({ s, id, pingUrl, history, latest }: { s: Workspace; id: string; pingUrl: string | null; history: MonitorHistory; latest: HeartbeatLatest | null }) {
  const router = useRouter();
  const acts = useActs();
  const del = useRef<HTMLDialogElement>(null);
  const m = s.monitors.find((x) => x.id === id);
  useEagerPoll(!!m && awaitingNumbers(m, s.now));
  if (!m) {
    return (
      <div className="empty">
        <h1 className="t-title">This monitor isn&apos;t here any more</h1>
        <p className="t-2">You or a teammate may have deleted it.</p>
        <Link href="/app/monitors" className="btn">Back to monitors</Link>
      </div>
    );
  }
  const mon = m;
  const app = s.apps.find((a) => a.id === m.appId);
  const inc = m.incidentId ? s.incidents.find((i) => i.id === m.incidentId) : null;
  const host = targetHost(m);
  const sslFor = host && m.type !== "ssl" ? s.monitors.find((x) => x.type === "ssl" && x.ssl?.host === host) : undefined;
  const components = s.pages.flatMap((p) => p.components.filter((c) => c.monitorIds.includes(m.id)).map((c) => ({ page: p, c })));
  const write = s.can["monitors:write"];
  const newest = newestReport(m);
  // A check passes only when every assertion holds, so a newest window with no failure says each
  // one did. A failed check's message, in Events, names the one that broke. A heartbeat's
  // assertions are judged on its newest good ping, which the snapshot carries per assertion.
  const heartbeat = m.type === "heartbeat";
  const probed = m.checked && !heartbeat;
  const assertionsHeld = probed && newest && newest.failures === 0 ? true : undefined;
  // This page's own read (failed checks and state changes) with what the snapshot knows (created,
  // paused), newest first.
  const events = [...history.events, ...m.events].sort((a, b) => b.t - a.t).slice(0, 20);

  return (
    <>
      <PageHead
        back={{ href: "/app/monitors", label: "Monitors" }}
        doc={m.name}
        title={
          <span className="row" style={{ gap: "var(--s-3)" }}>
            <TypeIcon type={m.type} size={24} />
            {m.name}
          </span>
        }
        sub={
          <span className="cluster">
            {app && <span>{app.name}</span>}
            <span className="t-3">{typeLabel[m.type]}</span>
            {m.type !== "heartbeat" && <code className="code">{m.target}</code>}
            {m.auto && <span className="t-3">Added automatically</span>}
          </span>
        }
        actions={
          <>
            {write && !m.auto && isCreatable(m.type) && (
              <Link href={`/app/monitors/${m.id}/edit`} className="btn"><Pencil aria-hidden="true" />Edit</Link>
            )}
            {write &&
              (m.paused ? (
                <button type="button" className="btn" onClick={() => acts.resume(mon.id)}><Play aria-hidden="true" />Resume</button>
              ) : (
                <>
                  <button type="button" className="btn" popoverTarget="pause-pop"><Pause aria-hidden="true" />Pause</button>
                  <div id="pause-pop" popover="auto" className="pop">
                    <div className="stack-sm">
                      <strong>Pause checks and alerts</strong>
                      <p className="t-meta">Paused time doesn&apos;t count against uptime.</p>
                      {[{ l: "For 1 hour", v: 60 }, { l: "For 24 hours", v: 1440 }, { l: "Until I resume", v: null }].map((o) => (
                        <button key={o.l} type="button" className="btn btn-sm btn-block" popoverTarget="pause-pop" popoverTargetAction="hide" onClick={() => acts.pause(mon.id, o.v)}>{o.l}</button>
                      ))}
                    </div>
                  </div>
                </>
              ))}
            {s.can["monitors:delete"] && (
              <button type="button" className="btn btn-quiet btn-icon" aria-label="Delete monitor" onClick={() => del.current?.showModal()}><Trash2 aria-hidden="true" /></button>
            )}
          </>
        }
      />

      <div className="stack-lg">
        <section className="stack">
          <div className="hero-state">
            <StateBadge state={m.state} label={stateLabel(m)} size={22} />
            <span className="t-2">
              {m.paused
                ? m.paused.until
                  ? `Resumes ${until(m.paused.until, s.now)}.${m.paused.reason ? ` ${m.paused.reason}.` : ""}`
                  : `Until you resume it.${m.paused.reason ? ` ${m.paused.reason}.` : ""}`
                : m.state === "unchecked"
                  ? m.type === "heartbeat"
                    ? m.hb?.lastPingAt
                      ? "The first ping arrived. Staygreen judges it within a minute."
                      : "Waiting for the first ping."
                    : m.checked
                      ? "Checked, but a failed check counts only once a second check confirms it."
                      : "Waiting for the first check."
                  : `Since ${dayTime(m.stateSince, s.now)} ${zone(m.stateSince)}, ${dur(s.now - m.stateSince)}.${recoveryNote(m) ? ` ${recoveryNote(m)}` : ""}`}
            </span>
          </div>

          {inc && (
            <div className={`alarm ${inc.severity === "degraded" ? "warn" : ""}`}>
              <StateIcon state={inc.severity} size={20} />
              <div className="alarm-body">
                <strong>{inc.title}</strong>
                {(inc.evidence.request || inc.evidence.summary) && (
                  <span>{inc.evidence.request && <code className="code">{inc.evidence.request}</code>} {inc.evidence.summary}{inc.evidence.summary && "."}</span>
                )}
                <span className="t-meta">Open for {dur(s.now - inc.openedAt)}. {inc.ackedAt ? "Acknowledged." : "Not acknowledged."}</span>
              </div>
              <div className="cluster">
                <Link href={`/app/incidents/${inc.id}`} className="btn btn-primary btn-sm">Open incident</Link>
                <Copy text={agentBrief(s, inc)} label="Copy for agent" />
              </div>
            </div>
          )}

          {!inc && m.state === "degraded" && (
            <div className="alarm warn">
              <StateIcon state="degraded" size={20} />
              <div className="alarm-body">
                <strong>{m.type === "ssl" ? "The certificate expires soon" : "Responses are slow"}</strong>
                <span>
                  {m.type === "ssl" && m.ssl?.certDays != null
                    ? `${m.ssl.certDays} days left. Let's Encrypt certificates renew 30 days before expiry, so check your host's auto-renew.`
                    : `The last 3 checks took longer than ${ms(m.slowMs)}. It's a warning: nothing is down.`}
                </span>
              </div>
            </div>
          )}
        </section>

        <Stats s={s} m={m} sslFor={sslFor} />

        <div className="detail-grid">
          <div className="stack-lg">
            {m.hb && <PingUrl key={m.id} s={s} m={m} pingUrl={pingUrl} />}

            {m.hb && <Received s={s} m={m} latest={latest} />}

            {/* A heartbeat's runs have no response time: its windows count runs, not milliseconds. */}
            {history.points.length > 0 && m.type !== "ssl" && !heartbeat && (
              <section className="panel stack" aria-labelledby="rt">
                <div className="panel-head">
                  <h2 id="rt" className="t-section">Response time, last 24 hours</h2>
                  <span className="t-meta">5-minute windows, every location together</span>
                </div>
                <ResponseChart points={history.points} incidents={s.incidents.filter((i) => i.monitorId === m.id)} slowMs={m.slowMs} stepMs={Math.max(300, m.intervalSec) * 1000} />
              </section>
            )}

            {(m.type === "http" || m.type === "tcp" || m.type === "dns") && (
              <section className="stack" aria-labelledby="locs">
                <div className="spread">
                  <h2 id="locs" className="t-section">{m.type === "dns" ? "Asked of" : "Checked from"}</h2>
                  {m.type !== "dns" && <span className="t-meta">Each location&apos;s newest 5-minute summary</span>}
                </div>
                <Locations s={s} m={m} history={history} />
              </section>
            )}

            {m.assertions && m.assertions.length > 0 && (
              <section className="panel" aria-labelledby="asserts">
                <div className="panel-head">
                  <h2 id="asserts" className="t-section">Assertions</h2>
                  <span className="t-meta num">{m.assertions.length} of {m.type === "heartbeat" ? limitsOf(s).heartbeatAssertions : limitsOf(s).assertions} on {s.plan === "builder" ? "Builder" : "Free"}</span>
                </div>
                <div>
                  {m.assertions.map((a) => {
                    const held = a.pass ?? assertionsHeld;
                    return (
                      <div key={a.id} className="assert-row">
                        {held === undefined ? (
                          <StateIcon state="unchecked" size={16} title={heartbeat ? "No ping yet" : probed ? "No result yet" : "Not checked yet"} />
                        ) : (
                          <StateIcon state={held ? "up" : "down"} size={16} title={held ? "Passing" : "Failing"} />
                        )}
                        <code className="addr">{a.path} {a.op}{a.op === "exists" ? "" : ` ${a.value}`}</code>
                        <span className={`num ${held === false ? "t-down" : "t-3"}`}>
                          {a.got !== undefined
                            ? `got ${a.got}`
                            : heartbeat
                              ? held === false ? "missing from the last ping" : held ? "held on the last ping" : "no ping yet"
                              : held && newest ? `held, ${reportedWhen(newest, s.now, versionSince(m))}` : !probed ? "not checked yet" : newest ? "see Events" : "no data yet"}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {m.type === "http" && <p className="t-meta" style={{ marginTop: "var(--s-3)" }}>Expected status {m.expect ?? "2xx"}{m.keyword ? `, and the body contains "${m.keyword}"` : ""}.</p>}
              </section>
            )}

            {m.type !== "ssl" && (
              <section className="panel stack" aria-labelledby="days">
                <div className="panel-head">
                  <h2 id="days" className="t-section">Last 90 days</h2>
                  <span className="t-meta">UTC days. A grey day had no checks.</span>
                </div>
                <UptimeBars daily={padDays(m.daily, 90)} now={s.now} label={m.name} />
              </section>
            )}

            <section className="panel" aria-labelledby="events">
              <div className="panel-head">
                <h2 id="events" className="t-section">Events</h2>
                <span className="t-meta">{heartbeat ? "Failures keep the ping's masked payload" : "Failed checks keep a masked response snippet"}</span>
              </div>
              <ol className="events">
                {events.map((e) => (
                  <li key={e.id} className="event">
                    <time className="num" dateTime={new Date(e.t).toISOString()}>{dayTime(e.t, s.now)}</time>
                    <span className={`event-dot ${e.kind}`} aria-hidden="true" />
                    <div className="stack-sm" style={{ gap: 4, minWidth: 0 }}>
                      <span>{e.text}</span>
                      {e.snippet && <pre className="snippet wrap">{e.snippet}</pre>}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <aside className="stack">
            <Config s={s} m={m} />
            <section className="panel panel-tight stack-sm" aria-labelledby="pub">
              <h2 id="pub" className="t-section">On status pages</h2>
              {components.length ? (
                <ul className="stack-sm">
                  {components.map(({ page, c }) => (
                    <li key={page.id + c.id}>
                      {c.name} on <Link href={`/app/status-pages/${page.id}`} className="link">{pageHost(page)}</Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="t-2">Not shown on any status page.</p>
              )}
            </section>
          </aside>
        </div>
      </div>

      <DeleteDialog ref={del} title={`Delete ${m.name}?`} confirm="Delete monitor" run={() => acts.deleteMonitor(mon.id)} onDone={() => router.replace("/app/monitors")}>
        <p>Its checks stop, and its history and incidents are deleted. Status page components that use it lose it. This can&apos;t be undone.</p>
      </DeleteDialog>
    </>
  );
}

/** "From 3 h 20 min of checks" when the windows covered less than the stretch an uptime is over:
 *  a new monitor's 30-day uptime is only its first days'. */
const covered = (u: Uptime, overMs: number) => (u.pct !== null && u.coveredMs < overMs - 300_000 ? `From ${dur(u.coveredMs)} of checks` : undefined);

/** A certificate's or a domain's days left, or the words in their place. */
const expiryValue = (c: ExpiryCell) => (c.days !== null ? <>{c.days} <small>{c.text}</small></> : <small>{c.text}</small>);

/** The monitor's numbers, in one strip split by hairlines rather than a tile each
 *  (`design/README.md § Checked against the defaults`). */
function Stats({ s, m, sslFor }: { s: Workspace; m: Monitor; sslFor?: Monitor }) {
  const cells: { label: string; value: React.ReactNode; note?: string }[] = [];
  const none = <small>{noNumber(m)}</small>;
  const { day: u24, month: u30 } = m.uptime;
  if (m.type === "ssl") {
    const cert = certCell(m.ssl, noNumber(m));
    const domain = domainCell(m.ssl);
    cells.push({ label: "Certificate", value: expiryValue(cert), note: cert.note });
    cells.push({ label: "Domain registration", value: expiryValue(domain), note: domain.note });
    // Reminders are alerting's (stage 2.3): until it sends them, the cell says when they will go.
    cells.push({ label: "Reminders", value: <small>21, 7 and 1 days</small>, note: `Domains: 30, 7 and 1 days${isBuilt("alerts") ? "" : ". Not sent yet"}` });
    cells.push({ label: "Checked", value: <small>Every 6 hours</small>, note: "Chain, hostname and expiry; the domain daily" });
  } else if (m.type === "heartbeat" && m.hb) {
    const hb = m.hb;
    const pinged = hb.lastPingAt > 0;
    const kind = hb.lastKind === "start" ? "/start, " : hb.lastKind === "fail" ? "/fail, " : "";
    cells.push({ label: "Last ping", value: pinged ? time(hb.lastPingAt) : <small>No ping yet</small>, note: pinged ? `${kind}${ago(hb.lastPingAt, s.now)}` : undefined });
    // The same next run the home's deadline is built on (`src/lib/heartbeat-view.ts`).
    cells.push({
      label: "Expected",
      value: hb.expectedAt !== null ? dayTime(hb.expectedAt, s.now) : <small>{m.paused ? "Paused" : pinged ? hb.scheduleLabel : "After the first ping"}</small>,
      note: `${hb.scheduleLabel}, ${hb.tz}, plus ${hb.graceMin} min grace`,
    });
    cells.push({ label: "Uptime, 30 days", value: u30.pct === null ? none : pct(u30.pct), note: u30.pct === null ? undefined : covered(u30, 30 * DAY) ?? "Expected runs on time and passing" });
    cells.push(
      hb.runningSince !== null
        ? { label: "Running since", value: time(hb.runningSince), note: `Stuck after ${hb.maxRunMin} min without a finish` }
        : { label: "Max run time", value: <>{hb.maxRunMin} <small>min</small></>, note: "From a /start ping to the finish" },
    );
  } else if (m.type === "dns" && m.dns) {
    cells.push({ label: "Record", value: <small>{m.dns.record}</small>, note: m.dns.name });
    cells.push({ label: "Expected", value: <small className="addr">{m.dns.expected}</small> });
    cells.push({ label: "Last answer", value: m.dns.got ? <small className="addr">{m.dns.got}</small> : none });
    cells.push({ label: "Resolvers", value: <small>Cloudflare and Google</small>, note: "Every 10 minutes" });
  } else {
    // The newest window with a response time: one whose checks all failed has none.
    const timed = m.reports.find((r) => r.p50 !== null);
    cells.push({ label: "Uptime, 24 hours", value: u24.pct === null ? none : pct(u24.pct), note: covered(u24, DAY) });
    cells.push({ label: "Uptime, 30 days", value: u30.pct === null ? none : pct(u30.pct), note: covered(u30, 30 * DAY) });
    cells.push({ label: "Recent response", value: timed ? ms(timed.p50) : none, note: timed ? `Median in ${locations[timed.loc].city}, ${reportedWhen(timed, s.now, versionSince(m))}` : undefined });
    cells.push({ label: "p95, 24 hours", value: m.p95 !== null ? ms(m.p95) : none, note: m.p95 !== null ? "Every location together" : undefined });
    if (sslFor) {
      const cert = certCell(sslFor.ssl, noNumber(sslFor));
      cells.push({ label: "Certificate", value: expiryValue(cert), note: cert.note });
    }
  }
  return (
    <div className="stat-strip">
      {cells.map((t) => (
        <div key={t.label} className="stat">
          <span className="stat-label">{t.label}</span>
          <span className="stat-value num">{t.value}</span>
          {t.note && <span className="stat-delta">{t.note}</span>}
        </div>
      ))}
    </div>
  );
}

/** Where the checks come from: each location's newest 5-minute window, which a probe writes when
 *  the window closes. A location that hasn't reported says so instead of inventing a number. One
 *  panel, a row each: the city leads with its flag and its country, and the state sits at the
 *  row's far end, away from the flags' red. */
function Locations({ s, m, history }: { s: Workspace; m: Monitor; history: MonitorHistory }) {
  const all = locationIds;
  const mine = limitsOf(s).locations;
  if (m.type === "dns") {
    // Both resolvers are asked in every check, so each row shows the newest window. A resolver is
    // a service, not a place, so it has no flag.
    const r = newestReport(m);
    return (
      <ul className="locs">
        {["Cloudflare, 1.1.1.1", "Google, 8.8.8.8"].map((name) => (
          <li key={name} className="loc">
            <div className="loc-body">
              <strong>{name}</strong>
              <span className="t-meta">{m.dns?.got ? `Answered ${m.dns.got}` : r ? `${reportResult(r)}, ${reportedWhen(r, s.now, versionSince(m))}` : m.checked ? "No data yet" : "Not asked yet"}</span>
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className="locs">
      {all.map((l) => {
        if (!mine.includes(l) || !locations[l].live)
          return (
            <li key={l} className="loc off">
              <div className="loc-body">
                <span className="loc-place"><Flag loc={l} /><strong>{locations[l].city}</strong></span>
                <span className="t-meta">{locations[l].country}. A third location, in {locations[l].continent}.</span>
              </div>
              {!locations[l].live && <SoonTag />}
              {!mine.includes(l) && <BuilderTag offer="location" />}
            </li>
          );
        const r = m.reports.find((x) => x.loc === l);
        const failed = r && r.failures > 0 ? history.lastFailure[l] : undefined;
        return (
          <li key={l} className="loc">
            <div className="loc-body">
              <span className="loc-place"><Flag loc={l} /><strong>{locations[l].city}</strong></span>
              <span className="t-meta">{locations[l].country}{r ? `, ${r.end > s.now ? "checked" : "reported"} ${reportedWhen(r, s.now, versionSince(m))}` : ""}</span>
              {r && r.p50 !== null && <span className="num">{ms(r.p50)} median</span>}
              {failed && <span className="t-meta wrap-anywhere">{failed.message}</span>}
            </div>
            {r ? <StateBadge state={reportState(r)} label={reportResult(r)} /> : <StateBadge state="unchecked" label={noNumber(m)} />}
          </li>
        );
      })}
    </ul>
  );
}

function Config({ s, m }: { s: Workspace; m: Monitor }) {
  const rows: [string, React.ReactNode][] = [];
  const every = everyLabel(m.intervalSec);
  if (m.serviceConfig) {
    rows.push(["Every", every]);
    rows.push(["Key", m.hasServiceKey ? "Stored encrypted" : "Missing; edit to add it"]);
    if ("projectUrl" in m.serviceConfig) {
      rows.push(["Project", <a key="project" className="link" href={`https://supabase.com/dashboard/project/${hostOf(m.target).split(".")[0]}`} target="_blank" rel="noreferrer">Open project dashboard</a>]);
      rows.push(["Database read", m.serviceConfig.databaseRead || "Not set. Auth and Storage checks do not keep a Free project awake."]);
    } else {
      rows.push(["Endpoint status", m.serviceConfig.endpoints.join(", ")]);
      rows.push(["Delivery scope", "Entire Stripe account"]);
      rows.push(["Critical types", m.serviceConfig.critical.join(", ") || "None"]);
      rows.push(["Threshold", `${m.serviceConfig.failureThreshold} affected events in ${m.serviceConfig.windowMin} min, or one critical event`]);
      rows.push(["Pending threshold", `${m.serviceConfig.pendingMin} min`]);
    }
  }
  if (m.type === "http") {
    rows.push(["Request", <code key="r" className="code wrap-anywhere">{m.method ?? "GET"} {m.target.replace(/^https?:\/\/[^/]+/, "") || "/"}</code>]);
    rows.push(["Host", <span key="h" className="addr">{hostOf(m.target)}</span>]);
    rows.push(["Every", every]);
    rows.push(["Timeout", `${m.timeoutSec ?? 15} s`]);
    rows.push(["Slow above", ms(m.slowMs)]);
    rows.push(["Redirects", "followed, up to 5"]);
    if (m.secretHeaders?.length) rows.push(["Secret headers", m.secretHeaders.map((h) => `${h}: •••`).join(", ")]);
  }
  if (m.type === "tcp" && m.tcp) {
    rows.push(["Host and port", <code key="t" className="code">{m.tcp.host}:{m.tcp.port}</code>]);
    rows.push(["TLS handshake", m.tcp.tls ? "yes" : "no"]);
    rows.push(["Slow above", ms(m.slowMs)]);
    rows.push(["Every", every]);
    rows.push(["Timeout", "10 s"]);
  }
  if (m.type === "dns" && m.dns) {
    rows.push(["Record", `${m.dns.record} ${m.dns.name}`]);
    rows.push(["Expected", m.dns.expected]);
    rows.push(["Every", "10 min"]);
  }
  if (m.type === "ssl" && m.ssl) {
    rows.push(["Host", m.ssl.host]);
    if (m.auto) rows.push(["Added", "automatically, for a host you monitor over HTTPS"]);
  }
  if (m.hb) {
    rows.push(["Schedule", <span key="s"><code className="code">{m.hb.schedule}</code> {m.hb.tz}</span>]);
    rows.push(["Grace", `${m.hb.graceMin} min`]);
    rows.push(["Max run time", `${m.hb.maxRunMin} min`]);
  }
  return (
    <section className="panel panel-tight stack" aria-labelledby="cfg">
      <h2 id="cfg" className="t-section">Settings</h2>
      {rows.length > 0 && (
        <dl className="kv">
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** The ping URL, any time (owner's decision, 2026-10-22). The page opens its sealed copy on the
 *  server and passes it in; the snapshot every screen shares never holds it. Making a new one
 *  retires the old at once. */
function PingUrl({ s, m, pingUrl }: { s: Workspace; m: Monitor; pingUrl: string | null }) {
  const acts = useActs();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = fresh ?? pingUrl;
  const write = s.can["monitors:write"];

  async function rotate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await acts.rotateHeartbeat(m.id);
    setBusy(false);
    setConfirming(false);
    if (!r.ok) setError(r.reason);
    else setFresh(r.heartbeatUrl);
  }

  return (
    <section className="panel stack" aria-labelledby="ping">
      <h2 id="ping" className="t-section">Ping URL</h2>
      {url ? (
        <HeartbeatUrl url={url} field={m.assertions?.[0]?.path} onPage />
      ) : (
        <p className="t-2">{write ? "Staygreen has no copy of this URL to show. Make a new URL to see it here, then put it in your job." : "Only the workspace's admins can see the ping URL."}</p>
      )}
      {write &&
        (confirming ? (
          <div className="callout callout-warn stack-sm" role="group" aria-label="Make a new ping URL">
            <span>The old URL stops working at once, so the job reports missed until you update it.</span>
            <div className="cluster">
              <button type="button" className="btn btn-sm btn-danger" onClick={rotate} disabled={busy} aria-busy={busy}>{busy ? "Making…" : "Make a new URL"}</button>
              <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)} disabled={busy}>Keep the old one</button>
            </div>
          </div>
        ) : (
          <div><button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}><KeyRound aria-hidden="true" />Make a new URL</button></div>
        ))}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}

/** Why a ping's fields are missing, when they are (the receiver's note, `ingest/`). */
const NOTE: Record<string, string> = {
  not_json: "Its body wasn't a JSON object, so it carried no fields.",
  too_large: "Its body was over 8 KB, so Staygreen read only its query parameters.",
  truncated: "Some fields were dropped to keep it under 1 KB.",
};

function PingBody({ p }: { p: ReceivedPing }) {
  const fields = Object.keys(p.payload).length > 0;
  return (
    <>
      {fields ? <pre className="snippet wrap">{JSON.stringify(p.payload, null, 2)}</pre> : <p className="t-meta">No fields.</p>}
      {p.note && NOTE[p.note] && <p className="t-meta">{NOTE[p.note]}</p>}
    </>
  );
}

/** What the job sent, as the receiver recorded it: the newest good ping and its payload, the
 *  newest `/fail` when it is newer, and the `/start` of a run still open. Masked by the receiver
 *  before it was stored (`ingest/`), so nothing here is a secret. This page's own read
 *  (`heartbeatLatestOf`), never the snapshot's. */
function Received({ s, m, latest }: { s: Workspace; m: Monitor; latest: HeartbeatLatest | null }) {
  const hb = m.hb!;
  const ping = latest?.ping ?? null;
  const fail = latest?.fail && (!ping || latest.fail.at > ping.at) ? latest.fail : null;
  const start = hb.runningSince !== null && latest?.start ? latest.start : null;
  const when = (p: ReceivedPing) => `${dayTime(p.at, s.now)} ${zone(p.at)}, ${ago(p.at, s.now)}`;
  return (
    <section className="panel stack" aria-labelledby="received">
      <div className="panel-head">
        <h2 id="received" className="t-section">Last ping</h2>
        <span className="t-meta">The newest of each kind, masked when it arrived</span>
      </div>
      {!ping && !fail && !start ? (
        <p className="t-2">No ping yet. Run the job once, or call the URL above, and it shows here.</p>
      ) : (
        <div className="stack">
          {start && (
            <div className="stack-sm">
              <strong>/start, {when(start)}</strong>
              <span className="t-meta">The run is open: it is stuck if nothing finishes it within {hb.maxRunMin} min.</span>
              <PingBody p={start} />
            </div>
          )}
          {fail && (
            <div className="stack-sm">
              <strong className="t-down">/fail, {when(fail)}</strong>
              <PingBody p={fail} />
            </div>
          )}
          {ping && (
            <div className="stack-sm">
              <strong>Ping, {when(ping)}</strong>
              <PingBody p={ping} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function targetHost(m: Monitor) {
  if (m.type === "heartbeat") return "";
  return m.tcp?.host ?? m.dns?.name ?? m.ssl?.host ?? hostOf(m.target);
}

export function MonitorScreen({ id, pingUrl, history, latest }: { id: string; pingUrl: string | null; history: MonitorHistory; latest: HeartbeatLatest | null }) {
  const s = useWorkspace();
  usePoll();
  return s ? <MonitorDetail s={s} id={id} pingUrl={pingUrl} history={history} latest={latest} /> : <Loading />;
}
