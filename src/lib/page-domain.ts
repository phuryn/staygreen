import "server-only";
import { request } from "node:https";
import { registrableDomain } from "./dependency-detect";

/** The record name most DNS providers ask for: the host without its registered domain ("status"
 *  for status.askone.org), "@" for the domain itself, and the full host when no registered domain
 *  is recognised. The card also shows the full name, which some providers want instead. */
export function dnsRecordName(host: string): string {
  const domain = registrableDomain(host);
  if (!domain) return host;
  if (host === domain) return "@";
  return host.endsWith(`.${domain}`) ? host.slice(0, -domain.length - 1) : host;
}

export const PROBE_TIMEOUT_MS = 6000;

/** Whether the edge already serves `host` with a certificate valid for it. The request goes to the
 *  claim's own target under Staygreen's suffix, with `host` only as the TLS name and Host header,
 *  never to wherever `host` resolves: like the DNS check, the supplied name can't aim it anywhere
 *  else. The handshake is the first visit that starts the edge issuing the certificate. Hanging up
 *  doesn't cancel it: Caddy obtains under its own deadline, so the next check finds the certificate. */
export function servesOverTls(host: string, target: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    const req = request({ host: target, servername: host, path: "/badge.svg", method: "GET", headers: { host }, agent: false, timeout: timeoutMs }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}
