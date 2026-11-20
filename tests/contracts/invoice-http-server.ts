import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { InvoiceService } from "@/lib/invoices/service";
export async function invoiceHttpServer(service: InvoiceService, fault?: (req: IncomingMessage, res: ServerResponse) => boolean) {
  const requests: { method: string; url: string; authorization?: string; match?: string }[] = [];
  const server = createServer(async (req, res) => {
    requests.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization, match: req.headers["if-match"] as string });
    if (fault?.(req, res)) return;
    res.setHeader("Content-Type", "application/json");
    const fail = (status: number, code: string, fields?: unknown) => { res.statusCode = status; res.end(JSON.stringify({ error: { code, message: "[TEST] Request refused", ...(fields ? { fields } : {}) } })); };
    if (req.headers.authorization !== "Bearer unit-app-key") return fail(401, "unauthorized");
    try {
      const url = new URL(req.url!, "http://localhost"), parts = url.pathname.split("/").map(decodeURIComponent), customer = parts[3];
      let body: Record<string, unknown> = {};
      if (["POST", "PUT"].includes(req.method!)) {
        let raw = ""; for await (const chunk of req) raw += chunk;
        try { body = JSON.parse(raw); } catch { return fail(422, "invalid_request"); }
      }
      let value;
      if (parts[4] === "billing-details") value = req.method === "PUT" ? await service.saveBillingDetails(customer, body as never, req.headers["if-match"] as string ?? null) : await service.getBillingDetails(customer);
      else if (parts[4] === "invoice-requests") { const receipt = await service.requestInvoiceNow(customer, body.request_id as string, body.payment_ref as string | undefined); res.statusCode = receipt.status; value = { document: receipt.document }; }
      else if (parts[6] === "corrections") { const receipt = await service.requestBuyerCorrection(customer, parts[5], body.request_id as string); res.statusCode = receipt.status; value = { document: receipt.document }; }
      else if (parts[6] === "pdf") { const result = await service.getDocumentPdf(customer, parts[5]); res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`); return res.end(result.bytes); }
      else value = await service.listDocuments(customer, Object.fromEntries(url.searchParams));
      res.end(JSON.stringify(value));
    } catch (error) {
      const typed = error as { status?: number; code?: string; fields?: Record<string, string> };
      fail(typed.status ?? 503, typed.code ?? "unavailable", typed.fields);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
