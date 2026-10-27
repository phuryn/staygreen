import "server-only";
import { open, seal } from "./credentials";
import { env } from "./env";
import { heartbeatContext, mintToken, tokenHash } from "./heartbeat-token";

/* A heartbeat's ping URL (`AGENTS.md § 2.8`). The token is 160 random bits and a tag under
   `HEARTBEAT_TOKEN_KEY` that lets the receiver refuse a made-up one without asking the database
   (`heartbeat-token.ts`). Its SHA-256 is the receiver's lookup key; a sealed copy, bound to the
   monitor's id, is what lets the monitor's page show the URL again (owner's decision,
   2026-10-22). Opened for that page and an agent's own provision_app creation receipt,
   never for snapshots or arbitrary agent reads.

   The host is `HEARTBEAT_HOST` (`docs/variables.md`): each environment's own Worker, in front of
   its own database. The token doesn't name a host, so a URL shown again after the host changes
   names the new one. */

export { heartbeatContext };

/** Over http only for a local `wrangler dev`; every Worker with a name is https. */
function urlOf(token: string): string {
  const host = env().HEARTBEAT_HOST;
  return `${/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https"}://${host}/${token}`;
}

/** A new token for `monitorId`: the URL to show, the hash to look it up by, the copy to keep. */
export async function newHeartbeat(monitorId: string) {
  const token = await mintToken(env().HEARTBEAT_TOKEN_KEY);
  return { url: urlOf(token), hash: await tokenHash(token), sealed: seal(token, heartbeatContext(monitorId)) };
}

/** The URL from its sealed copy, or null when the copy doesn't open for this monitor. */
export function openHeartbeat(sealed: string, monitorId: string): string | null {
  try {
    return urlOf(open(sealed, heartbeatContext(monitorId)));
  } catch {
    return null;
  }
}
