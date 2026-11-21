import type { BillingDetails, BillingResponse, InvoiceDocument } from "./contract";
import { inCorrectionWindow } from "./calendar";
type CorrectionBlock = "pending" | "closed" | "billing_details";
export type InvoiceListItem = InvoiceDocument & { canCorrect: boolean; correctionBlock?: CorrectionBlock; corrections: InvoiceDocument[] };
export function money(minor: number, currency: string) {
  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits!;
  const scale = BigInt(10 ** digits);
  const magnitude = BigInt(Math.abs(minor));
  const whole = Number(magnitude / scale);
  const fraction = (magnitude % scale).toString().padStart(digits, "0");
  // Keep the minor units exact even when the full amount is too large for a
  // fractional JS number. Intl still supplies the currency, grouping and sign.
  return formatter.formatToParts(minor < 0 ? -whole : whole)
    .map(part => part.type === "fraction" ? fraction : part.value).join("");
}
export function invoiceDate(date: string) { return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)); }
export function buyerAddress(details: BillingDetails) { return [details.address_line1, details.address_line2, [details.postal_code, details.city].filter(Boolean).join(" "), details.country].filter(Boolean).join(", "); }
export function invoiceListItems(documents: InvoiceDocument[], canManage: boolean, now = new Date(), hasBillingDetails = true, eligibilityDocuments = documents): InvoiceListItem[] {
  const parents = new Set(documents.filter(d => d.kind === "invoice").map(d => d.id));
  const correcting = (d: InvoiceDocument, id: string) => d.kind === "correction" && d.corrects === id;
  return documents.filter(d => d.kind === "invoice" || !parents.has(d.corrects!)).map(document => {
    const corrections = document.kind === "invoice" ? documents.filter(d => correcting(d, document.id)) : [];
    if (document.kind !== "invoice" || document.status !== "issued") return { ...document, corrections, canCorrect: false };
    const correctionBlock = eligibilityDocuments.some(d => correcting(d, document.id) && d.status === "pending") ? "pending"
      : !inCorrectionWindow(document.correctable_until, now) ? "closed" : !hasBillingDetails ? "billing_details" : undefined;
    return { ...document, corrections, correctionBlock, canCorrect: canManage && !correctionBlock };
  });
}
/** The VAT ID the issuer can print for these details. It never reads an individual's: an individual is invoiced as a
 *  consumer of the saved country, whatever the field holds (the invoice service, 2026-11-21). So the form does not ask
 *  an individual for one, the save action sends none, and no screen shows one as if it would be printed. */
export function buyerTaxId(details: Pick<BillingDetails, "type" | "tax_id">) {
  return details.type === "company" ? details.tax_id : null;
}

/** Since contract 1.2.0 a correction may change anything printed, the VAT ID and the country included, but the issuer
 *  prints no VAT ID the check reports `invalid`: it books the buyer as a consumer of the saved country, the opposite of
 *  what a company asking for a correction wants. So the dialog stops a company whose saved VAT ID the check reports
 *  `invalid` and asks for the number to be fixed. A person's VAT ID is never printed, so an invalid one changes nothing
 *  for them, and a check that could not run, or does not apply, is the issuer's to decide, so those go through. */
export function savedTaxIdFailsCheck(saved: Pick<BillingDetails, "type" | "tax_id"> | null,
  check: NonNullable<BillingResponse["vies"]>["status"] | undefined) {
  return !!saved && saved.type === "company" && !!saved.tax_id?.trim() && check === "invalid";
}
// v1.1.0: "other" is a correction the issuer made by hand, outside any app
// (a cancelled VAT ID, for one).
export function correctionReason(reason: InvoiceDocument["reason"]) {
  return reason === "refund" ? "Refund" : reason === "buyer" ? "Buyer details corrected" : "Correction by the issuer";
}
export function invoicePdfHref(id: string) { return `/app/invoices/${encodeURIComponent(id)}/pdf`; }
/** The request id a write retries with, kept per document (a correction) or per payment (an invoice request).
 *  The contract lets a retry return the first answer to an id, whatever it was (`request_id`); the service as built
 *  stores only an accepted one, so a refusal or a failure is evaluated again. Either way an id is kept only while the
 *  outcome is unknown: the call never came back (`attempt`'s rejection, which carries no code) or the service could
 *  not answer (`unavailable`), when the request may have been accepted and a new id could make a second one. Any
 *  other answer is final, so the next request takes a new id: an admin who fixes what a refusal named, then asks
 *  again on the same page, must not get the refusal replayed. */
export function requestIdFor<K>(requests: Map<K, string>, key: K) {
  const id = requests.get(key) ?? crypto.randomUUID();
  requests.set(key, id);
  return id;
}
export function settleRequestId<K>(requests: Map<K, string>, key: K, result: { document?: unknown; error?: string; code?: string }) {
  const unknown = !result.document && (result.code === "unavailable" || (result.error !== undefined && result.code === undefined));
  if (!unknown) requests.delete(key);
}
