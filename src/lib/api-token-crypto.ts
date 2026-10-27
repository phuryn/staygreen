import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function agentHash(purpose: string, value: unknown, pepper: string): string {
  return createHmac("sha256", pepper).update(JSON.stringify(["staygreen/agent/v1", purpose, value])).digest("hex");
}
export function newApiToken(workspaceId: string, pepper: string) {
  const kid = randomBytes(12).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  return { kid, plaintext: `sg_${kid}.${secret}`, hash: agentHash("token", [workspaceId, secret], pepper) };
}
export function parseApiToken(header: string | null) {
  const found = /^Bearer sg_([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/i.exec(header ?? "");
  return found ? { kid: found[1], secret: found[2] } : null;
}
export function matchesApiToken(workspaceId: string, secret: string, hash: string, pepper: string) {
  const expected = Buffer.from(/^[0-9a-f]{64}$/.test(hash) ? hash : "0".repeat(64), "hex");
  return timingSafeEqual(expected, Buffer.from(agentHash("token", [workspaceId, secret], pepper), "hex"));
}
