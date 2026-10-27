"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Plus, X } from "lucide-react";
import { Loading, PageHead } from "@/components/Shell";
import { BuilderTag, SoonTag } from "@/components/Tags";
import { TypeIcon } from "@/components/TypeIcon";
import { AddApp } from "@/components/AddApp";
import { AppPicker } from "@/components/AppPicker";
import { Copy } from "@/components/Copy";
import { Flag } from "@/components/Flag";
import { HeartbeatUrl } from "@/components/HeartbeatUrl";
import { builderRegion, cities, list } from "@/components/landing/plan-copy";
import { StateIcon } from "@/components/State";
import { assertionKey, TestResult, testSummary } from "@/components/TestResult";
import { hostCount } from "@/lib/derive";
import { describeCron } from "@/lib/cron";
import { time } from "@/lib/format";
import { isLive, soonNote } from "@/lib/launch";
import { defaultName, DNS_INTERVAL_SEC, DNS_RECORDS, hostOf, isCreatable, OPS, parseMonitorDraft } from "@/lib/monitor-input";
import { locationIds, locations, limitsOf } from "@/lib/plans";
import type { TestOutcome } from "@/lib/test-result";
import { useActs, useAppSelection, useWorkspace, type Workspace } from "@/lib/workspace-store";
import type { Assertion, Monitor, MonitorType, Op } from "@/lib/model";
import type { Result } from "@/app/(app)/app/actions";
import { monitorDefaults } from "@/lib/monitor-defaults";
import { isService, SERVICE_KEY, STRIPE_CRITICAL, supabaseReadSql, type StripeConfig, type SupabaseConfig } from "@/lib/service-monitor";

type Opt = { type: MonitorType; label: string; hint: string };

const groups: { title: string; opts: Opt[] }[] = [
  {
    title: "Your app from the outside",
    opts: [
      { type: "http", label: "HTTP", hint: "A page or API answers, and the answer is right" },
      { type: "ssl", label: "SSL and domain", hint: "Certificate and registration expiry" },
      { type: "dns", label: "DNS record", hint: "A record still points where it should" },
      { type: "tcp", label: "TCP port", hint: "A port accepts connections, like a websocket" },
    ],
  },
  {
    title: "What runs behind it",
    opts: [
      { type: "heartbeat", label: "Heartbeat", hint: "A cron or job ran, and reported what it did" },
      { type: "stripe", label: "Stripe webhooks", hint: "Deliveries Stripe couldn't make to your app" },
      { type: "mcp", label: "MCP server", hint: "Handshake, OAuth and the tool list" },
      { type: "supabase", label: "Supabase", hint: "Auth and Storage health, and an alert if it pauses" },
    ],
  },
];

