import { db } from "@/lib/db";
import { domainSchema } from "@/lib/domain-input";

export const dynamic = "force-dynamic";

/** Caddy's GET is read-only. No DNS, writes, session or domain supplied by a caller can issue
 * permission: only the verified row joined to a currently public page does. Fail closed. */
export async function GET(request: Request) {
  const host = domainSchema.safeParse(new URL(request.url).searchParams.get("domain"));
  const headers = { "Cache-Control": "no-store" };
  if (!host.success) return new Response(null, { status: 403, headers });
  try {
    const { data, error } = await db().rpc("edge_domain_allowed", { p_host: host.data });
    return new Response(null, { status: !error && data === true ? 200 : 403, headers });
  } catch { return new Response(null, { status: 503, headers }); }
}
