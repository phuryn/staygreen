import { restRequest } from "@/lib/agent-transport";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function handle(request: Request, context: { params: Promise<{ operation: string[] }> }) {
  const { operation } = await context.params;
  return restRequest(request, operation.length === 1 ? operation[0] : "");
}
export { handle as POST, handle as GET, handle as HEAD, handle as OPTIONS, handle as DELETE, handle as PUT, handle as PATCH };
