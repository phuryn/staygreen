"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { StateIcon } from "@/components/State";
import { Disclosure } from "@/components/Disclosure";
import { day, ms, plural } from "@/lib/format";
import { appLogoForm } from "@/lib/page-asset-prepare";
import { checkPageAssetSource } from "@/lib/page-assets";
import { HEALTH_PATHS, sslComesWith, suggestionTargets, type HttpSuggestion, type Picks, type Suggestions } from "@/lib/suggestions";
import { useActs, type Acts } from "@/lib/workspace-store";

/* The step after an app gets an address, or Find missing checks (`docs/flows.md § Suggested checks`): the server tries the
   address once (`suggestChecks`), and what answered is offered here, ticked as the run proposes
   (the address, the health route whose body says the most, a Supabase project's checks), with
   what it got and the assertions it would check, while what failed is offered unticked with why.
   One button adds the ticked ones; the add form stays one link away, and so does leaving without
   adding anything. The brand colour the run found is said here, and is the builder's to change
   where it is used. */

/** A check's reason as a sentence: some already end in one (the bot-protection explanation). */
const sentence = (reason: string) => /[.!?]$/.test(reason) ? reason : `${reason}.`;

type Phase = { k: "running" } | { k: "refused"; reason: string } | { k: "done"; s: Suggestions };

const SSL = "ssl";
const hostOf = (address: string) => {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
};

/** `skip` is the screen's way out without adding anything; `onDone` runs once checks are added. */
export function SuggestedChecks({ appId, address, skip, onDone }: { appId: string; address: string; skip: React.ReactNode; onDone: () => void }) {
  const acts = useActs();
  const [phase, setPhase] = useState<Phase>({ k: "running" });
  // One run per address: each spends one use of the test budget, and a development build mounts
  // every effect twice.
  const started = useRef(false);
  const host = hostOf(address);
  const form = `/app/monitors/new?app=${appId}`;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void acts.suggestChecks(appId).then((r) => {
      if (!r.ok) return setPhase({ k: "refused", reason: r.reason });
      const s = r.suggestions;
      setPhase({ k: "done", s });
      if (s.icon) void importIcon(acts, appId, s.icon.base64);
    });
  }, [acts, appId]);

  if (phase.k === "running") {
    return (
      <div className="sg" aria-busy="true">
        <p role="status" className="t-2">Trying {host}…</p>
        <p className="t-meta">Staygreen checks the address, its certificate, health routes, the linked app, API and sign-in dependencies. It also looks for SMTP, the website, and the app&apos;s icon and brand colour. It can take up to 25 seconds.</p>
      </div>
    );
  }

  const elsewhere = (
    <div className="cluster">
      <Link href={form} className="btn btn-primary">Add a monitor</Link>
      {skip}
    </div>
  );
  if (phase.k === "refused") {
    return (
      <div className="sg">
        <p className="callout callout-warn" role="alert">{phase.reason}</p>
        <p className="t-2">You can still add a monitor for {host} yourself.</p>
        {elsewhere}
      </div>
    );
  }

  return <SuggestedChecksResult appId={appId} s={phase.s} skip={skip} onDone={onDone} />;
}

