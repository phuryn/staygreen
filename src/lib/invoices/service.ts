import "server-only";
import { z } from "zod";
import { env } from "@/lib/env";
import { billingResponseSchema, conflictCodeSchema, documentResultSchema, documentsResponseSchema, errorResponseSchema, pdfBytesSchema,
  type BillingDetails, type BillingResponse, type DocumentsResponse, type InvoiceReceipt, type PdfResponse, type ListQuery, type ConflictCode } from "./contract";
export * from "./contract";

/** Method names match the operationIds Staygreen uses in the v1 OpenAPI file. */
export type InvoiceService = {
  listDocuments(customer: string, query?: ListQuery): Promise<DocumentsResponse>;
  getDocumentPdf(customer: string, documentId: string): Promise<PdfResponse>;
  getBillingDetails(customer: string): Promise<BillingResponse>;
  saveBillingDetails(customer: string, details: BillingDetails, version: string | null): Promise<BillingResponse>;
  requestBuyerCorrection(customer: string, documentId: string, requestId: string): Promise<InvoiceReceipt>;
  requestInvoiceNow(customer: string, requestId: string, paymentRef?: string): Promise<InvoiceReceipt>;
};
export class InvoiceNotFound extends Error { readonly status = 404; readonly code = "not_found"; }
export class InvoiceConflict extends Error { readonly status = 409; constructor(public code: ConflictCode) { super(code); } }
export class InvoiceValidation extends Error {
  readonly status = 422;
  constructor(public code: "invalid_fields" | "invalid_request" | "invalid_filter", public fields: Record<string, string> = {}) { super(code); }
}
export class InvoiceUnavailable extends Error {
  readonly code: string;
  constructor(public status = 503) { super("Invoices are unavailable right now. Try again in a few minutes."); this.code = status === 401 ? "unauthorized" : "unavailable"; }
}
export function parseInvoiceResponse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new InvoiceUnavailable();
  return result.data;
}
export function safePdfFilename(value: string | null): string {
  if (!value) return "invoice.pdf";
  const safe = value.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "").slice(0, 180);
  return safe && /[A-Za-z0-9]/.test(safe) ? safe : "invoice.pdf";
}
function dispositionFilename(header: string | null) {
  try {
    const encoded = header?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
    const plain = header?.match(/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
    return safePdfFilename(encoded ? decodeURIComponent(encoded.trim()) : plain?.[1] ?? plain?.[2]?.trim() ?? null);
  } catch { return "invoice.pdf"; }
}
export function createHttpInvoiceService(baseUrl: string, key: string): InvoiceService {
  const base = baseUrl.replace(/\/$/, "");
  const path = (customer: string, suffix: string) => `${base}/v1/customers/${encodeURIComponent(customer)}${suffix}`;
  async function request<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}, pdf = false): Promise<{ body: T; response: Response }> {
    try {
      const response = await fetch(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(init.method === "PUT" ? 10_000 : 5000),
        headers: { Authorization: `Bearer ${key}`, Accept: pdf ? "application/pdf" : "application/json", ...init.headers } });
      if (!response.ok) {
        if (response.status === 401) console.error("Invoice service authentication failed.");
        const { error } = parseInvoiceResponse(errorResponseSchema, await response.json());
        if (response.status === 404 && error.code === "not_found") throw new InvoiceNotFound();
        if (response.status === 409 && conflictCodeSchema.safeParse(error.code).success) throw new InvoiceConflict(error.code as ConflictCode);
        if (response.status === 422 && ["invalid_fields", "invalid_request", "invalid_filter"].includes(error.code)) throw new InvoiceValidation(error.code as InvoiceValidation["code"], error.fields);
        throw new InvoiceUnavailable(response.status);
      }
      if (response.status !== (init.method === "POST" ? 202 : 200)) throw new InvoiceUnavailable();
      // Media types are case-insensitive (RFC 9110 8.3.1): "Application/PDF" is a PDF.
      if (pdf && response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") throw new InvoiceUnavailable();
      const body = pdf ? new Uint8Array(await response.arrayBuffer()) : await response.json();
      return { body: parseInvoiceResponse(schema, body), response };
    } catch (error) {
      if (error instanceof InvoiceNotFound || error instanceof InvoiceConflict || error instanceof InvoiceValidation || error instanceof InvoiceUnavailable) throw error;
      throw new InvoiceUnavailable();
    }
  }
  return {
    async listDocuments(customer, query = {}) {
      const search = new URLSearchParams(Object.entries(query).filter((pair): pair is [string, string] => pair[1] !== undefined));
      return (await request(path(customer, `/documents${search.size ? `?${search}` : ""}`), documentsResponseSchema)).body;
    },
    async getDocumentPdf(customer, id) {
      const { body: bytes, response } = await request(path(customer, `/documents/${encodeURIComponent(id)}/pdf`), pdfBytesSchema, {}, true);
      return { bytes, filename: dispositionFilename(response.headers.get("content-disposition")) };
    },
    async getBillingDetails(customer) { return (await request(path(customer, "/billing-details"), billingResponseSchema)).body; },
    async saveBillingDetails(customer, details, version) {
      return (await request(path(customer, "/billing-details"), billingResponseSchema, { method: "PUT", headers: { "Content-Type": "application/json", ...(version === null ? {} : { "If-Match": version }) }, body: JSON.stringify(details) })).body;
    },
    async requestBuyerCorrection(customer, id, requestId) {
      return { status: 202, ...(await request(path(customer, `/documents/${encodeURIComponent(id)}/corrections`), documentResultSchema,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: requestId }) })).body };
    },
    async requestInvoiceNow(customer, requestId, paymentRef) {
      return { status: 202, ...(await request(path(customer, "/invoice-requests"), documentResultSchema,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request_id: requestId, ...(paymentRef === undefined ? {} : { payment_ref: paymentRef }) }) })).body };
    },
  };
}
const memory = globalThis as typeof globalThis & { staygreenMockInvoices?: Promise<InvoiceService> };
export async function invoiceService(): Promise<InvoiceService> {
  const config = env();
  if (config.INVOICE_SERVICE_URL === "mock") {
    // Only this guarded branch loads sample data. Production actions/routes
    // have no mock dependency. Hot reload survives; a server restart resets it.
    return memory.staygreenMockInvoices ??= import("./mock").then(({ createDevelopmentInvoiceService }) => createDevelopmentInvoiceService());
  }
  if (!config.INVOICE_SERVICE_URL || !config.INVOICE_SERVICE_KEY) throw new InvoiceUnavailable();
  return createHttpInvoiceService(config.INVOICE_SERVICE_URL, config.INVOICE_SERVICE_KEY);
}
