import "server-only";
import { randomUUID } from "node:crypto";
import { billingDetailsSchema, billingResponseSchema, correctionRequestSchema, documentSchema, documentResultSchema, documentsResponseSchema, customerSchema, invoiceRequestSchema, listQuerySchema,
  type BillingDetails, type BillingResponse, type InvoiceReceipt } from "./contract";
import { InvoiceNotFound, InvoiceConflict, InvoiceValidation, parseInvoiceResponse, type InvoiceService } from "./service";
import { sampleCustomer, samplePdf, emptyMockCustomer, SAMPLE_CURRENCY, MOCK_INVALID_VAT_ID, MOCK_UNAVAILABLE_VAT_ID, type MockCustomer } from "./sample";
import { inCorrectionWindow } from "./calendar";
import { BILLING_COUNTRIES } from "./countries";
const EU = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split(" "));
export function mockVies(details: BillingDetails, at: string): NonNullable<BillingResponse["vies"]> {
  if (!EU.has(details.country) || !details.tax_id) return { status: "not_applicable", checked_at: null };
  const prefix = details.country === "GR" ? "EL" : details.country;
  if (!new RegExp(`^${prefix}[A-Z0-9]{8,12}$`).test(details.tax_id)) throw new InvoiceValidation("invalid_fields", { tax_id: "invalid_format" });
  return { status: details.tax_id === MOCK_INVALID_VAT_ID ? "invalid" : details.tax_id === MOCK_UNAVAILABLE_VAT_ID ? "unavailable" : "valid", checked_at: at };
}
/** Contract 1.2.0's yearly cap on buyer-correction requests per customer. */
export const CORRECTION_LIMIT = 50;
/** No timers or issuance. This sample state lives in memory and resets on restart.
 * Tests supply independent fixture customers, including issued states. */
