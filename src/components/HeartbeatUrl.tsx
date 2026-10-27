"use client";

import { KeyRound, TriangleAlert } from "lucide-react";
import { isBuilt } from "@/lib/launch";
import { Copy } from "./Copy";
import { Tabs } from "./ui";

/** Where a builder's job runs, and the one line that pings from there. Each is the job's last
 *  step and swallows its own failure: a ping that can't get through must never be what fails
 *  the job it reports on. */
export type PingPlace = "shell" | "node" | "actions" | "supabase" | "python";

export function pingLines(url: string): Record<PingPlace, { label: string; code: string }> {
  return {
    shell: {
      label: "Shell or cron",
      code: `# The job's last line. A ping that fails never fails the job.\ncurl -fsS -m 10 --retry 3 -o /dev/null "${url}" || true`,
    },
    node: {
      label: "Node or Vercel",
      // A 503 means the ping wasn't recorded: asked again once, after the 5 s its Retry-After says.
      code: `// The cron route's last step. A ping that fails never fails the job; a 503 is retried once.\nconst ping = () => fetch("${url}", { signal: AbortSignal.timeout(10_000) });\nawait ping().then((r) => r.status === 503 && new Promise((done) => setTimeout(done, 5_000)).then(ping)).catch(() => {});`,
    },
    actions: {
      label: "GitHub Actions",
      // A workflow file is often public, and the URL is the heartbeat's only credential.
      code: `# Save the URL as a repository secret named STAYGREEN_PING_URL first.\n- name: Ping Staygreen\n  if: success()\n  run: curl -fsS -m 10 --retry 3 -o /dev/null "\${{ secrets.STAYGREEN_PING_URL }}" || true`,
    },
    supabase: {
      label: "Supabase cron",
      // A bare select is an error inside PL/pgSQL, and a missing pg_net is an error anywhere. A DO
      // block is one statement that runs in a cron command or a function body alike, and its
      // handler catches either without undoing the job's work. Its own dollar tag leaves a
      // function's $$ alone. pg_net sends the request after the job's transaction commits, so the
      // job never sees the answer and can't retry a 503 (`docs/BACKLOG.md`).
      code: `-- After your cron job's statement, or as its function's last lines. Needs the pg_net extension.\n-- The request is queued, and an error here is caught, so it never fails the job.\ndo $ping$\nbegin\n  perform net.http_get('${url}');\nexception when others then\n  null;\nend\n$ping$;`,
    },
    python: {
      label: "Python",
      // urlopen's timeout bounds each read, not the whole call, so the wait is capped from outside:
      // one try, the 5 s a 503's Retry-After asks for, and one more.
      code: `# The job's last step. A ping that fails or stalls never fails the job; a 503 is retried once.\nimport threading\nimport time\nimport urllib.error\nimport urllib.request\n\ndef ping():\n    for wait in (0, 5):\n        time.sleep(wait)\n        try:\n            urllib.request.urlopen("${url}", timeout=10).close()\n            return\n        except urllib.error.HTTPError as e:\n            if e.code != 503:\n                return\n        except Exception:\n            return\n\nt = threading.Thread(target=ping, daemon=True)\nt.start()\nt.join(25)`,
    },
  };
}

/** A heartbeat's ping URL, its only credential (`AGENTS.md § 2.8`), and the line to paste for
 *  each place a job runs, or only `only` when the screen knows where. The monitor's page shows it
 *  again; `onPage` is that page, which titles it itself. */
export function HeartbeatUrl({ url, name, field, only, onPage }: { url: string; name?: string; field?: string; only?: PingPlace; onPage?: boolean }) {
  const lines = pingLines(url);
  const num = field?.trim() || "emails_sent";
  const block = (p: PingPlace) => (
    <div className="stack-sm">
      <pre className="snippet wrap">{lines[p].code}</pre>
      <div><Copy text={lines[p].code} label="Copy" /></div>
    </div>
  );
  return (
    <div className="stack">
      <div className="callout callout-up hb-ping" role="status">
        <KeyRound aria-hidden="true" />
        <div className="stack-sm grow" style={{ minWidth: 0 }}>
          {!onPage && <strong>{name ? `Ping URL for ${name}` : "Your ping URL"}</strong>}
          <code className="code wrap-anywhere hb-url">{url}</code>
          <span className="t-meta">{onPage ? "" : "Copy it into your job. You can see it again on the monitor's page. "}Anyone who has it can report for this job, so keep it out of public files.</span>
          <div className="cluster">
            <Copy text={url} label="Copy URL" />
          </div>
        </div>
      </div>
      {/* in.staygreen.io doesn't resolve until the receiver ships with the checks (2026-10-22). */}
      {!isBuilt("probes") && (
        <p className="callout callout-warn">
          <TriangleAlert aria-hidden="true" />
          <span>Nothing receives pings yet. Staygreen&apos;s checks haven&apos;t started, so this address doesn&apos;t answer and the heartbeat isn&apos;t watched. The lines below ignore a ping that fails, so adding one now can&apos;t break your job.</span>
        </p>
      )}
      <div className="stack-sm hb-places">
        <strong>Call it when the job finishes</strong>
        {only ? block(only) : <Tabs label="Where your job runs" tabs={(Object.keys(lines) as PingPlace[]).map((p) => ({ id: p, label: lines[p].label, body: block(p) }))} />}
        <p className="t-meta">
          To report what the job did, add numbers to the address, like <code className="code">?{num}=12</code>, and the checks you set read them by name. Add <code className="code">/start</code> when the job begins and <code className="code">/fail</code> if it errors.
        </p>
      </div>
    </div>
  );
}
