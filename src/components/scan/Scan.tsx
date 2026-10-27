"use client";
import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { scanInput, scanOutput, type ScanResult } from "@/lib/scan-contract";

/** The prototype's form/result rows, backed by the shared scan instead of fixtures. */
export function Scan() {
  const [running, setRunning] = useState(false); const [error, setError] = useState("");
  const [result, setResult] = useState<ScanResult | null>(null); const heading = useRef<HTMLHeadingElement>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); if (running) return;
    const form = e.currentTarget; const data = new FormData(form); const raw = String(data.get("url") ?? "").trim();
    const input = scanInput.safeParse({ url: /^https?:\/\//i.test(raw) ? raw : `https://${raw}`,
      ...Object.fromEntries(["stripe_key", "supabase_url", "supabase_key"].flatMap(k => data.get(k) ? [[k, String(data.get(k)).trim()]] : [])) });
    if (!input.success) { setError("Use a public HTTP(S) address without query parameters or credentials. Stripe needs a restricted rk_ key. Supply the Supabase URL and publishable key together."); return; }
    setRunning(true); setError(""); setResult(null);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input.data), signal: controller.signal });
      if (!response.ok) { const retry = Number(response.headers.get("Retry-After")); throw Error(response.status === 429 ? `Too many scans. Try again${retry > 0 ? ` in ${retry} seconds` : " in a minute"}.` : "Scan unavailable"); }
      setResult(scanOutput.parse(await response.json())); requestAnimationFrame(() => heading.current?.focus());
    } catch (e) { setError(e instanceof Error && e.message.startsWith("Too many") ? e.message : "The scan could not finish. Check your inputs and try again."); }
    finally { clearTimeout(timer); for (const name of ["stripe_key", "supabase_key"]) { const field = form.elements.namedItem(name); if (field instanceof HTMLInputElement) field.value = ""; } setRunning(false); }
  }
  return <div className="stack-lg"><form className="panel stack pb-touch" onSubmit={submit} aria-busy={running}>
    <fieldset disabled={running} className="stack"><div className="field"><label className="label" htmlFor="scan-url">Your app&apos;s URL</label><input className="input" id="scan-url" name="url" placeholder="https://yourapp.com" required maxLength={2048} autoComplete="url" /></div>
      <details><summary>Optional service checks</summary><div className="stack">
        <div className="field"><label className="label" htmlFor="scan-stripe">Restricted Stripe key</label><input className="input" id="scan-stripe" name="stripe_key" type="password" autoComplete="off" maxLength={220} /><p className="hint">A restricted rk_ key with Events read access and no Customers access. Reads failed deliveries across the account for the last 30 days.</p></div>
        <div className="field"><label className="label" htmlFor="scan-supabase">Supabase project URL</label><input className="input" id="scan-supabase" name="supabase_url" type="url" maxLength={100} /></div>
        <div className="field"><label className="label" htmlFor="scan-key">Supabase publishable key</label><input className="input" id="scan-key" name="supabase_key" type="password" autoComplete="off" maxLength={2000} /></div>
      </div></details></fieldset>
    <p className="t-meta">Keys are used for this scan only, never stored or logged. Results stay in this response. Abuse counters use a keyed hash of your IP address, never the address itself.</p>
    {error && <p role="alert" className="callout callout-bad">{error}</p>}<div><button className="btn btn-primary btn-lg" disabled={running}>{running ? "Scanning…" : "Scan my app"}</button></div>
    <p className="hint">Crons: run <code className="code wrap-anywhere">npx staygreen scan https://yourapp.com --repo .</code> from your repository. MCP server health is Coming soon.</p>
  </form>{result && <section className="stack" aria-labelledby="scan-results"><h2 className="t-section" id="scan-results" tabIndex={-1} ref={heading}>Scan results</h2><p className="t-meta">A one-time check. Unknown and skipped checks are not an all-clear.</p>
    <ol className="panel panel-flush pb-list">{([["Certificate", result.certificate], ["Domain registration", result.domain], ["Status page", result.status_page], ["Supabase", result.supabase], ["Stripe deliveries", result.stripe]] as const).map(([title, finding]) => <li className="pb-list-row" key={title}><div className="stack-sm grow"><span className="spread"><strong>{title}</strong><span className="tag">{finding.state}</span></span><p className="t-2">{finding.message}</p>{"expires_at" in finding && finding.expires_at && <p>Expires {new Date(finding.expires_at).toLocaleDateString()}</p>}{title === "Stripe deliveries" && result.stripe.failed_events !== null && <p>{result.stripe.failed_events} failed events; {result.stripe.pending_events} pending.</p>}</div></li>)}</ol>
    <DependencyResults report={result.dependencies} />
    <p className="t-2">{result.crons_message}</p><div><Link className="btn" href="/app">Set up ongoing monitoring</Link></div>
  </section>}</div>;
}

export function DependencyResults({ report }: { report: ScanResult["dependencies"] }) {
  return <div className="stack"><h3 className="t-section">Sign-in dependencies</h3>
    <p className="t-meta">Checks what the page names, without signing in. No detected dependency is not an all-clear; server-only configuration and unread scripts can hide one.</p>
    {!report.checks.length && <p className="t-2">No sign-in provider could be identified from this response.</p>}
    {report.checks.map(c => <div className="panel stack-sm" key={c.url}><strong>{c.provider} · {c.host}</strong>
      <p className="t-2">DNS: {c.dns}. TLS: {c.tls}. Frontend: {c.frontend}.</p><p className="t-2">{c.purpose}</p>
      {c.reason && <p className="t-2 wrap-anywhere">{c.reason}</p>}
      <p className="hint">Suggested HTTP monitor: <code className="code wrap-anywhere">{c.url}</code> · 2xx after redirects{c.keyword && <> · keyword <code className="code">{c.keyword}</code></>}.</p>
    </div>)}
    {report.dns.map(d => <div className="panel stack-sm" key={`${d.record} ${d.recordName}`}><strong>{d.name}</strong><p className="t-2">{d.purpose}</p>
      <p className="hint">Suggested DNS monitor: <code className="code wrap-anywhere">{d.record} {d.recordName}</code>. Expected: <code className="code wrap-anywhere">{d.expected}</code>.</p>
    </div>)}
    <p className="t-meta">These monitors are offered when you add the app. DNS suggestions need matching current answers from both resolvers; a missing CNAME is not replaced with a guess.</p>
  </div>;
}
