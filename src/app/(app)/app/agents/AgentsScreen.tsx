"use client";

import { Pencil, ShieldOff } from "lucide-react";
import { useState } from "react";
import { Loading, PageHead } from "@/components/Shell";
import { Copy } from "@/components/Copy";
import { Modal, ModalBody, ModalFoot } from "@/components/ui";
import type { TokenSummary, AgentActivity } from "@/lib/api-tokens";
import { BuilderTag } from "@/components/Tags";
import { limits, limitsOf } from "@/lib/plans";
import { useWorkspace, useActs, useHoldPoll, type Workspace } from "@/lib/workspace-store";
import { neverExposed, tools } from "./tools";

/* Authenticated agent access (spec.md § 8). Token values live only in the creating dialog. */

const Access = ({ write }: { write: boolean }) =>
  write ? <span className="tag tag-info"><Pencil aria-hidden="true" />Write</span> : <span className="tag">Read</span>;

type Props = { mcpUrl: string; tokens: TokenSummary[]; activity: AgentActivity[] };
function Agents({ s, mcpUrl, tokens, activity }: Props & { s: Workspace }) {
  const L = limitsOf(s);
  const reads = tools.filter((t) => !t.write).length;
  const writes = tools.length - reads;

  return (
    <>
      <PageHead title="Agents and API" sub="Let your coding agent read how your apps are doing, set up monitoring for a new one, and draft incident updates for you to publish." />

      <section className="section" aria-labelledby="connect-h">
        <h2 id="connect-h" className="t-section">Connect your agent</h2>
        <div className="panel stack-sm">
          <p>Add this remote MCP URL in your agent&apos;s settings. Its sign-in opens in your browser; choose the workspace you want it to use.</p>
          <div className="spread"><code className="code wrap-anywhere">{mcpUrl}</code><Copy text={mcpUrl} label="Copy MCP URL" /></div>
          <p className="t-meta">Every call needs sign-in or a workspace token. OAuth allows reading, adding monitors, short pauses and incident drafts.</p>
          <p className="t-meta">For REST, POST a JSON object to <code className="code wrap-anywhere">{new URL("/api/v1/", mcpUrl).href}&lt;tool_name&gt;</code> with your workspace token in the Authorization header. The tools and inputs are the same.</p>
        </div>
      </section>

      <section className="section" aria-labelledby="tl-h">
        <div className="section-head">
          <h2 id="tl-h" className="t-section">What your agent can do</h2>
          <span className="t-meta">{reads} tools that read, {writes} that write. Every write is logged with the client that made it.</span>
        </div>
        <p className="hint"><code className="code">scan_app</code> uses read access and creates no monitors. Keys supplied to it are used once and never stored.</p>
        <div className="panel panel-flush">
          <ul className="ag-tools-list" aria-label="The tools of Staygreen's MCP server">
            {tools.map((t) => (
              <li key={t.name}>
                <span className="spread">
                  <code className="code wrap-anywhere">{t.name}</code>
                  <Access write={t.write} />
                </span>
                <span>{t.inputs}</span>
                <span className="t-meta">Returns: {t.returns}</span>
              </li>
            ))}
          </ul>
          <div className="scroll-x pb-clip hide-sm">
            <table className="table pb-tools">
              <caption className="sr-only">The tools of Staygreen&apos;s MCP server</caption>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">You give it</th>
                  <th scope="col" className="hide-sm">It returns</th>
                  <th scope="col">Access</th>
                </tr>
              </thead>
              <tbody>
                {tools.map((t) => (
                  <tr key={t.name}>
                    <td><code className="code">{t.name}</code></td>
                    <td>{t.inputs}</td>
                    <td className="hide-sm t-2">{t.returns}</td>
                    <td><Access write={t.write} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="panel stack-sm">
          <h3 className="t-body t-strong row"><ShieldOff width={18} height={18} aria-hidden="true" />Never open to agents</h3>
          <ul className="pb-bullets">
            {neverExposed.map((n) => <li key={n}>{n}</li>)}
          </ul>
          <p className="t-2">These stay in the dashboard, so a confused agent can&apos;t silence the alarm that would catch it.</p>
        </div>
      </section>

      <section className="section" aria-labelledby="na-h">
        <h2 id="na-h" className="t-section">Before you have an account</h2>
        <div className="panel">
          <p className="t-2 prose">
            Your agent&apos;s MCP client opens Clerk sign-in when its first call needs authentication. Signing up creates a Free workspace; choose it on the consent screen, then let the agent continue. No dashboard visit is needed.
          </p>
        </div>
      </section>

      {s.can["tokens:manage"] && <Tokens tokens={tokens} />}

      <section className="section" aria-labelledby="activity-h">
        <h2 id="activity-h" className="t-section">Agent activity</h2>
        <div className="panel stack-sm">
          {!activity.length ? <p className="t-2">No agent has made a change in this workspace yet.</p> : <>
            <p className="hint">The latest {activity.length} changes. Retried requests appear once.</p>
            <ul className="stack-sm">
              {activity.map(a => <li className="set-row" key={a.id}><span className="wrap-anywhere">{a.client}</span><code className="code wrap-anywhere">{a.tool}</code><span className="t-meta wrap-anywhere">{a.resource_id} · {new Date(a.created_at).toISOString()}</span></li>)}
            </ul>
          </>}
        </div>
      </section>

      <section className="section" aria-labelledby="rl-h">
        <h2 id="rl-h" className="t-section">Rate limit</h2>
        <div className="panel stack-sm">
          <div className="stat">
            <span className="stat-label">{s.plan === "builder" ? "Builder" : "Free"}, per workspace</span>
            <span className="stat-value num">{L.apiPerMin} <small>calls a minute</small></span>
          </div>
          <p className="t-meta">MCP and REST share the limit. A call over it gets a 429 with a Retry-After header. Creating checks that contact a website or service also shares a limit of six requests a minute.</p>
          {s.plan !== "builder" && <span className="row"><BuilderTag offer="api" /><span className="hint">Builder allows {limits.builder.apiPerMin} calls a minute.</span></span>}
        </div>
      </section>
    </>
  );
}

function Tokens({ tokens }: { tokens: TokenSummary[] }) {
  const acts = useActs();
  const [creating, setCreating] = useState(false);
  const [revoke, setRevoke] = useState<TokenSummary | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [requestId, setRequestId] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useHoldPoll(creating || !!revoke || busy);
  const close = () => { if (!busy) { setCreating(false); setRevoke(null); setSecret(null); setName(""); setError(null); } };
  async function create() {
    if (busy) return; setBusy(true); setError(null);
    const r = await acts.createToken({ request_id: requestId, name, scope });
    setBusy(false); if (r.ok) setSecret(r.token); else setError(r.reason);
  }
  async function remove() {
    if (!revoke || busy) return; setBusy(true); setError(null);
    const r = await acts.revokeToken(revoke.id); setBusy(false);
    if (r.ok) setRevoke(null); else setError(r.reason);
  }
  return <section className="section" aria-labelledby="tk-h">
    <div className="section-head"><h2 id="tk-h" className="t-section">API tokens for CI</h2>
      <button type="button" className="btn btn-primary" onClick={() => { setRequestId(crypto.randomUUID()); setScope("read"); setError(null); setCreating(true); }}>Create token</button>
    </div>
    <div className="panel stack-sm">
      <p className="t-2">Name each token for the client or pipeline that uses it. That name appears in the activity log. A token is shown once and stays valid until you revoke it.</p>
      {!tokens.length ? <p className="hint">No active tokens.</p> : tokens.map(t => <div className="set-row" key={t.id}>
        <div className="stack-sm"><span className="wrap-anywhere">{t.name}</span><span className="hint">{t.scope === "write" ? "Read and write" : "Read only"} · {t.last_used_at ? `Last used ${new Date(t.last_used_at).toISOString()}` : "Never used"}</span><code className="code wrap-anywhere">sg_{t.kid}.…</code></div>
        <button type="button" className="btn btn-sm" onClick={() => { setError(null); setRevoke(t); }}>Revoke<span className="sr-only"> {t.name}</span></button>
      </div>)}
    </div>
    {/* A pending write cannot be cancelled; a shown-once credential needs an explicit close. */}
    <Modal open={creating} onClose={close} undismissable={busy || !!secret}>
      <ModalBody title={secret ? "Save your token" : "Create an API token"}>
        <div className="stack-sm">
          {secret ? <><p>This value is shown once. Store it in your pipeline&apos;s secret settings.</p><code className="code wrap-anywhere">{secret}</code><Copy text={secret} label="Copy token" /></> : <>
            <label className="field">Client or pipeline name<input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={60} autoComplete="off" disabled={busy} /></label>
            <label className="field">Access<select className="input" value={scope} onChange={e => setScope(e.target.value as "read" | "write")} disabled={busy}><option value="read">Read only</option><option value="write">Read and write</option></select></label>
            <p className="hint">Write access adds setup, monitor creation, pauses up to 24 hours, and incident drafts. It cannot delete or publish.</p>
          </>}
          {error && <p className="error" role="alert">{error}</p>}
        </div>
      </ModalBody>
      <ModalFoot><button type="button" className="btn" onClick={close} disabled={busy}>{secret ? "I've saved it" : "Cancel"}</button>{!secret && <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} aria-busy={busy} onClick={create}>{busy ? "Creating…" : "Create token"}</button>}</ModalFoot>
    </Modal>
    <Modal open={!!revoke} onClose={close} undismissable={busy}>
      <ModalBody title="Revoke this token?"><p className="wrap-anywhere">{revoke?.name} will lose access immediately. A request already running may finish.</p>{error && <p className="error" role="alert">{error}</p>}</ModalBody>
      <ModalFoot><button type="button" className="btn" onClick={close} disabled={busy}>Keep token</button><button type="button" className="btn btn-danger" onClick={remove} disabled={busy} aria-busy={busy}>{busy ? "Revoking…" : "Revoke token"}</button></ModalFoot>
    </Modal>
  </section>;
}

export function AgentsScreen(props: Props) {
  const s = useWorkspace();
  return s ? <Agents s={s} {...props} /> : <Loading />;
}