const ZONES = ["UTC", "Europe/Warsaw", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney"];

/** Field errors the form has no field for, so they need the banner instead. */
const UNPLACED = ["appId", "form", "type"];

function AddMonitor({ s }: { s: Workspace }) {
  const params = useSearchParams();
  const { app: selectedApp } = useAppSelection(s);
  const router = useRouter();
  const asked = params.get("type") as MonitorType | null;
  const [type, setType] = useState<MonitorType>(asked && groups.some((g) => g.opts.some((o) => o.type === asked)) ? asked : "http");
  // Follows the tab's app choice, which a reload restores only after the first render, until
  // the member picks one here.
  const [picked, setAppId] = useState(params.get("app"));
  const appId = picked ?? selectedApp;
  const [created, setCreated] = useState<{ id: string; url: string; name: string; field?: string } | null>(null);
  const app = s.apps.find((a) => a.id === appId) ?? s.apps[0];
  const L = limitsOf(s);
  const used = s.monitors.filter((m) => !m.auto).length;
  const full = used >= L.monitors;
  const back = { href: "/app/monitors", label: "Monitors" };

  if (!s.can["monitors:write"]) {
    return (
      <>
        <PageHead back={back} title="Add a monitor" />
        <div className="empty"><strong>Adding monitors isn&apos;t part of your role in this workspace.</strong></div>
      </>
    );
  }

  if (!app) {
    return (
      <>
        <PageHead back={back} title="Add a monitor" sub="A monitor belongs to an app. Name the app first." />
        <section className="panel stack" aria-label="Add an app">
          <AddApp autoFocus onAdded={(id) => setAppId(id)} />
        </section>
      </>
    );
  }

  if (created) {
    return (
      <>
        <PageHead back={back} title="Heartbeat added" sub={`${created.name}, part of ${app.name}.`} />
        <div className="stack">
          <HeartbeatUrl url={created.url} name={created.name} field={created.field} />
          <div className="cluster">
            <Link href={`/app/monitors/${created.id}`} className="btn btn-primary">Open the monitor</Link>
            <button type="button" className="btn" onClick={() => setCreated(null)}>Add another</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead back={back} title="Add a monitor" sub={`${used} of ${L.monitors} monitors used on ${s.plan === "builder" ? "Builder" : "Free"}.`} />
      {full && (
        <div className="callout callout-warn" style={{ marginBottom: "var(--s-5)" }}>
          <span>
            <strong>You&apos;ve used all {L.monitors} monitors.</strong> Delete one you don&apos;t need{s.plan === "free" ? <>, or <Link href="/app/billing" className="link">move to Builder</Link> for 100</> : ""}.
          </span>
        </div>
      )}
      <div className="add-layout">
        <div className="stack-lg">
          <section className="stack" aria-labelledby="pick">
            <h2 id="pick" className="t-section">What do you want to watch?</h2>
            {/* One choice of eight, so radios: one name across both groups, so the arrow keys
                move through all eight and a screen reader hears "1 of 8". A Coming soon type stays
                choosable, because choosing it shows what it will do (`docs/flows.md § First app`). */}
            <div className="type-groups">
              {groups.map((g) => (
                <fieldset key={g.title} className="type-group">
                  <legend>{g.title}</legend>
                  <div className="type-list">
                    {g.opts.map((o) => {
                      const id = `pick-${o.type}`;
                      const soon = !isCreatable(o.type);
                      return (
                        <label key={o.type} className="type-opt">
                          <span className="icon-tile"><TypeIcon type={o.type} /></span>
                          <span className="type-opt-text">
                            <span className="type-opt-name">
                              <span id={id}>{o.label}</span>
                              {soon && <span id={`${id}-soon`}><SoonTag /></span>}
                            </span>
                            <small id={`${id}-hint`}>{o.hint}</small>
                          </span>
                          <input
                            type="radio"
                            name="monitor-type"
                            value={o.type}
                            checked={type === o.type}
                            onChange={() => setType(o.type)}
                            aria-labelledby={soon ? `${id} ${id}-soon` : id}
                            aria-describedby={`${id}-hint`}
                          />
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
            </div>
          </section>

          {/* With one app there is nothing to choose, so the question would only raise another. */}
          {s.apps.length > 1 ? (
            <div className="field" style={{ maxWidth: 360 }}>
              <label className="label" htmlFor="app">Which app is it part of?</label>
              <AppPicker id="app" apps={s.apps} value={app.id} onChange={setAppId} aria-describedby="app-hint" />
              <span className="hint" id="app-hint">The overview groups monitors by app, and an app&apos;s status page can show only its own.</span>
            </div>
          ) : (
            <p className="t-2">Part of <strong>{app.name}</strong>.</p>
          )}

          {isCreatable(type) ? (
            <MonitorForm
              key={`${type}-${app.id}`}
              s={s}
              type={type}
              appId={app.id}
              appUrl={app.url}
              full={full}
              onDone={(r) => (r.heartbeatUrl ? setCreated({ id: r.id, url: r.heartbeatUrl, name: r.name, field: r.field }) : router.push(`/app/monitors/${r.id}`))}
            />
          ) : (
            <Soon type={type} />
          )}
        </div>

        <aside className="sticky-side stack">
          {type === "heartbeat" ? (
            // Nothing is checked from a location: the job calls in, so the panel says what a late call does.
            <section className="panel panel-tight stack-sm" aria-labelledby="when">
              <h2 id="when" className="t-section">When a ping doesn&apos;t come</h2>
              <ol className="steps">
                <li className="step"><span className="step-n">1</span><span>Each run has until its scheduled time plus the grace to ping.</span></li>
                <li className="step"><span className="step-n">2</span><span>No ping, a <code className="code">/fail</code> ping, or a number that fails a check opens an incident.</span></li>
                <li className="step"><span className="step-n">3</span><span>The next good ping closes it.</span></li>
              </ol>
            </section>
          ) : (
            <section className="panel panel-tight stack-sm" aria-labelledby="when">
              <h2 id="when" className="t-section">When a check fails</h2>
              <ol className="steps">
                <li className="step"><span className="step-n">1</span><span>{type === "dns"
                  ? <>The next check confirms it, {DNS_INTERVAL_SEC / 60} minutes later. Resolvers answer the same from anywhere, so a second location adds nothing.</>
                  : type === "ssl"
                    ? <>A certificate that can&apos;t be reached is re-checked from a second location within about 30 seconds. One that&apos;s expired or invalid counts at once: every location sees the same one.</>
                    : <>It&apos;s re-checked from a second location within about 30 seconds. One bad location doesn&apos;t page you.</>}</span></li>
                <li className="step"><span className="step-n">2</span><span>{type === "stripe" ? "An incident names affected event types across the account." : "If that fails too, an incident opens with the response that failed."}</span></li>
                <li className="step"><span className="step-n">3</span><span>Two passing checks in a row close it.</span></li>
              </ol>
            </section>
          )}
          {type !== "heartbeat" && <section className="panel panel-tight stack-sm" aria-labelledby="where">
            <h2 id="where" className="t-section">Checked from</h2>
            <ul className="stack-sm">
              {locationIds.map((l) => (
                <li key={l} className="spread">
                  <span className="loc-place"><Flag loc={l} /><span>{locations[l].city} <span className="t-meta">{locations[l].country}</span></span></span>
                  <span className="cluster">{!locations[l].live && <SoonTag />}{!L.locations.includes(l) && <BuilderTag offer="location" />}</span>
                </li>
              ))}
            </ul>
          </section>}
        </aside>
      </div>
    </>
  );
}

function Soon({ type }: { type: MonitorType }) {
  const label = type === "mcp" ? "MCP server monitors" : type === "supabase" ? "Supabase monitors" : "Stripe webhook monitors";
  const note =
    type === "stripe"
      ? "Reads your Stripe account's failed webhook deliveries with a restricted, read-only key, and opens an incident naming the event types that failed."
      : soonNote[type as "mcp" | "supabase"];
  return (
    <section className="panel stack" aria-labelledby="soon">
      <div className="row"><h2 id="soon" className="t-section">{label}</h2><SoonTag /></div>
      <p>{note}</p>
      <p className="t-2">
        {isLive(type)
          ? "It's being built now, and it's included in every plan."
          : "It isn't on sale yet, because we haven't finished proving it works. We'd rather tell you that than sell a screen. Your plan already includes it, so there's nothing to upgrade when it ships."}
      </p>
    </section>
  );
}

// `field` is the first number the job reports, for the example on the success screen.
type Done = { id: string; name: string; heartbeatUrl?: string; field?: string };

/** The add form, and the edit form when `editing` is the monitor being changed: its type and app stay. */
export function MonitorForm({ s, type, appId, appUrl, full, editing, onDone }: { s: Workspace; type: MonitorType; appId: string; appUrl: string; full: boolean; editing?: Monitor; onDone: (r: Done) => void }) {
  const acts = useActs();
  const L = limitsOf(s);
  const appHost = hostOf(appUrl);
  const [name, setName] = useState(editing?.name ?? "");
  const supabase = editing?.serviceConfig as SupabaseConfig | undefined;
  const stripe = editing?.serviceConfig as StripeConfig | undefined;
  const [projectUrl, setProjectUrl] = useState(supabase?.projectUrl ?? "");
  const [databaseRead, setDatabaseRead] = useState(supabase?.databaseRead ?? "");
  const [serviceKey, setServiceKey] = useState("");
  const [endpoints, setEndpoints] = useState(stripe?.endpoints?.join("\n") ?? "");
  const [critical, setCritical] = useState((stripe?.critical ?? STRIPE_CRITICAL).join("\n"));
  const [failureThreshold, setFailureThreshold] = useState(stripe?.failureThreshold ?? 3);
  const [windowMin, setWindowMin] = useState(stripe?.windowMin ?? 30);
  const [pendingMin, setPendingMin] = useState(stripe?.pendingMin ?? 30);
  // The app's address as the builder typed it. A path nobody has seen answer is never filled in as
  // if it were theirs; a pasted address will propose `/api/health` only once it has answered.
  const [url, setUrl] = useState(editing ? (type === "http" ? editing.target : "") : type === "http" && appUrl ? appUrl : "");
  const [method, setMethod] = useState<"GET" | "HEAD" | "POST">(editing?.method ?? "GET");
  const [expect, setExpect] = useState(editing?.expect ?? "2xx");
  const [keyword, setKeyword] = useState(editing?.keyword ?? "");
  const [slowMs, setSlowMs] = useState(editing?.slowMs ?? (type === "tcp" ? monitorDefaults.slowMs.tcp : monitorDefaults.slowMs.http));
  // None to begin with: an example saved as a real assertion fails every app whose answer lacks it.
  // The examples are the inputs' placeholders.
  const [asserts, setAsserts] = useState<Assertion[]>(editing?.assertions ?? []);
  // A stored header's value never comes back to the screen. Left empty, it keeps the stored one.
  const [headers, setHeaders] = useState<{ k: string; v: string; stored?: boolean }[]>(() => (editing?.secretHeaders ?? []).map((k) => ({ k, v: "", stored: true })));
  // The certificate of the app's own host; a TCP port is something only the builder knows.
  const [host, setHost] = useState(editing ? (editing.ssl?.host ?? editing.tcp?.host ?? "") : type === "ssl" ? appHost : "");
  const [port, setPort] = useState<number | "">(editing?.tcp?.port ?? "");
  const [tls, setTls] = useState(editing?.tcp?.tls ?? false);
  // The app's own domain, which answers with an A record (a CNAME can't sit on a bare domain).
  const [record, setRecord] = useState<NonNullable<Monitor["dns"]>["record"]>(editing?.dns?.record ?? "A");
  const [dnsName, setDnsName] = useState(editing ? (editing.dns?.name ?? "") : appHost);
  const [dnsExpected, setDnsExpected] = useState(editing?.dns?.expected ?? "");
  const [cron, setCron] = useState(editing?.hb?.schedule ?? "");
  // UTC, not the browser's zone (`monitorDefaults`).
  const [tz, setTz] = useState(editing?.hb?.tz ?? monitorDefaults.tz);
  const [grace, setGrace] = useState(editing?.hb?.graceMin ?? monitorDefaults.graceMin);
  const [maxRun, setMaxRun] = useState(editing?.hb?.maxRunMin ?? monitorDefaults.maxRunMin);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  // The test before saving (`docs/flows.md § Testing a monitor`). `key` is the draft it ran on, so
  // the screen knows when the form has moved on, and `seenAt` is this browser's clock.
  // Which press is waiting on a test: Test's, or a save's when the pass it follows has gone stale.
  const [testing, setTesting] = useState<"test" | "save" | null>(null);
  const [tested, setTested] = useState<{ key: string; outcome: TestOutcome; seenAt: number } | null>(null);
  const [notTested, setNotTested] = useState<{ reason: string; retryAt?: number } | null>(null);
  // The draft whose test didn't pass or couldn't run, so it may be saved as it is.
  const [anywayKey, setAnywayKey] = useState<string | null>(null);
  const [said, setSaid] = useState("");

  const testable = type === "http" || type === "ssl" || type === "dns" || type === "tcp" || isService(type);
  const assertLimit = type === "heartbeat" ? L.heartbeatAssertions : L.assertions;
  const hbUsed = s.monitors.filter((m) => m.type === "heartbeat").length;
  const hbFull = !editing && type === "heartbeat" && hbUsed >= L.heartbeats;
  const sslCovered = type === "ssl" && host ? s.monitors.find((m) => m.type === "ssl" && m.ssl?.host === host && m.id !== editing?.id) : undefined;
  const perHost = typeof L.perHost === "number" ? L.perHost : null;
  const urlHost = type === "http" ? hostOf(url) : "";
  // Editing, the monitor itself is already counted on its own host.
  const onHost = urlHost ? hostCount(s, urlHost) - (editing && hostOf(editing.target) === urlHost ? 1 : 0) : 0;

  function draft() {
    const a = asserts.map((x) => ({ path: x.path, op: x.op, value: x.value }));
    switch (type) {
      case "supabase": return { type, appId, name, projectUrl, databaseRead, key: serviceKey };
      case "stripe": return { type, appId, name, key: serviceKey, endpoints: endpoints.split(/[\s,]+/).filter(Boolean),
        critical: critical.split(/[\s,]+/).filter(Boolean), failureThreshold, windowMin, pendingMin };
      case "http":
        return { type, appId, name, url, method, expect, keyword, slowMs, assertions: a, headers: headers.filter((h) => h.k || h.v).map((h) => ({ name: h.k, value: h.v })) };
      case "ssl":
        return { type, appId, name, host };
      case "tcp":
        // An empty port goes as 0, so the server's sentence ("Ports run from 1 to 65535") names it.
        return { type, appId, name, host, port: port === "" ? 0 : port, tls, slowMs };
      case "dns":
        return { type, appId, name, record, recordName: dnsName, expected: dnsExpected };
      default:
        return { type, appId, name, schedule: cron, tz, graceMin: grace, maxRunMin: maxRun, assertions: a };
    }
  }

  /** The draft, or null after naming its mistakes beside their fields. The server runs the same
   *  parser; this pass only saves a round trip. */
  function checked() {
    const d = draft();
    const local = parseMonitorDraft(d, { storedHeaders: editing?.hasServiceKey ? [SERVICE_KEY] : editing?.secretHeaders });
    if (!local.ok) {
      setFieldErr(local.fieldErrors);
      setSaid("Check the highlighted fields.");
      return null;
    }
    setFieldErr({});
    return { d, row: local.row };
  }

  /** One test of `d`: what it found, or why it didn't run. */
  async function test(d: ReturnType<typeof draft>, by: "test" | "save"): Promise<"passed" | "failed" | "not run" | "invalid"> {
    setTesting(by);
    setNotTested(null);
    setSaid("Testing…");
    const r = await acts.testMonitor(d, editing?.id ?? null);
    setTesting(null);
    if (!r.ok) {
      const fe = r.fieldErrors ?? {};
      setSaid(r.reason);
      if (Object.keys(fe).length) {
        setFieldErr(fe);
        if (Object.keys(fe).some((k) => UNPLACED.includes(k))) setError(r.reason);
        return "invalid";
      }
      setNotTested({ reason: r.reason, retryAt: r.retryAfterSec ? Date.now() + r.retryAfterSec * 1000 : undefined });
      return "not run";
    }
    setTested({ key: JSON.stringify(d), outcome: r.outcome, seenAt: Date.now() });
    // A pass ends any "anyway" an earlier test of this draft offered: it saves as the pass it is.
    if (r.outcome.ok || "service" in r.outcome && r.outcome.service.saveable) setAnywayKey(null);
    setSaid(testSummary(r.outcome));
    return r.outcome.ok || "service" in r.outcome && r.outcome.service.saveable ? "passed" : "failed";
  }

  async function runTest() {
    if (busy || testing) return;
    setError(null);
    const c = checked();
    if (!c) return;
    const t = await test(c.d, "test");
    // A monitor for something that is down right now is a fair monitor, so a draft that didn't
    // pass may still be saved as it is.
    if (!isService(type) && (t === "failed" || t === "not run")) {
      setAnywayKey(JSON.stringify(c.d));
      setSaid((x) => `${x} ${editing ? "Save anyway" : "Add anyway"} saves it as it is.`);
    }
  }

  /** A value of the tested body, chosen: its assertion is added, or taken off when it is there. */
  function pick(path: string, op: Op, value: string) {
    const key = assertionKey(path, op, value);
    const there = asserts.find((a) => assertionKey(a.path, a.op, a.value) === key);
    const written = `${path} ${op}${op === "exists" ? "" : ` ${value}`}`;
    if (there) {
      setAsserts((x) => x.filter((y) => y.id !== there.id));
      setSaid(`Took off ${written}.`);
    } else if (asserts.length < assertLimit) {
      setAsserts((x) => [...x, { id: `a${x.length + 1}-${Date.now()}`, path, op, value }]);
      setSaid(`Added ${written} to the assertions.`);
    }
  }

  async function save() {
    if (busy || testing) return;
    setError(null);
    const c = checked();
    if (!c) return;
    const { d, row } = c;
    // Save is offered after a pass of this exact draft, or as "anyway" after a test that didn't
    // pass. A pass older than two minutes is tested again; anything but a pass then shows what it
    // found and leaves the choice to the builder.
    const key = JSON.stringify(d);
    if (testable && anywayKey !== key) {
      const fresh = tested && tested.key === key && (tested.outcome.ok || "service" in tested.outcome && tested.outcome.service.saveable) && Date.now() - tested.seenAt < 120_000;
      if (!fresh) {
        const t = await test(d, "save");
        if (t === "invalid") return;
        if (t !== "passed") {
          if (isService(type)) return;
          setAnywayKey(key);
          setSaid((x) => `${x} Nothing is saved yet. Press ${editing ? "Save anyway" : "Add anyway"} to save it as it is.`);
          return;
        }
      }
    }
    setBusy(true);
    const r: Result<{ id?: string; heartbeatUrl?: string }> = editing ? await acts.updateMonitor(editing.id, d) : await acts.addMonitor(d);
    setBusy(false);
    if (!r.ok) {
      const fe = r.fieldErrors ?? {};
      setFieldErr(fe);
      const keys = Object.keys(fe);
      if (!keys.length || keys.some((k) => UNPLACED.includes(k))) setError(r.reason);
      return;
    }
    onDone({ id: editing?.id ?? r.id!, name: row.name, heartbeatUrl: r.heartbeatUrl, field: d.type === "heartbeat" ? d.assertions[0]?.path.trim() : undefined });
  }

  const currentKey = testable ? JSON.stringify(draft()) : "";
  const anyway = testable && anywayKey === currentKey;
  // Test comes first: the form's main button tests until this exact draft has passed, and only
  // then saves. Enter presses the main button.
  const passed = testable && tested?.key === currentKey && (tested.outcome.ok || "service" in tested.outcome && tested.outcome.service.saveable);
  const testsFirst = testable && !passed;
  const blocked = (!editing && full) || hbFull || !!sslCovered || busy || !!testing;
  const saveWord = editing ? (anyway ? "Save anyway" : "Save changes") : anyway ? "Add anyway" : "Add monitor";

  function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (testsFirst) void runTest();
    else void save();
  }

  const err = (k: string) => fieldErr[k] && <span className="error" id={`${k}-err`}>{fieldErr[k]}</span>;
  const aria = (k: string) => (fieldErr[k] ? { "aria-invalid": true, "aria-describedby": `${k}-err` } : {});
  // Supabase's key sits under its project URL, because both are copied from the same place in
  // Supabase's dashboard (owner, 2026-10-26).
  const keyField = (
    <div className="field span-all">
      <label className="label" htmlFor="serviceKey">{type === "stripe" ? "Restricted Stripe key" : "Publishable key"}</label>
      <input id="serviceKey" className="input mono" type="password" autoComplete="off" value={serviceKey} onChange={e => setServiceKey(e.target.value)} placeholder={editing?.hasServiceKey ? "Stored; leave empty to keep" : type === "stripe" ? "rk_test_… or rk_live_…" : "sb_publishable_…"} {...aria("key")} />
      {err("key") || <span className="hint">Stored encrypted and never shown again. {editing?.hasServiceKey && "Leave empty to keep it."}</span>}
    </div>
  );
  const readSql = supabaseReadSql(databaseRead);

  return (
    <form className="stack-lg" onSubmit={submit} noValidate>
      {type === "heartbeat" && !editing && (
        <section className="panel stack" aria-labelledby="hb-how">
          <h2 id="hb-how" className="t-section">How a heartbeat works</h2>
          <p className="t-2">An HTTP monitor calls your app. A heartbeat is the other way round: your job calls Staygreen when it finishes. So there&apos;s no address to type here. Staygreen gives you one.</p>
          <ol className="steps">
            <li className="step"><span className="step-n">1</span><span>Say when the job runs, below, and add the heartbeat.</span></li>
            <li className="step"><span className="step-n">2</span><span>Copy the ping URL you get.</span></li>
            <li className="step"><span className="step-n">3</span><span>Call it as the job&apos;s last step. You get the line to paste for cron, Vercel, GitHub Actions, Supabase and Python.</span></li>
          </ol>
        </section>
      )}
      <section className="panel stack" aria-labelledby="what">
        <h2 id="what" className="t-section">{heading[type]}</h2>
        <div className="form-grid">
          {isService(type) && <>
            {type === "supabase" && <>
              <div className="field span-all">
                <label className="label" htmlFor="projectUrl">Project URL</label>
                <input id="projectUrl" className="input mono" type="url" value={projectUrl} onChange={e => setProjectUrl(e.target.value)} placeholder="https://abcdefghijklmnopqrst.supabase.co" {...aria("projectUrl")} />{err("projectUrl")}
              </div>
              {keyField}
              <div className="field span-all">
                <label className="label" htmlFor="databaseRead">Database read <span className="t-3">(optional)</span></label>
                <input id="databaseRead" className="input mono" value={databaseRead} onChange={e => setDatabaseRead(e.target.value)} placeholder="staygreen_health" {...aria("databaseRead")} />
                {err("databaseRead") || <span className="hint">A table or view readable by anon, or rpc/function_name for a read-only function with no arguments.</span>}
                <p className="t-2">Without this read, Auth and Storage checks do not touch your database and do not keep a Free project awake. Staygreen cannot see your project&apos;s plan.</p>
                {/* An rpc/ read names a function the builder already has, so no view is offered for it. */}
                {!databaseRead.trim().startsWith("rpc/") && (
                  <details>
                    <summary>SQL for a one-row health view</summary>
                    <div className="snippet-copy"><pre className="snippet wrap">{readSql}</pre><Copy text={readSql} label="Copy SQL" icon /></div>
                  </details>
                )}
              </div>
            </>}
            {type === "stripe" && <>
              {keyField}
              <p className="t-2 span-all">Grant read access to Events and Webhook Endpoints only. Testing checks that Customers access is denied; it cannot attest every permission. Each monitor uses one account connection.</p>
              <div className="field span-all"><label className="label" htmlFor="endpoints">Webhook endpoint IDs</label>
                <textarea id="endpoints" className="textarea mono" value={endpoints} onChange={e => setEndpoints(e.target.value)} placeholder="we_…" {...aria("endpoints")} />{err("endpoints")}
                <span className="hint">One ID per line, copied from Stripe. These endpoints are checked for enabled or disabled status. Delivery failures cover the entire account; Stripe does not identify which endpoint failed.</span></div>
              <div className="field span-all"><label className="label" htmlFor="critical">Critical event types</label>
                <textarea id="critical" className="textarea mono" value={critical} onChange={e => setCritical(e.target.value)} {...aria("critical")} />{err("critical")}
                <span className="hint">One per line; .* matches a group. One affected critical event opens an incident after confirmation.</span></div>
              <div className="field"><label className="label" htmlFor="failureThreshold">Failure threshold</label><input id="failureThreshold" className="input" type="number" min={1} max={100} value={failureThreshold} onChange={e => setFailureThreshold(Number(e.target.value))} {...aria("failureThreshold")} />{err("failureThreshold")}</div>
              <div className="field"><label className="label" htmlFor="windowMin">Failure window, minutes</label><input id="windowMin" className="input" type="number" min={1} max={1440} value={windowMin} onChange={e => setWindowMin(Number(e.target.value))} {...aria("windowMin")} />{err("windowMin")}</div>
              <div className="field"><label className="label" htmlFor="pendingMin">Pending longer than, minutes</label><input id="pendingMin" className="input" type="number" min={1} max={1440} value={pendingMin} onChange={e => setPendingMin(Number(e.target.value))} {...aria("pendingMin")} />{err("pendingMin")}</div>
            </>}
          </>}
          {type === "http" && (
            <>
              <div className="field span-all">
                <label className="label" htmlFor="url">Address</label>
                {/* An address or a host name is not code, so it is set in Switzer, as are the host
                    names below; mono stays for JSONPath, cron lines, headers and DNS answers
                    (`design/README.md § Type`). */}
                <input id="url" className="input" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" spellCheck={false} placeholder="https://example.com/api/health" {...aria("url")} />
                {err("url") ||
                  (perHost && onHost >= perHost - 1 ? (
                    <span className="hint">{urlHost} has {onHost} of the {perHost} monitors Free allows per host.</span>
                  ) : (
                    <span className="hint">A health endpoint that touches your database catches more than your home page.</span>
                  ))}
              </div>
              <div className="field">
                <span className="label" id="m-l">Method</span>
                <div className="seg" role="radiogroup" aria-labelledby="m-l">
                  {(["GET", "HEAD", "POST"] as const).map((m) => (
                    <label key={m}><input type="radio" name="method" checked={method === m} onChange={() => setMethod(m)} /><span>{m}</span></label>
                  ))}
                </div>
              </div>
              <div className="field">
                <label className="label" htmlFor="expect">Expected status</label>
                <input id="expect" className="input" value={expect} onChange={(e) => setExpect(e.target.value)} {...aria("expect")} />
                {err("expect") || <span className="hint">2xx, or a code like 200 or 301</span>}
              </div>
              <div className="field">
                <label className="label" htmlFor="slow">Slow above, ms</label>
                <input id="slow" className="input num" type="number" min={100} max={60000} step={100} value={slowMs} onChange={(e) => setSlowMs(Number(e.target.value))} {...aria("slowMs")} />
                {err("slowMs") || <span className="hint">3 slow checks in a row is a warning, not an outage</span>}
              </div>
              <div className="field span-all">
                <label className="label" htmlFor="kw">Body contains <span className="t-3">(optional)</span></label>
                <input id="kw" className="input" value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="Sign in" {...aria("keyword")} />
                {err("keyword")}
              </div>
            </>
          )}

          {(type === "ssl" || type === "tcp") && (
            <div className="field">
              <label className="label" htmlFor="host">Hostname</label>
              <input id="host" className="input" value={host} onChange={(e) => setHost(e.target.value.trim())} spellCheck={false} placeholder="api.example.com" {...aria("host")} />
              {err("host") || (type === "ssl" && <span className="hint">Every host you monitor over HTTPS gets this automatically.</span>)}
            </div>
          )}
          {type === "tcp" && (
            <>
              <div className="field">
                <label className="label" htmlFor="port">Port</label>
                <input id="port" className="input num" type="number" min={1} max={65535} value={port} placeholder="5432" onChange={(e) => setPort(e.target.value === "" ? "" : Number(e.target.value))} {...aria("port")} />
                {err("port")}
              </div>
              <div className="field">
                <label className="label" htmlFor="slow">Slow above, ms</label>
                <input id="slow" className="input num" type="number" min={100} max={60000} step={100} value={slowMs} onChange={(e) => setSlowMs(Number(e.target.value))} {...aria("slowMs")} />
                {err("slowMs") || <span className="hint">3 slow connections in a row is a warning, not an outage</span>}
              </div>
              <label className="check span-all">
                <input type="checkbox" checked={tls} onChange={(e) => setTls(e.target.checked)} />
                <span>Complete a TLS handshake, not just the connection</span>
              </label>
            </>
          )}

          {type === "dns" && (
            <>
              <div className="field">
                <label className="label" htmlFor="rec">Record</label>
                <select id="rec" className="select" value={record} onChange={(e) => setRecord(e.target.value as typeof record)}>
                  {DNS_RECORDS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="dn">Name</label>
                <input id="dn" className="input" value={dnsName} onChange={(e) => setDnsName(e.target.value.trim())} spellCheck={false} placeholder="www.example.com" {...aria("dnsName")} />
                {err("dnsName")}
              </div>
              <div className="field span-all">
                <label className="label" htmlFor="dx">It should be</label>
                <input id="dx" className="input mono" value={dnsExpected} onChange={(e) => setDnsExpected(e.target.value)} spellCheck={false} placeholder={record === "NS" ? "ns1.example.com, ns2.example.com" : record === "CNAME" ? "cname.vercel-dns.com" : record === "MX" ? "10 mx.example.com" : "76.76.21.21"} {...aria("dnsExpected")} />
                {record === "NS" && <span className="hint">Enter every nameserver, separated by commas or spaces. A missing or added server counts as a change; order does not.</span>}
                {err("dnsExpected") || <span className="hint">Asked of Cloudflare and Google every 10 minutes. Both must agree before it counts as a change.</span>}
              </div>
            </>
          )}

          {type === "heartbeat" && (
            <>
              <div className="field">
                <label className="label" htmlFor="cron">Schedule</label>
                <input id="cron" className="input mono" value={cron} onChange={(e) => setCron(e.target.value)} spellCheck={false} placeholder="0 6 * * *" {...aria("cron")} />
                {err("cron") || <span className="hint">{cron.trim() ? `${describeCron(cron).label}${describeCron(cron).valid ? ". The cron line your job already runs on." : ""}` : "The cron line your job already runs on."}</span>}
              </div>
              <div className="field">
                <label className="label" htmlFor="tz">Time zone</label>
                <select id="tz" className="select" value={tz} onChange={(e) => setTz(e.target.value)}>
                  {ZONES.map((z) => <option key={z}>{z}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="grace">Grace, minutes</label>
                <input id="grace" className="input num" type="number" min={1} max={1440} value={grace} onChange={(e) => setGrace(Number(e.target.value))} {...aria("grace")} />
                {err("grace") || <span className="hint">How late a ping can be before it counts as missed</span>}
              </div>
              <div className="field">
                <label className="label" htmlFor="maxrun">Max run time, minutes</label>
                <input id="maxrun" className="input num" type="number" min={1} max={1440} value={maxRun} onChange={(e) => setMaxRun(Number(e.target.value))} {...aria("maxRun")} />
                {err("maxRun") || <span className="hint">From a /start ping to the finish ping</span>}
              </div>
            </>
          )}

          <div className="field span-all">
            <label className="label" htmlFor="name">Name <span className="t-3">(optional)</span></label>
            <input id="name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={placeholderName(type, { url, host, port, dnsName, record })} {...aria("name")} />
            {err("name") || <span className="hint">This is what alerts and your status page call it.</span>}
          </div>
        </div>
        {sslCovered && <p className="callout callout-info">{host} is already watched by {sslCovered.name}{sslCovered.auto ? ", added with your HTTP monitor" : ""}.</p>}
        {hbFull && (
          <p className="callout callout-warn">
            <span>You&apos;ve used all {L.heartbeats} heartbeats{s.plan === "free" ? <>. <Link href="/app/billing" className="link">Builder</Link> has 50</> : ""}.</span>
          </p>
        )}
      </section>

      {(type === "http" || type === "heartbeat") && (
        <section className="panel stack" aria-labelledby="asserts">
          <div className="section-head">
            <h2 id="asserts" className="t-section">{type === "http" ? "Check the answer, not just the status" : "Check what the job reports"}</h2>
            <span className="t-meta num">{asserts.length} of {assertLimit}</span>
          </div>
          <p className="t-2">
            {type === "http"
              ? "A 200 that says the database is down is still an outage. Assertions read the JSON body and fail the check when a value is wrong."
              : "Send numbers with the ping, like emails_sent or rows_processed. A job that ran and did nothing fails here."}
          </p>
          {asserts.map((a, i) => (
            <div key={a.id} className="assert-edit">
              <input className="input mono" aria-label={`Assertion ${i + 1} path`} value={a.path} placeholder={type === "http" ? "$.status" : "emails_sent"} onChange={(e) => setAsserts((x) => x.map((y) => (y.id === a.id ? { ...y, path: e.target.value } : y)))} />
              <select className="select" aria-label={`Assertion ${i + 1} comparison`} value={a.op} onChange={(e) => setAsserts((x) => x.map((y) => (y.id === a.id ? { ...y, op: e.target.value as Assertion["op"] } : y)))}>
                {OPS.map((o) => <option key={o}>{o}</option>)}
              </select>
              <input className="input mono" aria-label={`Assertion ${i + 1} value`} value={a.value} placeholder={a.op === "exists" ? undefined : type === "http" ? "ok" : "0"} disabled={a.op === "exists"} onChange={(e) => setAsserts((x) => x.map((y) => (y.id === a.id ? { ...y, value: e.target.value } : y)))} />
              <span />
              <button type="button" className="btn btn-quiet btn-icon" aria-label={`Remove assertion ${i + 1}`} onClick={() => setAsserts((x) => x.filter((y) => y.id !== a.id))}><X aria-hidden="true" /></button>
            </div>
          ))}
          {err("asserts")}
          <div className="cluster">
            {asserts.length >= assertLimit && s.plan === "free" ? (
              // Free's number is Builder's to raise: the button stays, with the mark.
              <BuilderTag offer={type === "http" ? "assertions" : "heartbeatAssertions"} control="btn btn-sm">Add assertion</BuilderTag>
            ) : (
              <button type="button" className="btn btn-sm" disabled={asserts.length >= assertLimit} onClick={() => setAsserts((x) => [...x, { id: `a${x.length + 1}-${Date.now()}`, path: "", op: "==", value: "" }])}>
                <Plus aria-hidden="true" />Add assertion
              </button>
            )}
          </div>
        </section>
      )}

      {type === "http" && (
        <section className="panel stack" aria-labelledby="hdrs">
          <h2 id="hdrs" className="t-section">Secret headers <span className="t-3">(optional)</span></h2>
          <p className="t-2">For endpoints behind a token. Values are stored encrypted and never shown again, in the dashboard, alerts or the API.{headers.some((h) => h.stored) && " Leave a stored value empty to keep it."}</p>
          {headers.map((h, i) => (
            <div key={i} className="row">
              <input className="input mono grow" aria-label={`Header ${i + 1} name`} placeholder="Authorization" value={h.k} readOnly={h.stored} onChange={(ev) => setHeaders((x) => x.map((y, j) => (j === i ? { ...y, k: ev.target.value } : y)))} />
              <input className="input mono grow" type="password" autoComplete="off" aria-label={`Header ${i + 1} value`} placeholder={h.stored ? "Stored, unchanged" : "Bearer …"} value={h.v} onChange={(ev) => setHeaders((x) => x.map((y, j) => (j === i ? { ...y, v: ev.target.value } : y)))} />
              <button type="button" className="btn btn-quiet btn-icon" aria-label={`Remove header ${i + 1}`} onClick={() => setHeaders((x) => x.filter((_, j) => j !== i))}><X aria-hidden="true" /></button>
            </div>
          ))}
          {err("headers")}
          <div><button type="button" className="btn btn-sm" disabled={headers.length >= 10} onClick={() => setHeaders((x) => [...x, { k: "", v: "" }])}><Plus aria-hidden="true" />Add header</button></div>
        </section>
      )}

      {type === "heartbeat" && !editing && <VercelImport s={s} appId={appId} tz={tz} grace={grace} maxRun={maxRun} />}

      {testable && (
        <section className="panel stack" aria-labelledby="try">
          <h2 id="try" className="t-section">Try it before you save</h2>
          {!tested && !notTested && (
            <p className="t-2">
              {type === "http" ? "Test sends the request once, now, and shows what came back: the status, the headers and the body, which you can build assertions from." : "Test runs the check once, now, and shows what came back."} {isService(type) ? "Saving verifies the configuration again. Invalid keys or refused reads cannot be saved." : "Nothing is saved until it passes, or until you choose to save it as it is."}
            </p>
          )}
          {notTested && (
            <div className="callout callout-warn">
              <span>{notTested.reason}{notTested.retryAt ? ` You can test again at ${time(notTested.retryAt)}.` : ""}</span>
            </div>
          )}
          {tested && (
            <TestResult
              outcome={tested.outcome}
              from={list(cities(L.locations.filter((l) => locations[l].live)), "or")}
              stale={tested.key !== currentKey}
              tree={type === "http" ? { onPick: pick, picked: new Set(asserts.map((a) => assertionKey(a.path, a.op, a.value))), full: asserts.length >= assertLimit } : undefined}
            />
          )}
        </section>
      )}
      <p className="sr-only" role="status">{said}</p>

      <p className="t-meta">
        {type === "heartbeat"
          ? "Missed by more than the grace time, and it opens an incident."
          : type === "dns"
            ? "Checked every 10 minutes."
            : type === "stripe" ? `Polled every ${L.stripePollMin} minutes. Recovers after two polls with no new failures and pending deliveries drained.`
            : type === "ssl"
              ? "Checked every 6 hours. Reminders at 21, 7 and 1 days."
              : <>Every {L.httpIntervalMin === 1 ? "minute" : `${L.httpIntervalMin} minutes`} from {list(cities(L.locations.filter((l) => locations[l].live)))}.{s.plan === "free" && <> Every minute, and a third location in {builderRegion}{!isLive("frankfurt") && <> <SoonTag /></>}, with <Link href="/app/billing" className="link">Builder</Link>.</>}</>}
      </p>

      {error && (
        <div className="callout callout-down" role="alert">
          <span>
            <strong>{error}</strong>{" "}
            {s.plan === "free" && /plan|Free/.test(error) && <Link href="/app/billing" className="link">See Builder</Link>}
          </span>
        </div>
      )}

      {anyway && (
        <div className="callout callout-warn">
          <span>
            {notTested ? "It couldn't be tested, so nothing is saved yet." : "The test didn't pass, so nothing is saved yet."} You can {editing ? "save" : "add"} it as it is: a monitor for something that&apos;s down right now is a fair monitor.
          </span>
        </div>
      )}

      <div className="cluster">
        {testsFirst ? (
          <>
            <button type="submit" className="btn btn-primary" disabled={blocked} aria-busy={testing === "test"}>
              {testing === "test" ? <><Loader2 className="spin" aria-hidden="true" />Testing…</> : anyway ? "Test again" : "Test"}
            </button>
            {anyway && (
              <button type="button" className="btn" onClick={save} disabled={blocked} aria-busy={busy}>
                {busy ? (editing ? "Saving…" : "Adding…") : saveWord}
              </button>
            )}
          </>
        ) : (
          <>
            <button type="submit" className="btn btn-primary" disabled={blocked} aria-busy={busy || testing === "save"}>
              {busy ? (editing ? "Saving…" : "Adding…") : testing === "save" ? <><Loader2 className="spin" aria-hidden="true" />Testing…</> : saveWord}
            </button>
            {testable && (
              <button type="button" className="btn" onClick={runTest} disabled={blocked} aria-busy={testing === "test"}>
                {testing === "test" ? <><Loader2 className="spin" aria-hidden="true" />Testing…</> : "Test again"}
              </button>
            )}
          </>
        )}
        <Link href={editing ? `/app/monitors/${editing.id}` : "/app/monitors"} className="btn">Cancel</Link>
        {passed && tested && (
          <span className="row tr-mark t-2">
            <StateIcon state={!tested.outcome.ok ? "down" : tested.outcome.slow ? "degraded" : "up"} size={16} />
            <span>{testSummary(tested.outcome)}</span>
          </span>
        )}
      </div>
    </form>
  );
}

function VercelImport({ s, appId, tz, grace, maxRun }: { s: Workspace; appId: string; tz: string; grace: number; maxRun: number }) {
  const acts = useActs();
  const [text, setText] = useState("");
  const [found, setFound] = useState<{ path: string; schedule: string; on: boolean }[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [urls, setUrls] = useState<{ name: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const L = limitsOf(s);
  const used = s.monitors.filter((m) => m.type === "heartbeat").length;
  const picked = found?.filter((f) => f.on) ?? [];

  function parse() {
    setMsg(null);
    try {
      const j = JSON.parse(text);
      const crons = Array.isArray(j?.crons) ? j.crons.filter((c: { path?: unknown; schedule?: unknown }) => typeof c?.path === "string" && typeof c?.schedule === "string") : [];
      if (!crons.length) {
        setFound(null);
        setMsg('No crons found. vercel.json lists them under "crons", each with a path and a schedule.');
        return;
      }
      setFound(crons.slice(0, 50).map((c: { path: string; schedule: string }) => ({ path: c.path, schedule: c.schedule, on: true })));
    } catch {
      setFound(null);
      setMsg("That isn't valid JSON. Paste the whole vercel.json file.");
    }
  }

  // One at a time, so a refusal (a bad schedule, the heartbeat limit) stops the run where it happened.
  async function addAll() {
    if (busy || !picked.length) return;
    setBusy(true);
    setMsg(null);
    const made: { name: string; url: string }[] = [];
    for (const f of picked) {
      const name = defaultName(`https://x${f.path}`);
      const r = await acts.addMonitor({ type: "heartbeat", appId, name, schedule: f.schedule, tz, graceMin: grace, maxRunMin: maxRun, assertions: [] });
      if (!r.ok) {
        setMsg(`Added ${made.length} of ${picked.length}. ${f.path}: ${r.fieldErrors?.cron ?? r.reason}`);
        break;
      }
      if (r.heartbeatUrl) made.push({ name, url: r.heartbeatUrl });
    }
    setBusy(false);
    setUrls((u) => [...u, ...made]);
    if (made.length === picked.length) {
      setFound(null);
      setText("");
      setMsg(`Added ${made.length} heartbeat${made.length === 1 ? "" : "s"}. Copy each ping URL into its job; each monitor's page shows it again.`);
    }
  }

  return (
    <section className="panel stack" aria-labelledby="vercel">
      <h2 id="vercel" className="t-section">Or import your Vercel crons</h2>
      <p className="t-2">Paste vercel.json and get one heartbeat per cron, with the schedule already set. {used} of {L.heartbeats} heartbeats used.</p>
      <textarea className="textarea mono" rows={4} aria-label="vercel.json" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{\n  "crons": [{ "path": "/api/cron/digest", "schedule": "0 6 * * *" }]\n}'} />
      <div><button type="button" className="btn btn-sm" onClick={parse} disabled={!text.trim()}>Find crons</button></div>
      {found && (
        <div className="stack-sm">
          {found.map((f, i) => (
            <label key={`${f.path}-${i}`} className="check">
              <input type="checkbox" checked={f.on} onChange={(e) => setFound((x) => x!.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)))} />
              <span><code className="code">{f.path}</code> <span className="t-meta">{describeCron(f.schedule).label}</span></span>
            </label>
          ))}
          <div>
            <button type="button" className="btn btn-sm btn-primary" onClick={addAll} disabled={busy || !picked.length} aria-busy={busy}>
              {busy ? "Adding…" : `Add ${picked.length} heartbeat${picked.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}
      {msg && <p className="t-2" role="status">{msg}</p>}
      {urls.map((u) => <HeartbeatUrl key={u.url} url={u.url} name={u.name} only="node" />)}
    </section>
  );
}

const heading: Record<MonitorType, string> = {
  http: "What to request",
  ssl: "Which host",
  dns: "Which record",
  tcp: "Which port",
  heartbeat: "Your job's schedule",
  stripe: "Connect Stripe, read-only",
  mcp: "MCP server",
  supabase: "Supabase",
};

function placeholderName(type: MonitorType, v: { url: string; host: string; port: number | ""; dnsName: string; record: string }) {
  switch (type) {
    case "http":
      return v.url ? defaultName(v.url) : "Website";
    case "ssl":
      return v.host || "example.com";
    case "tcp":
      return `${v.host || "host"} port ${v.port || "5432"}`;
    case "dns":
      return `${v.dnsName || "www.example.com"} ${v.record}`;
    case "heartbeat":
      return "Nightly digest emails";
    default:
      return "";
  }
}

export function AddMonitorScreen() {
  const s = useWorkspace();
  if (!s) return <Loading />;
  return (
    <Suspense fallback={<Loading />}>
      <AddMonitor s={s} />
    </Suspense>
  );
}
