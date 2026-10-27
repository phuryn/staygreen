import { publicScan } from "@/lib/scan-route";
export const runtime = "nodejs";
export const maxDuration = 60;
export const POST = (request: Request) => publicScan(request);