/** The completed scan: only missing checks can be selected; coverage is a separate disclosure. */
export function SuggestedChecksResult({ appId, s, skip, onDone }: { appId: string; s: Suggestions; skip: React.ReactNode; onDone: () => void }) {
  const acts = useActs();
  // DNS suggestions start unticked: what they alone catch (a nameserver move, a changed alias that
  // still answers) is rare, and a host that stops resolving fails its HTTP check anyway (owner,
  // 2026-10-23: "Why would they change? unselect by default?").
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set([
    ...s.http.filter((h) => h.ok && h.ticked && !h.watched).map((h) => h.url),
    ...(s.ssl?.ok && !s.ssl.watched ? [SSL] : []),
  ]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = hostOf(s.address);
  const form = `/app/monitors/new?app=${appId}`;
  if (!s.reached) {
    return (
      <div className="sg">
        <p className="callout callout-down" role="alert">
          <span className="wrap-anywhere">{host} didn&apos;t answer{s.unreached ? `: ${s.unreached}` : ""}.</span>
        </p>
        <p className="t-2">Check the address in Settings, or add a monitor for it anyway.</p>
        <div className="cluster"><Link href={form} className="btn btn-primary">Add a monitor</Link>{skip}</div>
      </div>
    );
  }

  const targets = suggestionTargets(s.address);
  const urls = s.http.filter((h) => h.supabase !== "storage" && !h.watched && ticked.has(h.url)).map((h) => h.url);
  // Ticked with an HTTPS check on its host, the SSL check comes with it, as it always does.
  const sslFree = sslComesWith(urls, targets?.sslHost ?? null);
  const sslOn = !!s.ssl && !s.ssl.watched && (sslFree || ticked.has(SSL));
  const dns = (s.dns ?? []).filter(d => !d.watched && ticked.has(`${d.record} ${d.recordName}`));
  const tcp = (s.tcp ?? []).filter(t => !t.watched && ticked.has(`tcp ${t.host}:${t.port}`));
  const count = urls.length + dns.length + tcp.length + (sslOn ? 1 : 0);
  const health = s.http.filter((h) => !h.root && !h.supabase && !h.dependency && HEALTH_PATHS.some(p => new URL(h.url).pathname === p));
  const supabase = s.http.filter((h) => h.supabase);
  const auth = s.supabase ? supabase.find(h => h.supabase === "auth") : undefined;
  // Auth and Storage are one offered Supabase monitor. A Storage-only observation cannot
  // create that monitor without its key, so it isn't counted as a selectable suggestion.
  const offered = [...s.http.filter(h => !h.supabase), ...(s.dns ?? []), ...(s.tcp ?? []), ...(auth ? [auth] : []), ...(s.ssl ? [s.ssl] : [])];
  const covered = offered.filter(h => h.watched).length;
  const missing = offered.length - covered;
  const toggle = (key: string, on: boolean) => {
    setError(null);
    setTicked((t) => {
      const next = new Set(t);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  async function add() {
    if (busy || !count) return;
    setError(null);
    setBusy(true);
    // Each HTTP check takes its assertions; the dedicated Supabase monitor takes the public key.
    const assertions = Object.fromEntries(s.http.filter((h) => urls.includes(h.url) && h.assertions?.length).map((h) => [h.url, h.assertions!]));
    const auth = s.http.some((h) => h.supabase === "auth" && urls.includes(h.url));
    const dependencies = s.http.filter(h => h.dependency && urls.includes(h.url)).map(h => ({ url: h.url, name: h.name, keyword: h.keyword ?? "" }));
    const http = s.http.filter(h => !h.supabase && !h.dependency && urls.includes(h.url)).map(({ url, name, expect }) => ({ url, name, ...(expect ? { expect } : {}) }));
    const picks: Picks = { urls, ssl: sslOn, dependencies, http, tcp: tcp.map(({ host, port, tls }) => ({ host, port, tls })), dns: dns.map(({ record, recordName, expected, name }) => ({ record, recordName, expected, name })), ...(Object.keys(assertions).length ? { assertions } : {}), ...(auth && s.supabase?.key ? { supabaseKey: s.supabase.key } : {}) };
    const r = await acts.addSuggestedChecks(appId, picks);
    setBusy(false);
    if (!r.ok) return setError(r.reason);
    if (r.stopped) acts.toast({ tone: "warn", title: `Added ${plural(r.added, "check")} of ${count}`, body: r.stopped });
    else acts.toast({ tone: "up", title: `Added ${plural(r.added, "check")}` });
    onDone();
  }

  // The certificate is the address's own, so it sits right under the address's HTTP check.
  function sslRow() {
    if (!s.ssl) return null;
    return (
      <label className="check sg-row">
        <input
          type="checkbox"
          checked={sslOn}
          disabled={s.ssl.watched || sslFree}
          onChange={(e) => toggle(SSL, e.target.checked)}
          aria-describedby="sg-ssl-result"
        />
        <span className="sg-body">
          <span className="sg-name">SSL and domain <span className="t-meta">{s.ssl.host}</span></span>
          <span className="sg-result" id="sg-ssl-result">
            {s.ssl.watched ? (
              <span className="t-meta">Already watched by a monitor in this workspace.</span>
            ) : (
              <>
                <StateIcon state={s.ssl.ok ? "up" : "down"} />
                <span className="wrap-anywhere">
                  {s.ssl.ok
                    ? `Certificate valid until ${s.ssl.expiresAt ? day(Date.parse(s.ssl.expiresAt)) : "its expiry"}${s.ssl.daysLeft != null ? `, ${plural(s.ssl.daysLeft, "day")} left` : ""}.`
                    : sentence(s.ssl.reason ?? "The certificate didn't pass")}
                </span>
              </>
            )}
          </span>
          {!s.ssl.watched && (
            <span className="hint">
              {sslFree ? "Comes with the HTTPS check, and doesn't count toward your monitors." : "On its own, it counts as one of your monitors."}
            </span>
          )}
        </span>
      </label>
    );
  }

  function rows(watched: boolean) {
    const http = s.http.filter(h => !h.supabase && !!h.watched === watched);
    const httpRow = (h: HttpSuggestion) => <HttpRow key={h.url} h={h} on={ticked.has(h.url)} onChange={(on) => toggle(h.url, on)} />;
    return <>
        {http.filter(h => h.root).map(httpRow)}
        {s.ssl && !!s.ssl.watched === watched && sslRow()}
        {http.filter(h => !h.root).map(httpRow)}
        {(s.tcp ?? []).filter(t => !!t.watched === watched).map(t => {
          const key = `tcp ${t.host}:${t.port}`;
          return <label className="check sg-row" key={key}>
            <input type="checkbox" checked={!t.watched && ticked.has(key)} disabled={t.watched} onChange={e => toggle(key, e.target.checked)} />
            <span className="sg-body"><span className="sg-name">SMTP <code className="code wrap-anywhere">{t.host}:{t.port}</code></span>
              <span className="sg-result">{t.watched ? "Already watched by a monitor in this workspace." : `Connected${t.tls ? " with TLS" : ""} in ${ms(t.ms)}.`}</span>
              <span className="hint">Checks that the SMTP port accepts a connection. It does not send mail or test delivery.</span>
            </span>
          </label>;
        })}
        {(s.dns ?? []).filter(d => !!d.watched === watched).map(d => {
          const key = `${d.record} ${d.recordName}`;
          return <label className="check sg-row" key={key}>
            <input type="checkbox" checked={!d.watched && ticked.has(key)} disabled={d.watched} onChange={e => toggle(key, e.target.checked)} />
            <span className="sg-body"><span className="sg-name">{d.name} <code className="code wrap-anywhere">{key}</code></span>
              <span className="sg-result">{d.watched ? "Already watched by a monitor in this workspace." : <>Expected: <code className="code wrap-anywhere">{d.expected}</code></>}</span>
              <span className="hint">{d.purpose}</span>
            </span>
          </label>;
        })}
        {s.supabase && auth && !!auth.watched === watched && (() => {
          const ok = supabase.length === 2 && supabase.every(h => h.ok);
          return <label className="check sg-row">
            <input type="checkbox" checked={!auth.watched && ticked.has(auth.url)} disabled={auth.watched} onChange={e => toggle(auth.url, e.target.checked)} />
            <span className="sg-body"><span className="sg-name">Supabase project <code className="code wrap-anywhere">{s.supabase.ref}.supabase.co</code></span>
              <span className="sg-result"><StateIcon state={ok ? "up" : "down"} /><span>{auth.watched ? "Already watched by a Supabase monitor in this workspace." : ok ? "Auth and Storage answered." : "Auth or Storage did not pass. Saving verifies both again."}</span></span>
              <span className="hint">One monitor, with a paused-or-deleted alert. Stores the publishable key encrypted. Add a database read in its settings to help keep a Free project awake.</span>
            </span>
          </label>;
        })()}
    </>;
  }

  return (
    <div className="sg">
      {missing > 0 ? (
        <fieldset className="sg-list" disabled={busy}>
          <legend className="sr-only">Missing checks for {host}</legend>
          {rows(false)}
        </fieldset>
      ) : (
        <p className="callout callout-info" role="status">No missing checks found. Every check suggested by this scan already has a monitor in this workspace. This does not verify a complete sign-in or job run.</p>
      )}
      {covered > 0 && (
        <Disclosure label={`Already covered (${covered})`}>
          <div className="stack-sm">
            <p className="t-meta">These checks already have monitors in this workspace, including paused monitors. Coverage here does not mean they are healthy.</p>
            <fieldset className="sg-list" disabled>
              <legend className="sr-only">Already covered checks for {host}</legend>
              {rows(true)}
            </fieldset>
          </div>
        </Disclosure>
      )}
      {!health.length && <p className="t-meta">No common health route answered ({HEALTH_PATHS.join(", ")}).</p>}
      {supabase.length > 0 && (
        <p className="t-meta">The site&apos;s Supabase project is offered as one monitor. Existing HTTP monitors stay as you configured them.</p>
      )}
      {s.accent && (
        <p className="t-meta sg-found">
          <span className="sg-swatch" style={{ background: s.accent }} aria-hidden="true" />
          <span>The site&apos;s brand colour, <code className="code">{s.accent}</code>, is the accent a new status page for this app starts with. You can change it in the page&apos;s editor.</span>
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="cluster">
        {missing > 0 && <button type="button" className="btn btn-primary" disabled={busy || count === 0} aria-busy={busy} onClick={() => void add()}>
          {busy ? "Adding…" : count === 0 ? "Add checks" : count === 1 ? "Add 1 check" : `Add ${count} checks`}
        </button>}
        <Link href={form} className="btn">Add a different monitor</Link>
        {skip}
      </div>
    </div>
  );
}

function HttpRow({ h, on, onChange }: { h: HttpSuggestion; on: boolean; onChange: (on: boolean) => void }) {
  const id = `sg-${h.url.replace(/[^a-z0-9]/gi, "-")}`;
  // A Supabase check is on the project's own host, so it shows the host too.
  const path = h.root ? h.url : h.supabase || h.dependency || h.discovered ? h.url.replace(/^https:\/\//, "") : new URL(h.url).pathname;
  return (
    <label className="check sg-row">
      <input type="checkbox" checked={on && !h.watched} disabled={h.watched} onChange={(e) => onChange(e.target.checked)} aria-describedby={id} />
      <span className="sg-body">
        <span className="sg-name">{h.root ? "HTTP" : h.name} <code className="code wrap-anywhere">{path}</code></span>
        <span className="sg-result" id={id}>
          {h.watched ? (
            <span className="t-meta">Already watched by a monitor in this workspace.</span>
          ) : (
            <>
              <StateIcon state={h.ok ? "up" : "down"} />
              <span className="wrap-anywhere">{h.ok ? `Answered ${h.status} in ${ms(h.ms)}.` : sentence(h.reason ?? "It didn't answer")}</span>
            </>
          )}
        </span>
        {h.purpose && <span className="hint">{h.purpose}{h.keyword && <> Also checks for <code className="code">{h.keyword}</code>.</>}</span>}
        {!h.watched && h.assertions?.length ? (
          <span className="hint">
            Also checks{" "}
            {h.assertions.map((a, i) => (
              <span key={i}>
                {i > 0 && (i === h.assertions!.length - 1 ? " and " : ", ")}
                <code className="code wrap-anywhere">{a.path} {a.op}{a.op === "exists" ? "" : ` ${a.value}`}</code>
              </span>
            ))}
            , which {h.assertions.length === 1 ? "passes" : "pass"} now. You can change {h.assertions.length === 1 ? "it" : "them"} in the monitor&apos;s settings.
          </span>
        ) : null}
        {!h.watched && h.supabase === "auth" && (
          <span className="hint">Sends the project&apos;s publishable key, found in the site&apos;s code, as its <code className="code">apikey</code> header, stored sealed like any secret header.</span>
        )}
      </span>
    </label>
  );
}

/** The site's icon, made into the app's logo the way a chosen image is: checked, resized in the
 *  browser with its favicon copy beside it (`appLogoForm`), checked again on the server, and kept
 *  only where the app has no logo yet. Best effort: any failure leaves the app with its letter,
 *  and nothing is said. */
async function importIcon(acts: Acts, appId: string, base64: string) {
  try {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const source = checkPageAssetSource(bytes, "app");
    if (!source.ok) return;
    const prepared = await appLogoForm(new File([bytes], "icon", { type: source.type }));
    if (!prepared.ok) return;
    await acts.uploadAppLogo(appId, prepared.form, { keep: true });
  } catch {
    // Nothing to tell: the logo can be chosen in Settings.
  }
}
