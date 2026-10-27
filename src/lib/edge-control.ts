import "server-only";
import { env } from "./env";
import { statusHost } from "./status-host";

/** A private transition is a publication boundary. The database first withdraws the public
 * feed, then the renderer retires its copy and purges CDN URLs, then SQL admits private edits.
 * Failure leaves the old page withdrawn and retryable, never newly private content at the edge. */
export async function withdrawAtEdge(pageId: string, slug: string, version: number): Promise<boolean> {
  const config = env();
  if (config.STATUS_EDGE_ENABLED !== "on") return true; // No edge is serving this environment before activation.
  try {
    const response = await fetch(`https://${statusHost()}/_edge/withdraw`, {
      method: "POST", headers: { authorization: `Bearer ${config.EDGE_CONTROL_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ pageId, slug, version }), signal: AbortSignal.timeout(15_000), redirect: "error", cache: "no-store",
    });
    return response.status === 204;
  } catch { return false; }
}
