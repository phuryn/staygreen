import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { z } from "zod";
import type { EdgeCache } from "./cache";

const ticket = z.object({ pageId: z.string().min(1).max(128), slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/), version: z.number().int().nonnegative().safe() });

/** Machine credential only; browser sessions and cookies never authorize this endpoint. */
export async function withdraw(headers: IncomingHttpHeaders, chunks: AsyncIterable<Uint8Array>, secret: string,
  cache: EdgeCache, flush: () => Promise<void>): Promise<number> {
  const supplied = Buffer.from(headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return 403;
  if (headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return 415;
  let value: z.infer<typeof ticket>;
  try {
    const body: Buffer[] = []; let size = 0;
    for await (const chunk of chunks) {
      size += chunk.byteLength;
      if (size > 1024) return 413;
      body.push(Buffer.from(chunk));
    }
    value = ticket.parse(JSON.parse(Buffer.concat(body).toString("utf8")));
  } catch { return 400; }
  cache.withdraw(value.pageId, value.slug, value.version);
  try {
    // Acknowledge only after all queued URLs have been accepted by the CDN, including an
    // earlier failed purge. Failed purges retain URLs, never withdrawn page content.
    while (cache.pendingPurge.size) await flush();
    return 204;
  } catch { return 503; }
}
