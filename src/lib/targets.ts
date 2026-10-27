import "server-only";
import { lookup } from "node:dns/promises";
import { ipVersion, isLocalName, isPublicIp } from "./ip";

/* The create-time half of the private-range refusal (`AGENTS.md § 2.8`): a name
   that looks public can still resolve to 10.0.0.4. So the name is resolved here,
   every address it returns is asked of `ip.ts`, and one private address refuses
   the monitor. The probes repeat the question after every resolution (Phase 2),
   because DNS can change after this answer.

   A name that doesn't resolve is refused too: it can't be checked, and a monitor
   that starts life down tells the builder nothing they don't know. */

export type Resolve = (host: string) => Promise<string[]>;

const RESOLVE_TIMEOUT_MS = 4000;

const systemResolve: Resolve = async (host) => {
  const answers = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), RESOLVE_TIMEOUT_MS)),
  ]);
  return answers.map((a) => a.address);
};

let resolve: Resolve = systemResolve;

/** Used by the unit suite; never by application code. */
export function setResolver(next: Resolve | null): void {
  resolve = next ?? systemResolve;
}

export type TargetCheck = { ok: true } | { ok: false; reason: string };

export async function checkTarget(host: string): Promise<TargetCheck> {
  const h = host.toLowerCase().replace(/\.$/, "");
  const privateAddress = (addr: string) => ({
    ok: false as const,
    reason: addr === h ? `${h} is a private address. Staygreen checks from the public internet, so it can't reach it.` : `${h} points to a private address (${addr}). Staygreen checks from the public internet, so it can't reach it.`,
  });

  if (ipVersion(h)) return isPublicIp(h) ? { ok: true } : privateAddress(h);
  if (isLocalName(h)) return privateAddress(h);

  let addresses: string[];
  try {
    addresses = await resolve(h);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return { ok: false, reason: `${h} doesn't resolve to an address. Check the spelling, or add it once the domain is live.` };
    return { ok: false, reason: `${h} couldn't be looked up just now. Try again in a moment.` };
  }
  if (!addresses.length) return { ok: false, reason: `${h} doesn't resolve to an address. Check the spelling, or add it once the domain is live.` };
  const bad = addresses.find((a) => !isPublicIp(a));
  return bad ? privateAddress(bad) : { ok: true };
}
