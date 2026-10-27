/** Free supports single-file purge. Batch at 100 URLs and retry failures on the next refresh.
 * Tokens and provider response bodies never reach logs. */
export async function purge(pending: Map<string, number>, zone: string, token: string, request: typeof fetch = fetch) {
  const batch = [...pending].slice(0, 100);
  const files = batch.map(([url]) => url);
  if (!files.length) return;
  const response = await request(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ files }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || (await response.json() as { success?: boolean }).success !== true) throw new Error("Edge cache purge failed");
  for (const [url, generation] of batch) if (pending.get(url) === generation) pending.delete(url);
}
