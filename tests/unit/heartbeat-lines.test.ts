import { describe, expect, it } from "vitest";
import { pingLines, type PingPlace } from "@/components/HeartbeatUrl";

/* The lines a builder pastes into a job to ping its heartbeat (`src/components/HeartbeatUrl.tsx`).
   Each is the job's last step, and a ping that can't get through must never be what fails the job
   it reports on. The URL is the heartbeat's only credential, so the line for a workflow file, which
   is often public, reads it from a secret instead of carrying it. */

const URL = "https://in.staygreen.io/k3V9pQ2xT7mWbR4sLh8nYc";
const lines = pingLines(URL);
const places = Object.keys(lines) as PingPlace[];

describe("pingLines", () => {
  it("covers shell and cron, Node and Vercel, GitHub Actions, Supabase and Python", () => {
    expect(places).toEqual(["shell", "node", "actions", "supabase", "python"]);
  });

  it.each(places.filter((p) => p !== "actions"))("puts the URL in the %s line exactly once", (p) => {
    expect(lines[p].code.split(URL)).toHaveLength(2);
  });

  it("keeps the URL out of the GitHub Actions line and reads it from a secret", () => {
    expect(lines.actions.code).not.toContain(URL);
    expect(lines.actions.code).toContain("${{ secrets.STAYGREEN_PING_URL }}");
    expect(lines.actions.code).toContain("if: success()");
  });

  it.each(["shell", "actions"] as const)("ends the %s line's curl with || true, under a time limit", (p) => {
    const curl = lines[p].code.split("\n").find((l) => l.includes("curl"))!;
    expect(curl.trimEnd()).toMatch(/\|\| true$/);
    expect(curl).toMatch(/-m \d+/);
  });

  it("catches a failed fetch in Node, under a time limit", () => {
    expect(lines.node.code).toMatch(/AbortSignal\.timeout\(\d[\d_]*\)/);
    expect(lines.node.code).toMatch(/\.catch\(\(\) => \{\}\);$/);
  });

  it.each(["shell", "actions"] as const)("retries a 503 in the %s line: curl's --retry does, honouring Retry-After", (p) => {
    expect(lines[p].code).toMatch(/--retry \d/);
  });

  it("retries a 503 once in Node, after the 5 s the receiver's Retry-After asks for, and nothing else", async () => {
    const answers = [503, 200];
    const calls: string[] = [];
    const waits: number[] = [];
    const run = new Function("fetch", "AbortSignal", "setTimeout", `return (async () => { ${lines.node.code} })();`);
    const fakeFetch = async (u: string) => (calls.push(u), { status: answers.shift() ?? 200 });
    const fakeTimeout = (done: () => void, ms: number) => (waits.push(ms), done());
    await run(fakeFetch, { timeout: () => undefined }, fakeTimeout);
    expect(calls).toEqual([URL, URL]);
    expect(waits).toEqual([5_000]);
    // A 404, a 200 or a network error is not asked again, and never throws.
    for (const first of [404, 200]) {
      calls.length = 0;
      answers.splice(0, answers.length, first);
      await run(fakeFetch, { timeout: () => undefined }, fakeTimeout);
      expect(calls).toHaveLength(1);
    }
    await expect(run(async () => { throw new Error("offline"); }, { timeout: () => undefined }, fakeTimeout)).resolves.toBeUndefined();
  });

  it("swallows any exception in Python, retries a 503 once, and stops waiting after a time limit however slowly a reply comes", () => {
    const py = lines.python.code;
    expect(py).toMatch(/urlopen\([^)]*timeout=\d+\)/);
    expect(py).toMatch(/except urllib\.error\.HTTPError as e:\n\s+if e\.code != 503:\n\s+return\n/);
    expect(py).toMatch(/except Exception:\n\s+return\n/);
    expect(py).toContain("for wait in (0, 5):");
    // urlopen's timeout bounds each read, so the call runs on a daemon thread waited on for a fixed time.
    expect(py).toContain("threading.Thread(target=ping, daemon=True)");
    expect(py).toMatch(/\nt\.join\(\d+\)$/);
  });

  it("queues the Supabase request through pg_net in a block that catches any error, so it can't fail or undo the job", () => {
    const sql = lines.supabase.code;
    // Inside PL/pgSQL a bare select is "query has no destination for result data"; perform discards the result.
    expect(sql).toContain(`perform net.http_get('${URL}');`);
    expect(sql).not.toMatch(/^\s*select /m);
    // One statement, valid in a cron command and inside a function, under a tag that isn't a function's $$.
    expect(sql).toMatch(/\ndo \$ping\$\nbegin\n[^]*\nexception when others then\n\s+null;\nend\n\$ping\$;$/);
    expect(sql).not.toMatch(/\$\$/);
  });
});
