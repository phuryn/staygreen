"use server";
import { z } from "zod";
import { NotAllowed } from "@/lib/authz";
import { env } from "@/lib/env";
import { assertSameOrigin, CrossOrigin } from "@/lib/request";
import { invoiceBillingCustomer } from "@/lib/invoices/access";
import { allInvoiceDocuments } from "@/lib/invoices/documents";
import { buyerTaxId, invoiceListItems, type InvoiceListItem } from "@/lib/invoices/page-model";
import { billingDetailsSchema, correctionRequestSchema, invoiceRequestSchema, filtersSchema, documentIdSchema, InvoiceConflict, InvoiceNotFound, InvoiceUnavailable, InvoiceValidation,
  invoiceService, type BillingResponse, type InvoiceDocument } from "@/lib/invoices/service";

export type InvoiceFailure = { error?: string; code?: string; fields?: Record<string, string> };
export type InvoicePageState = InvoiceFailure & { items?: InvoiceListItem[]; canManage?: boolean; billing?: BillingResponse; sample?: boolean; organization?: string };
export type BillingState = InvoiceFailure & { saved?: boolean; billing?: BillingResponse };
export type CorrectionState = InvoiceFailure & { document?: InvoiceDocument };

async function requireBillingCustomer() {
  const customer = await invoiceBillingCustomer();
  if (!customer) throw new NotAllowed("billing:manage");
  return customer;
}
// A write carries the organization its page was loaded for and is refused
// unless that is still the active organization: a switch in another tab must
// never send one organization's draft or request to another. The echoed value
// is only compared, never trusted; the customer still comes from the session.
class OrganizationChanged extends Error {}
async function requireBoundCustomer(input: unknown) {
  await assertSameOrigin();
  const customer = await requireBillingCustomer();
  const bound = z.object({ organization: z.string() }).safeParse(input);
  if (!bound.success || bound.data.organization !== customer) throw new OrganizationChanged();
  return customer;
}
const fieldMessage = (field: string, code: string) => code === "required" ? "Enter this field."
  : code === "invalid_country" ? "Choose a valid country."
  : code === "invalid_format" && field === "tax_id" ? "Check the VAT ID and its country prefix."
  : "Check this field's format and length.";
function failure(error: unknown): InvoiceFailure {
  if (error instanceof NotAllowed) return { code: "permission", error: "You do not have permission to do this in this workspace." };
  if (error instanceof CrossOrigin) return { code: "origin", error: "Reopen Invoices and try again." };
  if (error instanceof OrganizationChanged) return { code: "organization_changed", error: "Your active workspace changed. Reopen Invoices before making changes." };
  if (error instanceof InvoiceNotFound) return { code: "not_found", error: "Document not found." };
  if (error instanceof InvoiceConflict) return { code: error.code, error: error.code === "version_conflict"
    ? "These details have changed. Reload billing details before saving."
    : error.code === "correction_pending" ? "A correction is already being issued. Reload the list."
    : error.code === "not_correctable" ? "This document cannot be corrected. Reload the list."
    : error.code === "nothing_to_correct" ? "There are no saved buyer changes to apply. Reload the billing details."
    : error.code === "already_invoiced" ? "An invoice has already been issued for this payment. Reload the list."
    : error.code === "request_open" ? "An invoice request is already open. Reload the list."
    : error.code === "correction_limit" ? "This workspace has reached the yearly limit for invoice corrections. Contact support."
    : "The request conflicts with a recent change. Reload Invoices and try again." };
  if (error instanceof z.ZodError) return { code: "validation", error: "Check the highlighted fields.",
    fields: Object.fromEntries(error.issues.map(i => { const field = i.path.at(-1)?.toString() ?? "details"; return [field, fieldMessage(field, "invalid_format")]; })) };
  if (error instanceof InvoiceValidation) return { code: error.code, error: error.code === "invalid_filter" ? "Check the search filters." : "Check the highlighted fields.",
    fields: Object.fromEntries(Object.entries(error.fields).map(([field, code]) => [field, fieldMessage(field, code)])) };
  return { code: "unavailable", error: new InvoiceUnavailable().message };
}
export async function loadOrganizationInvoicePage(input: unknown = {}): Promise<InvoicePageState> {
  try {
    const customer = await requireBillingCustomer();
    const parsed = filtersSchema.safeParse(input);
    if (!parsed.success) throw new InvoiceValidation("invalid_filter");
    const filters = parsed.data, service = await invoiceService();
    // A search can hide a pending correction. Keep eligibility based on the
    // full history so filtering never exposes Correct for that original.
    const [documents, billing, eligibility] = await Promise.all([allInvoiceDocuments(service, customer, filters), service.getBillingDetails(customer),
      Object.values(filters).some(value => value !== undefined) ? allInvoiceDocuments(service, customer) : Promise.resolve(undefined)]);
    return { items: invoiceListItems(documents, true, new Date(), billing.details !== null, eligibility ?? documents), canManage: true, billing, sample: env().INVOICE_SERVICE_URL === "mock", organization: customer };
  } catch (error) { return failure(error); }
}
export async function saveInvoiceBillingDetails(input: unknown): Promise<BillingState> {
  try {
    const customer = await requireBoundCustomer(input);
    const parsed = z.object({ details: billingDetailsSchema, version: z.string().nullable() }).parse(input);
    // An individual's VAT ID is dropped here, not only hidden in the form, so a request that carries one stores none.
    const details = { ...parsed.details, tax_id: buyerTaxId(parsed.details) };
    return { saved: true, billing: await (await invoiceService()).saveBillingDetails(customer, details, parsed.version) };
  } catch (error) { return failure(error); }
}
export async function askForInvoiceCorrection(input: unknown): Promise<CorrectionState> {
  try {
    const customer = await requireBoundCustomer(input);
    const parsed = correctionRequestSchema.extend({ documentId: documentIdSchema }).parse(input);
    return { document: (await (await invoiceService()).requestBuyerCorrection(customer, parsed.documentId, parsed.request_id)).document };
  } catch (error) { return failure(error); }
}
export async function requestInvoiceNow(input: unknown): Promise<CorrectionState> {
  try {
    const customer = await requireBoundCustomer(input);
    const parsed = invoiceRequestSchema.parse(input);
    return { document: (await (await invoiceService()).requestInvoiceNow(customer, parsed.request_id, parsed.payment_ref)).document };
  } catch (error) { return failure(error); }
}
