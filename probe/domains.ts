import { asciiHost, candidates, type DomainResult, type Rdap } from "../src/checks/rdap";
import { ranked, type ProbeInfo } from "./schedule";

/* Domain registration expiry for the hosts the SSL monitors name (`spec.md § 3.2`: domains
   daily), looked up by one probe, the fleet's leader, through RDAP (`src/checks/rdap.ts`).

   - **Who:** the first probe in the rendezvous ranking of a fixed key over the live set, so every
     probe agrees without asking anyone, and a new leader takes over when the old one leaves the
     live set. The spec's leader takes a Postgres advisory lock and records each run in
     `job_runs`; neither exists yet (`BACKLOG.md`). What keeps a handover from asking twice is the
     row: each lookup is recorded with the database's time, and the next leader reads it.
   - **When:** a host is looked at when the leader first loads it (a new SSL monitor gets its
     domain within a refresh of being added) and again every hour. What it reads then decides:
     a domain answered less than a day ago, or a failure less than an hour ago, is not asked
     again. So a domain is asked about once a day, whichever leader, restart or host on it asks,
     and a failure is retried hourly.
   - **What:** one request for a domain already found (`www.askone.org` and `askone.org` share
     `askone.org`'s row and its one request), and a walk from the host up for a host whose domain
     isn't known yet.
   - **How much:** one lookup at a time, each registry server asked at most once a second
     (`src/checks/rdap.ts`), and at most `DOMAIN_PASS_MAX` lookups a pass. What a pass leaves
     (past the cap, a registry that answered 429, IANA's list unreadable, a probe stopping) is
     `deferred`, recorded nowhere, and looked at again in the next pass, so a first pass over tens
     of thousands of hosts runs as a steady trickle, not a burst. */

export const DOMAIN_FRESH_MS = 86_400_000;
export const DOMAIN_RETRY_MS = 3_600_000;
/** How often the leader looks at a host it has already looked at. */
export const DOMAIN_LOOK_SEC = 3600;
/** The most lookups one pass makes. At a request a second per registry, a pass of these lasts a
 *  few minutes at most; the next starts after the next refresh. */
export const DOMAIN_PASS_MAX = 100;

/** What `probe_load_domains` returns for a host that has a row: the longest of its names with one. */
export type DomainRow = { host: string; name: string; status: "found" | "no_rdap" | "not_found" | "failed"; error: string | null; attemptedAt: number };

export type DomainStore = {
  loadDomains(hosts: string[]): Promise<DomainRow[]>;
  /** False when no SSL monitor names the host any more. */
  recordDomain(host: string, result: DomainResult): Promise<boolean>;
};

/** The probe that looks up domains: the same answer on every probe for the same live set. */
export const domainLeader = (peers: readonly ProbeInfo[]): ProbeInfo | undefined => ranked("domain-registrations", peers)[0];

/** Which lookups are due at `now` (epoch ms): each known domain once, however many hosts share it,
 *  and a walk for each host whose domain isn't known. */
export function domainWork(hosts: readonly string[], rows: readonly DomainRow[], now: number): { refresh: Map<string, string>; walk: string[] } {
  const byHost = new Map(rows.map((r) => [r.host, r]));
  const refresh = new Map<string, string>();
  const walk: string[] = [];
  for (const host of hosts) {
    const r = byHost.get(host);
    if (r) {
      const wait = r.status === "failed" || r.error !== null ? DOMAIN_RETRY_MS : DOMAIN_FRESH_MS;
      if (now - r.attemptedAt < wait) continue;
      if (r.status === "found") {
        if (!refresh.has(r.name)) refresh.set(r.name, host);
        continue;
      }
    }
    walk.push(host);
  }
  return { refresh, walk };
}

/** One pass over `hosts`: read their rows, look up what is due, record each answer. Hosts that
 *  aren't domain names (an IP, a one-label name) are skipped. `stopping` is asked between
 *  lookups, so a probe shutting down waits for one lookup at most. `deferred` holds the hosts
 *  (in their ASCII form) the pass left for the next one: nothing about them was recorded. */
export async function domainPass(
  store: DomainStore,
  rdap: Rdap,
  hosts: readonly string[],
  now: number,
  stopping: () => boolean = () => false,
  max = DOMAIN_PASS_MAX,
): Promise<{ looked: number; recorded: number; errors: number; deferred: Set<string> }> {
  const names = [...new Set(hosts.map((h) => asciiHost(h)).filter((h): h is string => h !== null))];
  const counts = { looked: 0, recorded: 0, errors: 0, deferred: new Set<string>() };
  if (names.length === 0) return counts;
  const { refresh, walk } = domainWork(names, await store.loadDomains(names), now);
  const found = new Set<string>();
  /** The registry servers that answered 429 in this pass: asked nothing more in it. */
  const busy = new Set<string>();
  const ask = async (host: string, known?: string) => {
    if (stopping() || counts.looked >= max) return void counts.deferred.add(host);
    const r = await rdap.lookup(host, known, busy);
    if (r.status === "busy") return void counts.deferred.add(host);
    counts.looked++;
    if (r.status === "failed") counts.errors++;
    if (r.status === "found") found.add(r.domain);
    try {
      if (await store.recordDomain(host, r)) counts.recorded++;
    } catch {
      counts.errors++;
    }
  };
  for (const [domain, host] of refresh) await ask(host, domain);
  for (const host of walk) {
    // A domain this pass already found covers every host on it.
    if (candidates(host).some((c) => found.has(c))) continue;
    await ask(host);
  }
  return counts;
}
