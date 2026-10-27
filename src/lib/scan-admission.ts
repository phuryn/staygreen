import "server-only";
import { isIP } from "node:net";
import { createHmac } from "node:crypto";
import { AgentError } from "./agent-contract";
import { db } from "./db";
import { env } from "./env";

export function scanActor(kind: "ip" | "agent", identity: string, pepper: string) {
  return `${kind}:${createHmac("sha256", pepper).update(`scan:${kind}:${identity}`).digest("hex")}`;
}
export function scanIp(request: Request, production = process.env.NODE_ENV === "production") {
  // Netlify overwrites this header at its public edge. Forwarded-For and CF headers
  // are caller-controlled on the app's DNS-only hostname and are never consulted.
  const address = request.headers.get("x-nf-client-connection-ip") ?? "";
  if (isIP(address)) return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname : address;
  // Local development shares one bucket rather than trusting an arbitrary supplied IP.
  if (!production) return "local-development";
  throw new AgentError(503, "scan_unavailable", "The scan cannot verify its request budget right now.");
}
export async function admitScan(kind: "ip" | "agent", identity: string) {
  const { data, error } = await db().rpc("admit_scan", { p_key: scanActor(kind, identity, env().API_TOKEN_PEPPER) });
  if (error || typeof data !== "number" || data < 0) throw new AgentError(503, "scan_unavailable", "The scan budget could not be checked. Try again later.");
  if (data > 0) throw new AgentError(429, "rate_limited", "Too many scans. Try again after the indicated delay.", data);
}
