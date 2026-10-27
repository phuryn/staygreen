import "server-only";
import { AgentError } from "./agent-contract";
import { boundedJson, failure, json } from "./agent-transport";
import { scanInput } from "./scan-contract";
import { admitScan, scanIp } from "./scan-admission";
import { runScan } from "./scan";
import { env } from "./env";

export const scanRouteDependencies = { admit: admitScan, scan: runScan, ip: scanIp };
export async function publicScan(request: Request, deps = scanRouteDependencies) {
  try {
    const site = request.headers.get("sec-fetch-site"); const origin = request.headers.get("origin");
    // Native CLI calls have no ambient authority and may omit Origin. Browser calls
    // must be same-origin; the scan never reads a session or an anonymous cookie.
    if (site ? site !== "same-origin" : origin !== null && origin !== new URL(env().APP_URL).origin)
      throw new AgentError(403, "invalid_origin", "This request's origin is not allowed.");
    let raw: unknown;
    try { raw = await boundedJson(request); } catch (e) { if (e instanceof SyntaxError) throw new AgentError(400, "invalid_json", "Use valid JSON."); throw e; }
    const input = scanInput.parse(raw);
    await deps.admit("ip", deps.ip(request));
    return json(await deps.scan(input));
  } catch (e) { return failure(e); }
}
