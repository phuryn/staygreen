import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { billingDraft, InvoiceBillingDetails, ViesMessage } from "@/components/invoices/InvoiceBillingDetails";
import { InvoiceCorrectionDialog } from "@/components/invoices/InvoiceCorrectionDialog";
import { InvoiceList } from "@/components/invoices/InvoiceList";
import { Invoices, settleInvoicePage } from "@/components/invoices/Invoices";
import { readFileSync } from "node:fs";
import { UNREACHABLE } from "@/lib/action-call";
import { invoiceListItems, invoicePdfHref, money, requestIdFor, settleRequestId } from "@/lib/invoices/page-model";
import { emptyMockCustomer, MOCK_REFERENCE_TIME, sampleCustomer } from "@/lib/invoices/sample";

vi.mock("@/app/invoice-page-actions", () => ({
  loadOrganizationInvoicePage: vi.fn(), saveInvoiceBillingDetails: vi.fn(),
  askForInvoiceCorrection: vi.fn(), requestInvoiceNow: vi.fn(),
}));

const now = new Date(MOCK_REFERENCE_TIME);
const { documents, billing } = sampleCustomer();
const pending = documents.find(d => d.status === "pending")!;
const original = documents.find(d => d.kind === "invoice" && d.status === "issued")!;
const item = invoiceListItems([original], true, now)[0];
const organization = "org_a";
const renderList = (items = invoiceListItems(documents, true, now), filters = {}, canManage = true) =>
  renderToStaticMarkup(createElement(InvoiceList, { items, filters, busy: false, editing: false, organization, canManage, requests: new Map(), onLoad: vi.fn(), onCorrect: vi.fn() }));
const renderDialog = (buyer = item.buyer, saved = billing) =>
  renderToStaticMarkup(createElement(InvoiceCorrectionDialog, { item: { ...item, buyer }, billing: saved, organization, requests: new Map(), onClose: vi.fn() }));

describe("invoice page state", () => {
  it("starts with its own title and a loading state under each section", () => {
    const markup = renderToStaticMarkup(createElement(Invoices, { organization }));
    expect(markup).toMatch(/^<div class="profile-page"><h1 class="profile-title">Invoices<\/h1>/);
    expect(markup).toContain("Loading billing details");
    expect(markup).toContain("Loading invoices");
  });

  it("keeps loaded details and history when refresh or search fails, and clears them when access is lost", () => {
    const shown = { items: [item], billing, organization, canManage: true };
    for (const code of ["unavailable", "invalid_filter", undefined]) {
      const failure = { code, error: "Try again." };
      expect(settleInvoicePage(shown, failure)).toEqual({ ...shown, ...failure });
      expect(settleInvoicePage({}, failure)).toBe(failure);
    }
    for (const code of ["permission", "organization_changed"]) {
      const failure = { code, error: "Reopen Invoices." };
      expect(settleInvoicePage(shown, failure)).toBe(failure);
    }
  });

  it("takes the draft, version and workspace together at the start of editing", () => {
    const draft = billingDraft(billing, organization);
    const refreshed = { ...billing, details: { ...billing.details!, name: "Second save" }, version: "v2" };
    expect(draft).toEqual({ details: billing.details, version: "v1", organization });
    expect(billingDraft(refreshed, "org_b")).toEqual({ details: refreshed.details, version: "v2", organization: "org_b" });
    expect(billingDraft(emptyMockCustomer().billing, organization)).toMatchObject({ version: null, details: { name: "", tax_id: null } });
  });
});