export function createMockInvoiceService(options: { customers?: Record<string, MockCustomer>; seed?: (customer: string) => MockCustomer; now?: () => Date } = {}): InvoiceService {
  const customers = new Map<string, MockCustomer & { requests: Map<string, InvoiceReceipt>; expedited: Set<string>; corrections: number[] }>();
  const now = options.now ?? (() => new Date());
  function state(customer: string) {
    if (!customerSchema.safeParse(customer).success) throw new InvoiceNotFound();
    if (!customers.has(customer)) {
      const initial = options.customers
        ? Object.hasOwn(options.customers, customer) ? options.customers[customer] : emptyMockCustomer()
        : (options.seed ?? emptyMockCustomer)(customer);
      const seed = structuredClone(initial);
      seed.documents.forEach(d => parseInvoiceResponse(documentSchema, d)); parseInvoiceResponse(billingResponseSchema, seed.billing);
      customers.set(customer, { ...seed, requests: new Map(), expedited: new Set(), corrections: [] });
    }
    return customers.get(customer)!;
  }
  const receipt = (document: unknown): InvoiceReceipt => ({ status: 202, ...parseInvoiceResponse(documentResultSchema, { document }) });
  return {
    async listDocuments(customer, input = {}) {
      const s = state(customer), parsed = listQuerySchema.safeParse(input);
      if (!parsed.success) throw new InvoiceValidation("invalid_filter");
      const { cursor, ...filters } = parsed.data;
      const filtered = s.documents.filter(d => {
        const date = d.status === "issued" ? d.issue_date : d.payment_date;
        return (filters.number === undefined || !!d.number?.startsWith(filters.number)) && (!filters.kind || d.kind === filters.kind)
          && (!filters.from || !!date && date >= filters.from) && (!filters.to || !!date && date <= filters.to);
      }).sort((a, b) => (b.issue_date ?? b.payment_date ?? "9999").localeCompare(a.issue_date ?? a.payment_date ?? "9999") || b.id.localeCompare(a.id));
      const offset = cursor === undefined ? 0 : filtered.findIndex(d => d.id === cursor) + 1;
      if (cursor !== undefined && !offset) throw new InvoiceValidation("invalid_filter");
      const documents = filtered.slice(offset, offset + 50);
      return parseInvoiceResponse(documentsResponseSchema, structuredClone({ documents, next_cursor: filtered.length > offset + 50 ? documents.at(-1)!.id : null }));
    },
    async getDocumentPdf(customer, id) {
      const document = state(customer).documents.find(d => d.id === id);
      if (!document) throw new InvoiceNotFound(); if (document.status === "pending") throw new InvoiceConflict("pending");
      return { bytes: samplePdf(document), filename: `${document.number!.replace(/[^A-Za-z0-9_.-]/g, "_")}.pdf` };
    },
    async getBillingDetails(customer) { return parseInvoiceResponse(billingResponseSchema, structuredClone(state(customer).billing)); },
    async saveBillingDetails(customer, input, version) {
      const s = state(customer);
      if (s.billing.version !== version) throw new InvoiceConflict("version_conflict");
      const parsed = billingDetailsSchema.safeParse(input);
      if (!parsed.success) throw new InvoiceValidation("invalid_fields", Object.fromEntries(parsed.error.issues.map(i => [String(i.path[0]), i.path[0] === "country" ? "invalid_country" : i.code === "too_small" ? "required" : "invalid_format"])));
      if (!BILLING_COUNTRIES.includes(parsed.data.country)) throw new InvoiceValidation("invalid_fields", { country: "invalid_country" });
      const at = now().toISOString(), vies = mockVies(parsed.data, at);
      s.billing = parseInvoiceResponse(billingResponseSchema, { details: parsed.data, vies, version: randomUUID(), updated_at: at });
      return structuredClone(s.billing);
    },
    async requestBuyerCorrection(customer, id, requestId) {
      const s = state(customer);
      if (!correctionRequestSchema.safeParse({ request_id: requestId }).success) throw new InvoiceValidation("invalid_request", { request_id: "invalid_format" });
      const prior = s.requests.get(requestId); if (prior) return structuredClone(prior);
      const original = s.documents.find(d => d.id === id); if (!original) throw new InvoiceNotFound();
      if (original.kind !== "invoice" || original.status !== "issued" || !inCorrectionWindow(original.correctable_until, now())) throw new InvoiceConflict("not_correctable");
      const details = s.billing.details;
      // v1.2.0: when several apply, not_correctable, then correction_pending, then nothing_to_correct, then
      // correction_limit (50 accepted buyer-correction requests in the last 12 months; refusals and replays don't count).
      if (s.documents.some(d => d.corrects === id && d.status === "pending")) throw new InvoiceConflict("correction_pending");
      if (!details || original.buyer && ["name", "country", "tax_id"].every(key => original.buyer![key as keyof typeof original.buyer] === details[key as keyof BillingDetails])) throw new InvoiceConflict("nothing_to_correct");
      // Counts only the requests this instance accepted, not a fixture's seeded corrections: no fixture holds anywhere
      // near 50, and the cap's own test starts from none.
      const yearAgo = new Date(now()); yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
      if (s.corrections.filter(at => at > yearAgo.getTime()).length >= CORRECTION_LIMIT) throw new InvoiceConflict("correction_limit");
      const result = receipt({ ...original, id: `doc_${randomUUID()}`, kind: "correction", status: "pending", number: null,
        corrects: id, reason: "buyer", correctable_until: null, description: "Buyer details corrected", issue_date: null, payment_date: null,
        buyer: { name: details.name, country: details.country, tax_id: details.tax_id }, net: null, tax: null, gross: null });
      s.documents.push(structuredClone(result.document)); s.requests.set(requestId, structuredClone(result)); s.corrections.push(now().getTime());
      return structuredClone(result);
    },
    async requestInvoiceNow(customer, requestId, paymentRef) {
      const s = state(customer);
      if (!correctionRequestSchema.safeParse({ request_id: requestId }).success) throw new InvoiceValidation("invalid_request", { request_id: "invalid_format" });
      const prior = s.requests.get(requestId); if (prior) return structuredClone(prior);
      if (!invoiceRequestSchema.safeParse({ request_id: requestId, ...(paymentRef === undefined ? {} : { payment_ref: paymentRef }) }).success) throw new InvoiceValidation("invalid_request");
      if (paymentRef !== undefined) {
        const document = s.documents.find(d => d.kind === "invoice" && d.payment_ref === paymentRef);
        if (!document) throw new InvoiceNotFound(); if (document.status === "issued") throw new InvoiceConflict("already_invoiced");
        if (s.expedited.has(paymentRef)) throw new InvoiceConflict("request_open");
        const result = receipt(document); s.expedited.add(paymentRef); s.requests.set(requestId, structuredClone(result)); return structuredClone(result);
      }
      if (s.documents.some(d => d.kind === "invoice" && d.status === "pending" && d.payment_ref === null)) throw new InvoiceConflict("request_open");
      const result = receipt({ id: `doc_${randomUUID()}`, kind: "invoice", status: "pending", number: null, issue_date: null, payment_date: null,
        currency: SAMPLE_CURRENCY, net: null, tax: null, gross: null, description: null, corrects: null, reason: null, payment_ref: null, buyer: null, correctable_until: null });
      s.documents.unshift(structuredClone(result.document)); s.requests.set(requestId, structuredClone(result)); return structuredClone(result);
    },
  };
}
export function createDevelopmentInvoiceService() { return createMockInvoiceService({ seed: () => sampleCustomer(new Date()) }); }
