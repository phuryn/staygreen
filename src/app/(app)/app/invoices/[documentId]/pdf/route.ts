import { invoiceBillingCustomer } from "@/lib/invoices/access";
import { documentIdSchema, invoiceService, InvoiceConflict, InvoiceNotFound, safePdfFilename } from "@/lib/invoices/service";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const notFound = () => new Response("Document not found.", { status: 404, headers });

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    const { documentId } = await params;
    if (!documentIdSchema.safeParse(documentId).success) return notFound();
    const customer = await invoiceBillingCustomer();
    if (!customer) return notFound();
    const { bytes, filename: suppliedFilename } = await (await invoiceService()).getDocumentPdf(customer, documentId);
    const filename = safePdfFilename(suppliedFilename);
    return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"` } });
  } catch (error) {
    if (error instanceof InvoiceNotFound || error instanceof InvoiceConflict && error.code === "pending") return notFound();
    return new Response("Invoices are unavailable right now. Try again in a few minutes.", { status: 503, headers });
  }
}
