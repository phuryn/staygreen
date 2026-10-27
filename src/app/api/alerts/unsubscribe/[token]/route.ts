import { isOneClickBody } from "@/lib/alerts/links";
import { unsubscribeByToken } from "@/lib/alerts/public";

/* One-click unsubscribe (RFC 8058), the address in every alert email's List-Unsubscribe header:
   a mail app POSTs `List-Unsubscribe=One-Click` here from its own servers, with no cookie and no
   Origin of ours, so there is no Origin check. The signed token is the whole authority, and it can
   stop only what its own receipt reached (`src/lib/alerts/links.ts`); a POST without the RFC's
   body is refused, so a client that merely follows the header's URL stops nothing. A GET (someone opened the
   address) changes nothing and goes to the page with the button. */

export const dynamic = "force-dynamic";

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isOneClickBody((await req.text().catch(() => "")).slice(0, 1024))) return text("Not a one-click unsubscribe request.\n", 400);
  const { outcome } = await unsubscribeByToken(token);
  if (outcome === "invalid") return text("Not a Staygreen unsubscribe link.\n", 404);
  if (outcome === "unavailable") return text("Unsubscribing isn't set up on this server.\n", 503);
  return text("Unsubscribed.\n", 200);
}

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return Response.redirect(new URL(`/unsubscribe/${encodeURIComponent(token)}`, req.url), 303);
}
