import { z } from "zod";

/** Runtime shapes for docs/contracts/invoice-service.v1.openapi.json (v1; the file carries the patch version).
 * No response is trusted before parsing; none of these objects carries an app/customer claim. */
export const customerSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
// v1 bounds no document id. Responses take any string; an id this app sends
// back (PDF route, correction) only has to be non-empty to reach the service.
export const documentIdSchema = z.string().min(1);
const country = z.string().regex(/^[A-Z]{2}$/);
// JSON Schema counts maxLength in characters (code points); zod's .max counts
// UTF-16 units, so an emoji at the limit would refuse a response v1 allows.
const text = (max: number, min = 0) => z.string().min(min).refine(s => [...s].length <= max, { message: `At most ${max} characters` });
// RFC 3339's date-time, which OpenAPI's format means: t and z in either case,
// a leap second, any fraction, Z or a numeric offset. zod's ISO parser refuses
// the first two; neither timestamp is displayed, so the grammar is enough.
const timestamp = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[Tt]([01]\d|2[0-3]):[0-5]\d:([0-5]\d|60)(\.\d+)?([Zz]|[+-]([01]\d|2[0-3]):[0-5]\d)$/);
// Response objects drop fields they don't know instead of refusing them: the
// list parses whole, so one refused field would make every organization's
// page unavailable (2026-11-18, the lesson of reason "other"). What Staygreen
// sends stays strict, as the service's own request schemas are.
const response = z.object;
export const buyerSchema = response({ name: z.string(), country, tax_id: z.string().nullable() });
const billingDetailsShape = {
  type: z.enum(["company", "person"]), name: text(200, 1),
  address_line1: text(200, 1), address_line2: text(200).nullable(),
  postal_code: text(20, 1), city: text(100, 1), country,
  tax_id: text(32).nullable(),
};
export const billingDetailsSchema = z.strictObject(billingDetailsShape);
export const billingResponseSchema = response({
  details: response(billingDetailsShape).nullable(),
  vies: response({ status: z.enum(["valid", "invalid", "unavailable", "not_applicable"]), checked_at: timestamp.nullable() }).nullable(),
  version: z.string().nullable(), updated_at: timestamp.nullable(),
});
export const documentSchema = response({
  id: z.string(), kind: z.enum(["invoice", "correction"]), status: z.enum(["issued", "pending"]),
  number: text(64).nullable(), issue_date: z.iso.date().nullable(), payment_date: z.iso.date().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  // The one bound v1 does not state, on purpose: JSON.parse cannot hold an
  // integer beyond 2^53 exactly, and an invoice showing a rounded amount is
  // worse than one that is unavailable.
  net: z.number().int().safe().nullable(), tax: z.number().int().safe().nullable(), gross: z.number().int().safe().nullable(),
  description: text(300).nullable(), corrects: z.string().nullable(), reason: z.enum(["refund", "buyer", "other"]).nullable(),
  payment_ref: text(128).nullable(), buyer: buyerSchema.nullable(), correctable_until: z.iso.date().nullable(),
}).superRefine((d, ctx) => {
  // Only the invariants v1 itself states. A stricter rule here turns one
  // contract-valid document into an unavailable page for every member, so
  // anything else v1 permits is handled where it is used (page-model.ts
  // offers Correct only on an issued invoice and nests only corrections).
  const invalid = (field: string) => ctx.addIssue({ code: "custom", path: [field], message: "Invalid document state" });
  if (d.status === "issued") for (const field of ["number", "issue_date", "net", "tax", "gross"] as const) if (d[field] === null) invalid(field);
  if (d.kind === "correction") { if (d.corrects === null) invalid("corrects"); if (d.reason === null) invalid("reason"); }
});
export const documentsResponseSchema = response({ documents: z.array(documentSchema).max(50), next_cursor: z.string().nullable() });
export const documentResultSchema = response({ document: documentSchema });
export const correctionRequestSchema = z.object({ request_id: z.uuid() });
export const invoiceRequestSchema = correctionRequestSchema.extend({ payment_ref: text(128).optional() });
export const filtersSchema = z.object({ number: text(64).optional(), from: z.iso.date().optional(), to: z.iso.date().optional(), kind: z.enum(["invoice", "correction"]).optional() });
export const listQuerySchema = filtersSchema.extend({ cursor: z.string().optional() });
export const conflictCodeSchema = z.enum(["version_conflict", "nothing_to_correct", "correction_pending", "not_correctable", "pending", "already_invoiced", "request_open"]);
// Unknown future field codes deliberately retain the generic field message;
// the three v1 codes are covered by contract tests rather than discarded.
export const errorResponseSchema = response({ error: z.object({ code: z.string(), message: z.string(), fields: z.record(z.string(), z.string()).optional() }) });
export const pdfBytesSchema = z.custom<Uint8Array>(value => value instanceof Uint8Array && value.length > 20
  && new TextDecoder().decode(value.subarray(0, 5)) === "%PDF-"
  && new TextDecoder().decode(value.subarray(-1024)).trimEnd().endsWith("%%EOF"), "Expected PDF bytes");
export const pdfResponseSchema = z.object({ bytes: pdfBytesSchema, filename: z.string().min(1) });
export type InvoiceDocument = z.infer<typeof documentSchema>;
export type BillingDetails = z.infer<typeof billingDetailsSchema>;
export type BillingResponse = z.infer<typeof billingResponseSchema>;
export type DocumentsResponse = z.infer<typeof documentsResponseSchema>;
export type DocumentResult = z.infer<typeof documentResultSchema>;
export type InvoiceReceipt = DocumentResult & { status: 202 };
export type PdfResponse = z.infer<typeof pdfResponseSchema>;
export type InvoiceFilters = z.infer<typeof filtersSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type Buyer = z.infer<typeof buyerSchema>;
export type ConflictCode = z.infer<typeof conflictCodeSchema>;
