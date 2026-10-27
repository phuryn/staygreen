"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Copy } from "./Copy";
import { DeleteDialog } from "./DeleteDialog";
import { Disclosure } from "./Disclosure";
import { CollapsibleSection } from "./CollapsibleSection";
import type { StatusPage } from "@/lib/model";
import { useActs } from "@/lib/workspace-store";
import { domainSchema } from "@/lib/domain-input";
import { statusHost } from "@/lib/status-host";

type Step = "done" | "now" | "next";

/** The custom domain as three steps the owner can follow: the DNS record, the certificate, then
 *  switching links. Each step says whether it is done, under way or next, from what the server has
 *  checked: the record in public DNS, then the edge answering for the domain with its certificate. */
export function PageDomain({ page, canVerify }: { page: StatusPage; canVerify: boolean }) {
  const acts = useActs();
  const remove = useRef<HTMLDialogElement>(null);
  const [host, setHost] = useState("");
  const [expanded, setExpanded] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [live, setLive] = useState<boolean | null>(null);
  const current = page.domain;
  const verified = current?.step === 4;
  const expired = current && !verified && Date.now() - current.startedAt >= 7 * 86_400_000;
  const oldAddress = `${statusHost()}/${page.slug}`;

  // Domain actions save independently. A refusal that arrives after collapsing still opens
  // its field; keeping the contents mounted also keeps the unsaved hostname and polling.
  useEffect(() => { if (error) setExpanded(true); }, [error]);

  useEffect(() => {
    if (!current || verified || expired || page.membersOnly || !canVerify) return;
    let stopped = false, pending = false, retryAt = 0;
    const check = async () => {
      if (stopped || pending || document.hidden || Date.now() < retryAt) return;
      pending = true; setChecking(true);
      const result = await acts.verifyPageDomain(page.id);
      pending = false;
      if (stopped) return;
      setChecking(false);
      setError(result.ok ? null : result.reason);
      if (!result.ok) retryAt = Date.now() + (result.retryAfterSec ?? 30) * 1000;
      if (result.ok && result.verified) stopped = true;
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [acts, page.id, current?.host, current?.cnameTarget, current?.startedAt, verified, expired, page.membersOnly, canVerify]);

  // Once DNS is verified, ask whether the edge answers with the certificate, until it does.
  useEffect(() => {
    setLive(null);
    if (!current || !verified || page.membersOnly) return;
    let stopped = false, pending = false, retryAt = 0;
    const check = async () => {
      if (stopped || pending || document.hidden || Date.now() < retryAt) return;
      pending = true;
      const result = await acts.checkPageDomain(page.id);
      pending = false;
      if (stopped) return;
      if (!result.ok) { retryAt = Date.now() + (result.retryAfterSec ?? 30) * 1000; return; }
      setLive(result.live);
      if (result.live) stopped = true;
    };
    void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [acts, page.id, current?.host, verified, page.membersOnly]);

  async function add() {
    if (busy) return;
    const parsed = domainSchema.safeParse(host);
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    setBusy(true); setError(null);
    const result = await acts.reservePageDomain(page.id, parsed.data);
    setBusy(false);
    if (!result.ok) setError(result.reason);
  }

  return <CollapsibleSection id="pe-domain" title="Your own domain" expanded={expanded} onToggle={() => setExpanded(value => !value)}>
    <div className="stack">
      {page.membersOnly ? <p className="t-2">Members-only pages open at staygreen.io after sign-in. A custom domain serves public pages only.</p> : current ? <>
        <p className="addr wrap-anywhere">{current.host}</p>
        <DomainSteps domain={current} verified={verified} expired={!!expired} checking={checking} live={live} canVerify={canVerify} />
        <p className="t-2">{oldAddress} keeps working, now and after you switch, so links you&apos;ve already shared don&apos;t break.</p>
      </> : <>
        <div className="field"><label className="label" htmlFor="pe-domain-host">Domain</label>
          <input id="pe-domain-host" className="input" value={host} onChange={e => setHost(e.target.value)} placeholder="status.yourapp.com" maxLength={253} autoCapitalize="off" spellCheck={false} aria-describedby="pe-domain-hint" />
          <span id="pe-domain-hint" className="hint">A hostname you own. Add it here to get the DNS record. {oldAddress} keeps working too.</span></div>
        <div><button className="btn" type="button" disabled={busy} onClick={add}>{busy ? "Adding…" : "Add domain"}</button></div>
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      {!page.membersOnly && <p className="hint">Domain changes apply as soon as you make them. They don&apos;t need Save changes.</p>}
      {current && <div><button className="btn" type="button" onClick={() => remove.current?.showModal()}>Remove domain</button></div>}
    </div>
    <DeleteDialog ref={remove} title="Remove this custom domain?" confirm="Remove domain" run={() => acts.removePageDomain(page.id)}>
      <p className="t-2">{page.membersOnly ? "The domain is removed from this page." : <>The domain stops serving this page, and {oldAddress} keeps working.</>} Its DNS monitor and history remain; you can remove the monitor separately.</p>
    </DeleteDialog>
  </CollapsibleSection>;
}

/** The three steps on their own, from what has been checked, so every state can be rendered and read. */
export function DomainSteps({ domain, verified, expired, checking, live, canVerify }: { domain: NonNullable<StatusPage["domain"]>; verified: boolean; expired: boolean; checking: boolean; live: boolean | null; canVerify: boolean }) {
  const record = <dl className="pe-dns">
    <dt>Type</dt><dd>CNAME</dd>
    <dt>Name</dt><dd className="stack-sm">
      <span className="pe-dns-val"><code className="code wrap-anywhere">{domain.name}</code><Copy text={domain.name} label="Copy name" icon /></span>
      {domain.name !== domain.host && <span className="hint">Some providers want the full name, {domain.host}.</span>}
    </dd>
    <dt>Target</dt><dd><span className="pe-dns-val"><code className="code wrap-anywhere">{domain.cnameTarget}</code><Copy text={domain.cnameTarget} label="Copy target" icon /></span></dd>
  </dl>;
  const url = `https://${domain.host}`;
  const certStep: Step = !verified ? "next" : live ? "done" : "now";
  return <ol className="steps">
    <StepItem n={1} state={verified ? "done" : "now"} title={verified ? "DNS record found" : expired ? "Pending domain expired" : "Add this DNS record"}>
      {verified ? <>
        <span className="hint">A DNS monitor now watches it, so leave it in place.</span>
        <Disclosure label="Show the record">{record}</Disclosure>
      </> : expired ? <span className="t-2">Remove it and add it again to get a new target.</span> : <>
        <span className="t-2" role="status">{checking ? "Checking the record…" : "Not found yet. It's checked every 30 seconds while this page is open."}</span>
        {record}
        <span className="hint">Add it with your DNS provider as DNS only, with no proxy. Removing and re-adding a domain gives it a new target. Pending domains expire after seven days. Verification adds one DNS monitor within your plan&apos;s allowance.</span>
        {!canVerify && <span className="hint">A workspace member who can manage monitors must verify this domain.</span>}
      </>}
    </StepItem>
    <StepItem n={2} state={certStep} title={live ? "Certificate issued" : verified ? "Issuing the certificate" : "Certificate"}>
      <span className={certStep === "now" ? "t-2" : "hint"} role={certStep === "now" ? "status" : undefined}>{live ? `${domain.host} answers over HTTPS.`
        : verified ? "Staygreen's check makes the first visit, which starts it. It usually takes under a minute, and it's checked every 30 seconds while this page is open."
        : "Issued automatically once the record is found."}</span>
    </StepItem>
    <StepItem n={3} state={live ? "done" : "next"} title={live ? "Ready to share" : "Switch your links"}>
      {live ? <>
        <span className="pe-dns-val"><a className="code wrap-anywhere" href={url} target="_blank" rel="noreferrer">{url}</a><Copy text={url} label="Copy address" icon /></span>
        <span className="t-2">Point your app&apos;s footer, docs and emails at it whenever you&apos;re ready.</span>
        <span className="hint">If it doesn&apos;t open on your network yet, your DNS provider is still holding the answer from before the record existed. That clears on its own, usually within an hour.</span>
      </> : <span className="hint">Once the certificate is issued, {url} is ready to share.</span>}
    </StepItem>
  </ol>;
}

function StepItem({ n, state, title, children }: { n: number; state: Step; title: string; children: React.ReactNode }) {
  return <li className={state === "next" ? "step" : `step ${state}`} aria-current={state === "now" ? "step" : undefined}>
    <span className="step-n num" aria-hidden="true">{state === "done" ? <Check /> : n}</span>
    <div className="stack-sm">
      <strong>{title}<span className="sr-only">{state === "done" ? ", done" : state === "now" ? ", in progress" : ", next"}</span></strong>
      {children}
    </div>
  </li>;
}
