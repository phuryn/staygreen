import { mcpRequest } from "@/lib/agent-transport";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function handle(request: Request) { return mcpRequest(request); }
export { handle as POST, handle as GET, handle as HEAD, handle as OPTIONS, handle as DELETE, handle as PUT, handle as PATCH };