describe("claims from the invoice service", () => {
  it("formats exact minor units, including negative sub-units and the largest safe amount", () => {
    expect(money(-1, "USD")).toBe("-$0.01");
    expect(money(Number.MAX_SAFE_INTEGER, "USD")).toBe("$90,071,992,547,409.91");
    expect(money(123, "JPY")).toBe("¥123");
    expect(money(123, "KWD")).toBe("KWD 0.123");
  });
  it("distinguishes empty history, empty search and unsaved billing details", () => {
    expect(renderList([])).toContain("No invoices yet");
    expect(renderList([], { number: "no match" })).toContain("No documents match");
    expect(renderList([], {}, false)).not.toContain("Missing an invoice?");
    const html = renderToStaticMarkup(createElement(InvoiceBillingDetails, {
      billing: emptyMockCustomer().billing, organization, canManage: true, editing: false, onEditing: vi.fn(), onSaved: vi.fn(), onReload: vi.fn(),
    }));
    expect(html).toContain("No billing details saved yet.");
    expect(html).toContain("Add billing details");
  });

  it.each([
    ["valid", "VAT ID confirmed in VIES.", "lists this NIP as an active or exempt VAT payer."],
    ["invalid", "VIES did not confirm this VAT ID.", "does not list this NIP as an active or exempt VAT payer."],
    ["unavailable", "VIES was unavailable.", "White List was unavailable. The NIP could not be checked."],
    ["not_applicable", "VIES does not apply", "No VAT ID check applies to these details."],
  ] as const)("names the registry that gave the status %s: the White List for Poland, VIES elsewhere", (status, vies, whiteList) => {
    const render = (country: string | undefined) => renderToStaticMarkup(createElement(ViesMessage, { vies: { status, checked_at: null }, country }));
    for (const country of ["DE", undefined]) { expect(render(country)).toContain(vies); expect(render(country)).not.toContain("White List"); }
    expect(render("PL")).toContain(whiteList);
    expect(render("PL")).not.toContain("VIES");
    expect(renderToStaticMarkup(createElement(ViesMessage, { vies: null, country: "PL" }))).toBe("");
  });

  it("shows the paid date while pending, leaves an undated request undated and links only issued PDFs", () => {
    const requested = { ...pending, id: "requested", payment_date: null, payment_ref: null, gross: null };
    const html = renderList(invoiceListItems([pending, requested, original], true, now));
    expect(html).toContain("Paid 16 Nov 2026");
    expect(html).toContain("Being issued");
    expect(html).toContain("Invoice requested");
    expect(html).toContain("Issue now");
    expect(html).toContain("ask the issuer");
    expect(html).toContain(invoicePdfHref(original.id));
    expect(html).not.toContain(invoicePdfHref(pending.id));
    expect(html).not.toContain(invoicePdfHref(requested.id));
  });

  it("keeps corrections without their originals and displays their amounts as changes", () => {
    const items = invoiceListItems(documents.filter(d => d.kind === "correction"), true, now);
    expect(items).toHaveLength(2);
    const html = renderList(items);
    expect(html).toContain("Refund");
    expect(html).toContain("Corrects another invoice");
    expect(html).toContain("Change");
    expect(html).toContain("-$45.00");
    expect(html).toContain("$0.00");
    expect(html).not.toContain('aria-label="Correct ');
  });

  it("explains a blocked correction and uses the inclusive Warsaw deadline", () => {
    const due = { ...original, correctable_until: "2026-11-16" };
    const before = new Date("2026-11-16T22:59:59Z");
    const after = new Date("2026-11-16T23:00:00Z");
    expect(renderList(invoiceListItems([due], true, before))).toContain('aria-label="Correct ');
    expect(renderList(invoiceListItems([due], false, before), {}, false)).not.toContain('aria-label="Correct ');
    expect(renderList(invoiceListItems([due], true, after))).toContain("Correction window closed.");
    expect(renderList(invoiceListItems([due], true, before, false))).toContain("Save billing details to correct this invoice.");
    const correcting = { ...documents.find(d => d.kind === "correction")!, status: "pending" as const, corrects: due.id };
    const filtered = invoiceListItems([due], true, before, true, [due, correcting]);
    expect(filtered[0]).toMatchObject({ canCorrect: false, correctionBlock: "pending", corrections: [] });
    expect(renderList(filtered)).toContain("Correction being issued");
    expect(renderList(filtered)).not.toContain('aria-label="Correct ');
  });

  it("lets a correction add a VAT ID or retain it, and directs changes or removal to support", () => {
    for (const tax_id of [null, "PL5250001009", "pl 525-000.1009"]) {
      expect(renderDialog({ ...item.buyer!, tax_id })).toContain("Ask for correction");
    }
    for (const tax_id of [null, "DE123456789"]) {
      const html = renderDialog({ ...item.buyer!, tax_id: "PL5250001009" }, { ...billing, details: { ...billing.details!, tax_id } });
      expect(html).not.toContain("Ask for correction");
      expect(html).toContain("Changing or removing a printed VAT ID");
      expect(html).toContain('href="/support"');
    }
  });

  it("sends a consumer's move to another country to support, which the issuer would reject as country_change", () => {
    const consumer = { ...item.buyer!, tax_id: null };
    const saved = (country: string, tax_id: string | null) => ({ ...billing, details: { ...billing.details!, country, tax_id } });
    const moved = renderDialog(consumer, saved(consumer.country === "DE" ? "FR" : "DE", null));
    expect(moved).not.toContain("Ask for correction");
    expect(moved).toContain("Moving an invoice without a VAT ID to another country");
    expect(moved).toContain('href="/support"');
    // The same country, or a VAT ID on either side, leaves the decision to the issuer.
    expect(renderDialog(consumer, saved(consumer.country, null))).toContain("Ask for correction");
    expect(renderDialog(consumer, saved(consumer.country === "DE" ? "FR" : "DE", "FR12345678901"))).toContain("Ask for correction");
  });

  it("also sends a move to another country to support when the corrected invoice would print no VAT ID either", () => {
    // Since the issuer's release of 2026-11-20 it refuses these as country_change too: an individual's typed VAT ID,
    // and one the tax ID check reports invalid. A company's VAT ID the check could not reach is still the issuer's call.
    const consumer = { ...item.buyer!, tax_id: null };
    const elsewhere = consumer.country === "DE" ? "FR" : "DE", taxId = elsewhere === "DE" ? "DE123456789" : "FR12345678901";
    const saved = (type: "company" | "person", status: "valid" | "invalid" | "unavailable") =>
      ({ ...billing, details: { ...billing.details!, type, country: elsewhere, tax_id: taxId }, vies: { status, checked_at: null } });
    for (const [type, status] of [["person", "valid"], ["person", "unavailable"], ["company", "invalid"]] as const) {
      const html = renderDialog(consumer, saved(type, status));
      expect([type, status, html.includes("Ask for correction")]).toEqual([type, status, false]);
      expect(html).toContain("Moving an invoice without a VAT ID to another country");
    }
    for (const status of ["valid", "unavailable"] as const) expect(renderDialog(consumer, saved("company", status))).toContain("Ask for correction");
  });
});

