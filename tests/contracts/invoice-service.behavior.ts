import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { billingResponseSchema, documentResultSchema, documentsResponseSchema, pdfResponseSchema } from "@/lib/invoices/contract";
import type { InvoiceService, InvoiceDocument } from "@/lib/invoices/service";
export const CONTRACT_CUSTOMER = "staygreen-contract-test";
/** This identical consumer suite runs against the memory implementation, the
 * local HTTP implementation, and (only by explicit command) a live deployment.
 * Live fixture text is intentionally never asserted. Reset the customer between runs. */
export function invoiceServiceBehavior(label: string, factory: () => InvoiceService | Promise<InvoiceService>) {
  describe.sequential(label, () => {
    let service: InvoiceService, original: InvoiceDocument, pending: InvoiceDocument, refund: InvoiceDocument;
    beforeAll(async () => {
      service = await factory();
      const page = await service.listDocuments(CONTRACT_CUSTOMER);
      expect(documentsResponseSchema.safeParse(page).success).toBe(true);
      original = page.documents.find(d => d.kind === "invoice" && d.status === "issued")!;
      pending = page.documents.find(d => d.kind === "invoice" && d.status === "pending" && d.payment_ref !== null)!;
      refund = page.documents.find(d => d.kind === "correction" && d.reason === "refund" && d.status === "issued")!;
      expect(original).toBeDefined(); expect(pending).toBeDefined(); expect(refund).toBeDefined();
      // This reference is needed to exercise already_invoiced without guessing
      // an opaque payment ID. Fail clearly if the live fixture omits it.
      expect(original.payment_ref, "Issued contract fixture needs payment_ref for already_invoiced").not.toBeNull();
      expect(refund.corrects).toBe(original.id);
      expect(page.documents.some(d => d.kind === "correction" && d.status === "pending" && d.corrects === original.id)).toBe(true);
      expect(await service.getBillingDetails(CONTRACT_CUSTOMER)).toEqual({ details: null, vies: null, version: null, updated_at: null });
    });
    it("reads the required fixture, both issued PDFs, and a well-formed unknown customer's empty state", async () => {
      for (const document of [original, refund]) expect(pdfResponseSchema.safeParse(await service.getDocumentPdf(CONTRACT_CUSTOMER, document.id)).success).toBe(true);
      expect((await service.listDocuments(`${CONTRACT_CUSTOMER}-unknown`)).documents).toEqual([]);
      expect(await service.getBillingDetails(`${CONTRACT_CUSTOMER}-unknown`)).toEqual({ details: null, vies: null, version: null, updated_at: null });
      await expect(service.getDocumentPdf(`${CONTRACT_CUSTOMER}-unknown`, original.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
      await expect(service.getDocumentPdf(CONTRACT_CUSTOMER, pending.id)).rejects.toMatchObject({ status: 409, code: "pending" });
      await expect(service.getDocumentPdf(CONTRACT_CUSTOMER, "doc_unknown_contract_fixture")).rejects.toMatchObject({ status: 404, code: "not_found" });
      await expect(service.listDocuments("malformed.customer")).rejects.toMatchObject({ status: 404, code: "not_found" });
    });
    it("combines number prefix, kind and inclusive payment/issue-date filters", async () => {
      const number = original.number!, prefix = number.slice(0, Math.max(1, number.length - 1));
      expect((await service.listDocuments(CONTRACT_CUSTOMER, { number })).documents.some(d => d.id === original.id)).toBe(true);
      expect((await service.listDocuments(CONTRACT_CUSTOMER, { number: prefix, kind: "invoice" })).documents.every(d => d.kind === "invoice" && d.number?.startsWith(prefix))).toBe(true);
      const date = pending.payment_date ?? original.issue_date!;
      const page = await service.listDocuments(CONTRACT_CUSTOMER, { from: date, to: date, kind: "invoice" });
      expect(page.documents.some(d => d.id === pending.id)).toBe(pending.payment_date !== null);
      const issuedPage = await service.listDocuments(CONTRACT_CUSTOMER, { from: original.issue_date!, to: original.issue_date!, kind: "invoice" });
      expect(issuedPage.documents.some(d => d.id === original.id)).toBe(true);
      expect((await service.listDocuments(CONTRACT_CUSTOMER, { kind: "correction" })).documents.every(d => d.kind === "correction")).toBe(true);
      await expect(service.listDocuments(CONTRACT_CUSTOMER, { from: "not-a-date" })).rejects.toMatchObject({ status: 422, code: "invalid_filter" });
    });
    it("refuses malformed requests, missing details and non-correctable documents with v1 codes", async () => {
      // The fixture holds a pending buyer correction, which v1.0.4 answers before nothing_to_correct.
      await expect(service.requestBuyerCorrection(CONTRACT_CUSTOMER, original.id, randomUUID())).rejects.toMatchObject({ status: 409, code: "correction_pending" });
      for (const id of [pending.id, refund.id]) await expect(service.requestBuyerCorrection(CONTRACT_CUSTOMER, id, randomUUID())).rejects.toMatchObject({ status: 409, code: "not_correctable" });
      await expect(service.requestBuyerCorrection(CONTRACT_CUSTOMER, original.id, "invalid")).rejects.toMatchObject({ status: 422, code: "invalid_request" });
      await expect(service.requestInvoiceNow(CONTRACT_CUSTOMER, "invalid")).rejects.toMatchObject({ status: 422, code: "invalid_request" });
      await expect(service.requestInvoiceNow(CONTRACT_CUSTOMER, randomUUID(), "x".repeat(129))).rejects.toMatchObject({ status: 422, code: "invalid_request" });
    });
    it("creates billing without If-Match, updates with its version and detects conflicts and fields", async () => {
      const details = { type: "company" as const, name: `${original.buyer?.name ?? "[TEST] Contract buyer"} updated`.slice(0, 200), address_line1: "[TEST] Contract street 1", address_line2: null,
        postal_code: "00-001", city: "[TEST] City", country: "PL", tax_id: null };
      await expect(service.saveBillingDetails(CONTRACT_CUSTOMER, { ...details, name: "" }, null)).rejects.toMatchObject({ status: 422, code: "invalid_fields", fields: { name: "required" } });
      await expect(service.saveBillingDetails(CONTRACT_CUSTOMER, { ...details, tax_id: "x".repeat(33) }, null)).rejects.toMatchObject({ status: 422, code: "invalid_fields", fields: { tax_id: "invalid_format" } });
      await expect(service.saveBillingDetails(CONTRACT_CUSTOMER, { ...details, country: "ZZ" }, null)).rejects.toMatchObject({ status: 422, code: "invalid_fields", fields: { country: "invalid_country" } });
      const first = await service.saveBillingDetails(CONTRACT_CUSTOMER, details, null);
      expect(billingResponseSchema.safeParse(first).success).toBe(true); expect(first.version).not.toBeNull();
      await expect(service.saveBillingDetails(CONTRACT_CUSTOMER, details, null)).rejects.toMatchObject({ status: 409, code: "version_conflict" });
      const next = await service.saveBillingDetails(CONTRACT_CUSTOMER, details, first.version);
      expect(next.version).not.toBe(first.version);
      await expect(service.saveBillingDetails(CONTRACT_CUSTOMER, details, first.version)).rejects.toMatchObject({ status: 409, code: "version_conflict" });
      await expect(service.requestBuyerCorrection(CONTRACT_CUSTOMER, original.id, randomUUID())).rejects.toMatchObject({ status: 409, code: "correction_pending" });
    });
    it("expedites the listed pending document and replays the first 202 body unchanged across operations", async () => {
      const key = randomUUID(), first = await service.requestInvoiceNow(CONTRACT_CUSTOMER, key, pending.payment_ref!);
      expect(first.status).toBe(202); expect(documentResultSchema.safeParse({ document: first.document }).success).toBe(true);
      expect(first.document.id).toBe(pending.id);
      expect(await service.requestInvoiceNow(CONTRACT_CUSTOMER, key, original.payment_ref!)).toEqual(first);
      expect(await service.requestBuyerCorrection(CONTRACT_CUSTOMER, original.id, key)).toEqual(first);
      await expect(service.requestInvoiceNow(CONTRACT_CUSTOMER, randomUUID(), pending.payment_ref!)).rejects.toMatchObject({ status: 409, code: "request_open" });
      await expect(service.requestInvoiceNow(CONTRACT_CUSTOMER, randomUUID(), original.payment_ref!)).rejects.toMatchObject({ status: 409, code: "already_invoiced" });
      await expect(service.requestInvoiceNow(CONTRACT_CUSTOMER, randomUUID(), "unknown_contract_payment")).rejects.toMatchObject({ status: 404, code: "not_found" });
    });
    it("opens a missing-invoice request without inventing dates or amounts and keeps its replay", async () => {
      const key = randomUUID(), first = await service.requestInvoiceNow(CONTRACT_CUSTOMER, key);
      expect(first.status).toBe(202);
      expect(first.document).toMatchObject({ kind: "invoice", status: "pending", issue_date: null, payment_date: null, number: null, net: null, tax: null, gross: null, description: null });
      expect(await service.requestInvoiceNow(CONTRACT_CUSTOMER, key, pending.payment_ref!)).toEqual(first);
      await expect(service.requestInvoiceNow(CONTRACT_CUSTOMER, randomUUID())).rejects.toMatchObject({ status: 409, code: "request_open" });
      expect((await service.listDocuments(CONTRACT_CUSTOMER)).documents.find(d => d.id === first.document.id)?.status).toBe("pending");
    });
  });
}
