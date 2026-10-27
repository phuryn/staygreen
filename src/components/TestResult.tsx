"use client";

import { Fragment } from "react";
import { Disclosure } from "@/components/Disclosure";
import { StateIcon } from "@/components/State";
import { day, ms, plural, timeSec } from "@/lib/format";
import type { Op } from "@/lib/model";
import { assertionFor, PATH_MAX, pathOf, type HttpTest, type JsonNode, type TestOutcome } from "@/lib/test-result";

/* What a test before saving found (`src/lib/monitor-test.ts` made it, already masked), laid out
   for reading under pressure: the verdict first, in shape, word and colour, then what the target
   said, then the raw material. A JSON body is a tree whose values add an assertion when chosen,
   by keyboard as by pointer. */

export type Pick = (path: string, op: Op, value: string) => void;

/** `picked`: the form's assertions, as `path op value`, so a value already checked says so. */
export type TreeProps = { onPick: Pick; picked: ReadonlySet<string>; full: boolean };

export const assertionKey = (path: string, op: string, value: string) => `${path} ${op} ${op === "exists" ? "" : value}`;

/** The sentence a screen reader hears when a test answers. */
export function testSummary(o: TestOutcome): string {
  const word = o.ok ? (o.slow ? "Test passed, but slowly" : "Test passed") : "Test failed";
  return `${word} in ${ms(o.ms)}.${o.failure ? ` ${o.failure.message}.` : ""}`;
}

const kb = (n: number) => (n < 1024 ? plural(n, "byte") : `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`);

