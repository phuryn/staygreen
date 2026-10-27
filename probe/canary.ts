import { randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { checkHttp } from "../src/checks/http";
import { checkTcp } from "../src/checks/tcp";

/** Independent addresses and DNS names: a resolver outage must not look like every customer's
 * outage. Fixed operator targets, never customer configuration. Each has a three-second bound.
 * The first two are addresses, which never touch a resolver; the next two are names; the last
 * asks the box's resolver for a name no cache can hold. */
export async function networkCanaries(): Promise<boolean[]> {
  const results = await Promise.allSettled([
    checkTcp({ host: "1.1.1.1", port: 53, timeoutSec: 3 }),
    checkTcp({ host: "8.8.8.8", port: 53, timeoutSec: 3 }),
    checkHttp({ url: "https://www.cloudflare.com/", method: "GET", expect: "2xx", slowMs: 3_000, timeoutSec: 3 }),
    checkHttp({ url: "https://www.google.com/", method: "GET", expect: "2xx", slowMs: 3_000, timeoutSec: 3 }),
    freshLookup(),
  ]);
  return results.map((r) => r.status === "fulfilled" && (typeof r.value === "boolean" ? r.value : r.value.ok));
}

/** Two zones on different nameservers, so one zone's outage can't read as every box's own. */
export const FRESH_ZONES = ["staygreen.io", "example.com"];

/** The front doors' names are looked up every few seconds, so a resolver that has stopped answering
 * can still serve them from its cache. A fresh label can't be cached: any answer, or a prompt "no
 * such name", under either zone means the resolver works; timeouts or server failures under both
 * mean it doesn't. The trailing dot keeps search domains out. */
export function freshLookup(lookup: (name: string) => Promise<unknown> = dnsLookup, timeoutMs = 3_000, zones = FRESH_ZONES): Promise<boolean> {
  const label = `canary-${randomBytes(8).toString("hex")}`;
  const one = (zone: string) => lookup(`${label}.${zone}.`).then(() => true, (e: NodeJS.ErrnoException) => e?.code === "ENOTFOUND");
  const any = new Promise<boolean>((resolve) => {
    let left = zones.length;
    for (const zone of zones) void one(zone).then((ok) => { if (ok) resolve(true); else if (--left === 0) resolve(false); });
  });
  const late = new Promise<boolean>((r) => setTimeout(() => r(false), timeoutMs).unref());
  return Promise.race([any, late]);
}

/** Check before each failure counts, sharing an in-flight request set across a burst,
 * including normal checks and peer confirmations. A cached healthy background sample must
 * not admit the first failures of an outage that began just after that sample.
 * A bad network is retried every ten seconds even with no monitors due. */
export class Canary {
  private pending?: Promise<boolean>;
  private checkedAt: number | null = null;
  private reachable = 0;
  private healthy: boolean | null = null;
  suppressed = 0;

  constructor(private check = networkCanaries, private now = Date.now) {}

  health() {
    return { status: this.healthy === null ? "unknown" : this.healthy ? "healthy" : "isolated",
      checkedAt: this.checkedAt, reachable: this.reachable, suppressed: this.suppressed };
  }

  test(force = false): Promise<boolean> {
    if (this.pending) return this.pending;
    const ttl = this.healthy ? 5_000 : 10_000;
    if (!force && this.checkedAt !== null && this.now() - this.checkedAt < ttl) return Promise.resolve(this.healthy === true);
    this.pending = (async () => {
      let results: boolean[] = [];
      try { results = await this.check(); }
      catch { /* Nothing reached. */ }
      this.reachable = results.slice(0, 4).filter(Boolean).length;
      // With the resolver down the two addresses still answer and checks by name fail, except
      // names it still has cached: a fresh name has to get an answer too, or the failures are
      // this box's own.
      this.healthy = this.reachable >= 2 && results.slice(2, 4).some(Boolean) && results[4] === true;
      this.checkedAt = this.now();
      return this.healthy;
    })().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  async admitFailure(): Promise<boolean> {
    const allowed = await this.test(this.healthy !== false);
    if (!allowed) this.suppressed++;
    return allowed;
  }
}
