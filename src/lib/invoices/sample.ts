import type { BillingResponse, InvoiceDocument } from "./contract";
import { correctionDeadline, warsawDate } from "./calendar";
export { correctionDeadline, DAY } from "./calendar";
export { samplePdf } from "./mock-pdf";
export const MOCK_REFERENCE_TIME = "2026-11-16T12:00:00.000Z";
export const MOCK_INVALID_VAT_ID = "PL0000000000";
export const MOCK_UNAVAILABLE_VAT_ID = "PL9999999999";
export const SAMPLE_CURRENCY = "USD";
export type MockCustomer = { documents: InvoiceDocument[]; billing: BillingResponse };
export function emptyMockCustomer(): MockCustomer { return { documents: [], billing: { details: null, vies: null, version: null, updated_at: null } }; }
export function sampleCustomer(now = new Date(MOCK_REFERENCE_TIME)): MockCustomer {
  const buyer = { name: "Example Studio sp. z o.o.", country: "PL", tax_id: "PL5250001009" };
  const invoice = (monthsAgo: number, period: "month" | "year"): InvoiceDocument => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1)).toISOString().slice(0, 10);
    const amounts = period === "month" ? { net: 732, tax: 168, gross: 900 } : { net: 7317, tax: 1683, gross: 9000 };
    return { id: `doc_builder_${monthsAgo}`, kind: "invoice", status: "issued", number: `STG/${date.slice(0, 4)}/${date.slice(5, 7)}/001`,
      issue_date: date, payment_date: date, payment_ref: `pay_sample_${monthsAgo}`, currency: SAMPLE_CURRENCY, ...amounts,
      description: `Staygreen Builder (${period})`,
      corrects: null, reason: null, buyer: { ...buyer }, correctable_until: correctionDeadline(date) };
  };
  const invoices = [invoice(0, "month"), invoice(1, "month"), invoice(2, "year")];
  const correction = (index: number, reason: "refund" | "buyer"): InvoiceDocument => ({ ...invoices[index],
    id: `doc_${reason}_issued`, kind: "correction", status: "issued", number: `STG/${invoices[index].issue_date!.slice(0, 7).replace("-", "/")}/002`,
    corrects: invoices[index].id, reason, correctable_until: null, description: reason === "refund" ? "Refund" : "Buyer details corrected",
    // The yearly refund is partial, so this invoice can still have a buyer correction pending.
    ...(reason === "refund" ? { net: -3659, tax: -841, gross: -4500 } : { net: 168, tax: -168, gross: 0 }), buyer: { ...buyer } });
  invoices[1].buyer = { name: "Example Studio", country: "PL", tax_id: null };
  const history = [correction(2, "refund"), correction(1, "buyer")];
  invoices[0] = { ...invoices[0], status: "pending", number: null, issue_date: null, buyer: null, payment_date: warsawDate(now), correctable_until: null };
  return { documents: [...invoices, ...history], billing: { details: { type: "company", name: buyer.name, country: "PL", tax_id: buyer.tax_id,
    address_line1: "ul. Przykładowa 12", address_line2: null, postal_code: "00-001", city: "Warszawa" },
    vies: { status: "valid", checked_at: now.toISOString() }, version: "v1", updated_at: now.toISOString() } };
}
/** Exact seeded shape expected by the opt-in live contract suite, without text assumptions. */
export function contractCustomer(now = new Date(MOCK_REFERENCE_TIME)): MockCustomer {
  const seed = sampleCustomer(now), original = seed.documents.find(d => d.id === "doc_builder_2")!;
  return { documents: [original, seed.documents.find(d => d.reason === "refund")!, seed.documents[0],
    { ...original, id: "doc_buyer_pending", kind: "correction", status: "pending", number: null, issue_date: null, payment_date: null,
      net: null, tax: null, gross: null, correctable_until: null, corrects: original.id, reason: "buyer", description: "Buyer details corrected" }], billing: emptyMockCustomer().billing };
}