export function TestResult({ outcome: o, from, stale, tree }: { outcome: TestOutcome; from: string; stale: boolean; tree?: TreeProps }) {
  const state = o.ok ? (o.slow ? "degraded" : "up") : "down";
  return (
    <div className="tr">
      <div className="tr-verdict">
        <StateIcon state={state} size={20} />
        <strong>{o.ok ? (o.slow ? "Passed, but slow" : "Passed") : "Failed"}</strong>
        <span className="t-2 num">{ms(o.ms)}</span>
      </div>
      {o.failure && (
        <p className="callout callout-down">
          <span className="wrap-anywhere">{o.failure.message}</span>
        </p>
      )}
      <p className="t-meta">
        Run once at {timeSec(o.at)} from Staygreen&apos;s own server, not from {from}. A target that answers networks differently can answer those differently.
        {stale && " You've changed the form since; test again to check what it holds now."}
      </p>
      {o.type === "http" && <HttpResult h={o.http} tree={tree} />}
      {(o.type === "stripe" || o.type === "supabase") && <div className="stack-sm">
        <p>{o.service.summary}</p>
        {o.service.steps.map(step => <p key={step.name}><Mark ok={step.ok} yes={`${step.name}: ${step.status ?? "passed"}`} no={`${step.name}: ${step.status ?? "no answer"}`} /></p>)}
        {!o.service.saveable && <p className="t-2">This configuration cannot be saved until its checks can be verified.</p>}
      </div>}
      {o.type === "tcp" && (
        <dl className="kv">
          <dt>Connection</dt>
          <dd>
            <Mark ok={o.ok || o.failure?.kind === "tls"} yes={`Connected to ${o.tcp.host} on port ${o.tcp.port}`} no={`Didn't connect to ${o.tcp.host} on port ${o.tcp.port}`} />
          </dd>
          {o.tcp.tls && (
            <>
              <dt>TLS handshake</dt>
              <dd>{o.ok ? <Mark ok yes="Completed" /> : o.failure?.kind === "tls" ? <Mark ok={false} no="Failed" /> : <span className="t-3">Not reached</span>}</dd>
            </>
          )}
          <dt>Time</dt>
          <dd className="num">{ms(o.ms)}</dd>
          {o.tcp.address && (
            <>
              <dt>Address</dt>
              <dd className="num">{o.tcp.address}</dd>
            </>
          )}
        </dl>
      )}
      {o.type === "ssl" && (
        <dl className="kv">
          <dt>Name</dt>
          <dd>{o.ssl.nameMatches === null ? <span className="t-3">Not read</span> : <Mark ok={o.ssl.nameMatches} yes={`It covers ${o.ssl.host}`} no={`It isn't for ${o.ssl.host}`} />}</dd>
          {o.ssl.names.length > 0 && (
            <>
              <dt>Covers</dt>
              <dd className="wrap-anywhere">{o.ssl.names.join(", ")}</dd>
            </>
          )}
          <dt>Chain</dt>
          <dd>{o.ssl.trusted === null ? <span className="t-3">Not read</span> : <Mark ok={o.ssl.trusted} yes="Trusted" no="Not trusted" />}</dd>
          {o.ssl.issuer && (
            <>
              <dt>Issuer</dt>
              <dd className="wrap-anywhere">{o.ssl.issuer}</dd>
            </>
          )}
          {o.ssl.expiresAt && (
            <>
              <dt>Expires</dt>
              <dd>
                <span className="num">{day(Date.parse(o.ssl.expiresAt))} {o.ssl.expiresAt.slice(0, 4)}</span>
                {o.ssl.daysLeft !== undefined && <span className="t-2">, {o.ssl.daysLeft < 0 ? "already expired" : `${plural(o.ssl.daysLeft, "day")} left`}</span>}
              </dd>
            </>
          )}
        </dl>
      )}
      {o.type === "dns" && (
        <div className="stack-sm">
          <p className="t-2">
            It should be <code className="code wrap-anywhere">{o.dns.expected}</code>
            {o.dns.record === "TXT" ? ", somewhere in one of the answers." : o.dns.record === "NS" ? ", the whole set of nameservers, in any order." : ", as one of the answers."} It passes when either resolver agrees.
          </p>
          <ul className="tr-list">
            {o.dns.resolvers.map((r) => (
              <li key={r.id} className="tr-row">
                <StateIcon state={r.matches ? "up" : "down"} size={16} title={r.matches ? "Matches" : "Doesn't match"} />
                <div className="stack-sm grow">
                  <strong>{r.label}</strong>
                  {r.answers?.length ? (
                    <ul className="stack-sm">
                      {r.answers.map((a, i) => (
                        <li key={i}><code className="code wrap-anywhere">{a}</code></li>
                      ))}
                    </ul>
                  ) : (
                    <span className="t-2">{r.error ?? "No answers"}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** A yes or no in shape, word and colour. */
function Mark({ ok, yes, no }: { ok: boolean; yes?: string; no?: string }) {
  return (
    <span className="row tr-mark">
      <StateIcon state={ok ? "up" : "down"} size={16} />
      <span className={ok ? undefined : "t-down"}>{ok ? yes : no}</span>
    </span>
  );
}

function HttpResult({ h, tree }: { h: HttpTest; tree?: TreeProps }) {
  return (
    <>
      <dl className="kv">
        <dt>Request</dt>
        <dd><code className="code wrap-anywhere">{h.method} {h.url}</code></dd>
        <dt>Status</dt>
        <dd>{h.status === undefined ? <span className="t-down">No answer</span> : <Mark ok={!!h.statusOk} yes={`${h.status}, expected ${h.expect}`} no={`${h.status}, expected ${h.expect}`} />}</dd>
        {h.keyword && (
          <>
            <dt>Body contains</dt>
            <dd><Mark ok={h.keyword.found} yes={`"${h.keyword.text}" is there`} no={`"${h.keyword.text}" isn't there`} /></dd>
          </>
        )}
        {h.redirects.length > 0 && (
          <>
            <dt>Redirects</dt>
            <dd>
              <ol className="stack-sm">
                {h.redirects.map((r, i) => (
                  <li key={i} className="wrap-anywhere"><span className="num">{r.status}</span> to {r.location || <span className="t-3">no address</span>}</li>
                ))}
              </ol>
            </dd>
          </>
        )}
        {h.address && (
          <>
            <dt>Answered from</dt>
            <dd className="num">{h.address}</dd>
          </>
        )}
      </dl>

      {h.assertions.length > 0 && (
        <div className="stack-sm">
          <h3 className="tr-h">Assertions</h3>
          <div>
            {h.assertions.map((a, i) => (
              <div key={i} className="assert-row">
                <StateIcon state={a.pass ? "up" : "down"} size={16} title={a.pass ? "Passing" : "Failing"} />
                <code className="wrap-anywhere">{a.path} {a.op}{a.op === "exists" ? "" : ` ${a.expected}`}</code>
                <span className={`wrap-anywhere ${a.pass ? "t-3" : "t-down"}`}>{a.got !== undefined ? `got ${a.got}` : "nothing there"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {h.body && (
        <div className="stack-sm">
          <div className="section-head">
            <h3 className="tr-h">Body</h3>
            <span className="t-meta">{kb(h.body.bytes)}{h.body.contentType ? `, ${h.body.contentType}` : ""}</span>
          </div>
          {h.body.truncated && <p className="t-meta">The check reads the first 64 KB and stops, so this is cut there.</p>}
          {h.body.kind === "empty" && <p className="t-2">Empty.</p>}
          {h.body.kind === "binary" && <p className="t-2">Not text, so it isn&apos;t shown.</p>}
          {h.body.kind === "text" && <pre className="snippet wrap tr-body">{h.body.text}</pre>}
          {h.body.kind === "json" && h.body.json && (
            <>
              {tree && (
                <p className="t-meta">
                  Choose a value to check it on every request: it&apos;s added as an assertion. Choose it again to take it off.
                  {tree.full && " Every assertion your plan has is in use, so take one off to add another."}
                </p>
              )}
              <JsonTree root={h.body.json} tree={tree} />
              <Disclosure label="As text">
                <pre className="snippet wrap tr-body">{h.body.text}</pre>
              </Disclosure>
            </>
          )}
        </div>
      )}

      {h.headers.length > 0 && (
        <Disclosure label={`Response headers (${h.headers.length})`}>
          <dl className="kv tr-headers">
            {h.headers.map(([k, v], i) => (
              <Fragment key={i}>
                <dt><code className="wrap-anywhere">{k}</code></dt>
                <dd className="wrap-anywhere">{v}</dd>
              </Fragment>
            ))}
          </dl>
        </Disclosure>
      )}
    </>
  );
}

/** Opened two levels deep; the rest is a summary away, so a large body stays readable. */
const OPEN_DEPTH = 2;

function JsonTree({ root, tree }: { root: JsonNode; tree?: TreeProps }) {
  return (
    <div className="jt">
      {root.t === "object" || root.t === "array" ? (
        <Children node={root} steps={[]} reachable depth={0} tree={tree} />
      ) : (
        <ul>
          <Leaf node={root} label="$" steps={[]} reachable tree={tree} />
        </ul>
      )}
    </div>
  );
}

function Children({ node, steps, reachable, depth, tree }: { node: Extract<JsonNode, { t: "object" | "array" }>; steps: (string | number)[]; reachable: boolean; depth: number; tree?: TreeProps }) {
  const kids = node.t === "object" ? node.entries.map((e) => ({ label: e.k, step: e.k as string | number, masked: !!e.masked, n: e.n })) : node.items.map((n, i) => ({ label: String(i), step: i as string | number, masked: false, n }));
  if (!kids.length && !node.more) return <span className="t-3">{node.t === "object" ? "{ }" : "[ ]"}</span>;
  return (
    <ul>
      {kids.map((k) => {
        const at = [...steps, k.step];
        // A key the masker hid can't be named in a path, so nothing under it can be asserted.
        const ok = reachable && !k.masked;
        return k.n.t === "object" || k.n.t === "array" ? (
          <li key={String(k.step)}>
            <details open={depth < OPEN_DEPTH}>
              <summary>
                <span className="jt-key">{k.label}</span>{" "}
                <span className="t-3">{k.n.t === "object" ? plural(k.n.entries.length + k.n.more, "key") : plural(k.n.items.length + k.n.more, "item")}</span>
              </summary>
              <Children node={k.n} steps={at} reachable={ok} depth={depth + 1} tree={tree} />
            </details>
          </li>
        ) : (
          <Leaf key={String(k.step)} node={k.n} label={k.label} steps={at} reachable={ok} tree={tree} />
        );
      })}
      {node.more > 0 && <li className="t-3">and {node.more} more, not shown</li>}
    </ul>
  );
}

function Leaf({ node, label, steps, reachable, tree }: { node: JsonNode; label: string; steps: (string | number)[]; reachable: boolean; tree?: TreeProps }) {
  const shown = node.t === "string" ? `${JSON.stringify(node.v)}${node.cut ? "…" : ""}` : node.t === "null" ? "null" : "v" in node ? String(node.v) : "";
  const path = pathOf(steps);
  const { op, value } = assertionFor(node);
  const key = assertionKey(path, op, value);
  if (!tree || !reachable || path.length > PATH_MAX) {
    return (
      <li className="jt-leaf">
        <span className="jt-key">{label}</span>
        <span className="jt-val jt-fixed">{shown}</span>
      </li>
    );
  }
  const on = tree.picked.has(key);
  return (
    <li className="jt-leaf">
      <span className="jt-key">{label}</span>
      <button
        type="button"
        className="jt-val"
        aria-pressed={on}
        disabled={!on && tree.full}
        aria-label={`${on ? "Stop checking" : "Check"} ${path} ${op}${op === "exists" ? "" : ` ${value}`}`}
        onClick={() => tree.onPick(path, op, value)}
      >
        {shown}
      </button>
    </li>
  );
}
