import "server-only";
import { InvoiceUnavailable, type InvoiceDocument, type InvoiceService, type InvoiceFilters } from "./service";
/** Gather result pages so related rows can be grouped. A filtered correction
 * whose original is outside the results remains visible as its own row. */
export async function allInvoiceDocuments(service: InvoiceService, customer: string, filters: InvoiceFilters = {}): Promise<InvoiceDocument[]> {
  const documents: InvoiceDocument[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 200; page++) {
    const result = await service.listDocuments(customer, { ...filters, ...(cursor === undefined ? {} : { cursor }) });
    documents.push(...result.documents);
    if (result.next_cursor === null) return [...new Map(documents.map(d => [d.id, d])).values()];
    cursor = result.next_cursor;
    if (seen.has(cursor)) throw new InvoiceUnavailable(); seen.add(cursor);
  }
  throw new InvoiceUnavailable();
}