describe("the request id a correction or an invoice request retries with", () => {
  // The contract says a retry returns the first answer to an id, whatever it was; the service as built stores
  // only an accepted one. Review round 1 (2026-11-18): under the contract's reading, an admin refused with
  // nothing_to_correct fixed the billing details, asked again on the same page, and got the refusal replayed,
  // because the id was retired only when a document came back. The policy below is right under both readings.
  const kept = (result: Parameters<typeof settleRequestId>[2]) => {
    const requests = new Map<string, string>();
    const id = requestIdFor(requests, "doc");
    settleRequestId(requests, "doc", result);
    return requestIdFor(requests, "doc") === id;
  };

  it("is kept while the outcome is unknown, so a retry cannot create a second request", () => {
    expect(kept({ error: UNREACHABLE })).toBe(true);
    expect(kept({ code: "unavailable", error: "The invoice service is unavailable." })).toBe(true);
  });

  it("is retired by any final answer, so the next request is a new one", () => {
    expect(kept({ document: original })).toBe(false);
    for (const code of ["nothing_to_correct", "not_correctable", "correction_pending", "already_invoiced", "request_open", "not_found",
      "validation", "permission", "origin", "organization_changed"]) expect(kept({ code, error: "refused" }), code).toBe(false);
  });

  it("is the one policy both write controls use", () => {
    for (const file of ["InvoiceCorrectionDialog.tsx", "InvoiceList.tsx"]) {
      const source = readFileSync(new URL(`../../src/components/invoices/${file}`, import.meta.url), "utf8");
      expect(source, file).toContain("requestIdFor(requests,");
      expect(source, file).toContain("settleRequestId(requests,");
      expect(source, file).not.toMatch(/requests\.(get|set|delete)\(/);
    }
  });
});
