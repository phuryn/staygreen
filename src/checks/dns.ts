import { Resolver } from "node:dns/promises";
import { fail, type CheckResult } from "./types";

/* A DNS record (`spec.md § 3.4`), asked of two public resolvers, Cloudflare and Google. A check
   fails only when both disagree with the builder (a mismatch, or no record at all), so one
   resolver's hiccup or a propagation lag at one of them is noted, not alerted; two failing
   checks in a row is the state machine's rule for down.

   The record matches when one of its answers is the expected value, compared without case or a
   trailing dot. TXT matches when an answer contains it, since TXT values are long and builders
   paste the part they care about. NS compares the entire set (comma/whitespace-separated
   expected names), so retaining one old nameserver cannot hide a changed delegation. */

export type DnsRecord = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "CAA" | "NS";
export type DnsCheck = { record: DnsRecord; name: string; expected: string };

export type Ask = (server: string, name: string, record: DnsRecord) => Promise<string[]>;

export const RESOLVERS = [
  { id: "cloudflare", server: "1.1.1.1" },
  { id: "google", server: "8.8.8.8" },
] as const;

const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");
/** NS watches the whole delegation, independent of ordering, case and trailing dots. */
export const dnsSet = (values: readonly string[]) => [...new Set(values.map(norm).filter(Boolean))].sort();

export const systemAsk: Ask = async (server, name, record) => {
  const r = new Resolver({ timeout: 3000, tries: 2 });
  r.setServers([server]);
  switch (record) {
    case "A":
      return r.resolve4(name);
    case "AAAA":
      return r.resolve6(name);
    case "CNAME":
      return r.resolveCname(name);
    case "NS":
      return r.resolveNs(name);
    case "MX":
      return (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`);
    case "TXT":
      return (await r.resolveTxt(name)).map((chunks) => chunks.join(""));
    case "CAA":
      return (await r.resolveCaa(name)).map((c) => {
        const [tag, value] = Object.entries(c).find(([k]) => k !== "critical") ?? ["", ""];
        return `${c.critical ?? 0} ${tag} "${value}"`;
      });
  }
};

type Answer = { resolver: string; answers?: string[]; error?: string; matches: boolean };

export async function checkDns(c: DnsCheck, ask: Ask = systemAsk): Promise<CheckResult> {
  const started = performance.now();
  const want = norm(c.expected);
  const matches = (answers: string[]) =>
    c.record === "NS" ? JSON.stringify(dnsSet(answers)) === JSON.stringify(dnsSet(c.expected.split(/[\s,]+/))) :
    c.record === "TXT" ? answers.some((a) => a.toLowerCase().includes(c.expected.trim().toLowerCase())) : answers.some((a) => norm(a) === want);

  const results: Answer[] = await Promise.all(
    RESOLVERS.map(async ({ id, server }): Promise<Answer> => {
      try {
        const answers = await ask(server, c.name, c.record);
        return { resolver: id, answers, matches: matches(answers) };
      } catch (err) {
        const code = (err as { code?: string }).code ?? "ERROR";
        return { resolver: id, error: code, matches: false };
      }
    }),
  );
  const ms = Math.round(performance.now() - started);
  const detail = { resolvers: results };
  if (results.some((r) => r.matches)) return { ok: true, ms, detail };

  const missing = results.every((r) => r.error === "ENOTFOUND" || r.error === "ENODATA");
  if (missing) return fail(ms, "dns", `No ${c.record} record for ${c.name} at either resolver`, { detail });
  const unreachable = results.every((r) => r.error && r.error !== "ENOTFOUND" && r.error !== "ENODATA");
  if (unreachable) return fail(ms, "timeout", "Neither resolver answered", { detail });
  const seen = results.find((r) => r.answers?.length)?.answers ?? [];
  return fail(ms, "mismatch", `${c.name} ${c.record} is ${seen.join(", ") || "empty"}, expected ${c.expected}`, { detail });
}
