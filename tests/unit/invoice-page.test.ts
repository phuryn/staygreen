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

  it("asks only a company for a VAT ID, and shows an individual none, as the issuer never reads one", () => {
    const render = (type: "company" | "person", editing: boolean) => renderToStaticMarkup(createElement(InvoiceBillingDetails, {
      billing: { ...billing, details: { ...billing.details!, type, tax_id: "PL7011027727" }, vies: { status: "invalid", checked_at: null } },
      organization, canManage: true, editing, onEditing: vi.fn(), onSaved: vi.fn(), onReload: vi.fn(),
    }));
    expect(render("company", true)).toContain("VAT ID (optional)");
    expect(render("company", true)).not.toContain("invoiced as a consumer");
    expect(render("person", true)).not.toContain("VAT ID (optional)");
    expect(render("person", true)).toContain("An individual is invoiced as a consumer, without a VAT ID. Buying for a business, a sole proprietorship included? Choose Company.");
    expect(render("company", false)).toContain("<dt>VAT ID</dt><dd>PL7011027727</dd>");
    expect(render("company", false)).toContain("does not list this NIP");
    expect(render("person", false)).not.toContain("PL7011027727");
    expect(render("person", false)).not.toContain("does not list this NIP");
    const dialog = renderDialog(item.buyer, { ...billing, details: { ...billing.details!, type: "person", tax_id: "PL7011027727" }, vies: { status: "valid", checked_at: null } });
    expect(dialog.split("PL7011027727").length - 1).toBe(item.buyer!.tax_id === "PL7011027727" ? 1 : 0);
    expect(dialog).toMatch(/Saved billing details<\/h3>[\s\S]*No VAT ID/);
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

  it("asks for any change since contract 1.2.0: a printed VAT ID changed or removed, and a move to another country", () => {
    const company = { ...item.buyer!, tax_id: "PL5250001009" }, consumer = { ...item.buyer!, tax_id: null };
    const elsewhere = item.buyer!.country === "DE" ? "FR" : "DE";
    const saved = (type: "company" | "person", country: string, tax_id: string | null, status: "valid" | "invalid" | "unavailable" | "not_applicable" = "valid") =>
      ({ ...billing, details: { ...billing.details!, type, country, tax_id }, vies: { status, checked_at: null } });
    for (const [printed, details] of [
      [company, saved("company", item.buyer!.country, "DE123456789")], [company, saved("company", item.buyer!.country, null)],
      [company, saved("person", elsewhere, null)], [consumer, saved("person", elsewhere, null)],
      [consumer, saved("person", elsewhere, "FR12345678901", "invalid")], [consumer, saved("company", elsewhere, "FR12345678901", "unavailable")],
      [consumer, saved("company", elsewhere, "FR12345678901", "not_applicable")], [consumer, saved("company", elsewhere, "FR12345678901")],
    ] as const) {
      const html = renderDialog(printed, details);
      expect(html).toContain("Ask for correction");
      expect(html).not.toContain('href="/support"');
      expect(html).toContain("cancels the invoice with a correction to zero instead and issues a new one for the same amount paid");
    }
  });

  it("stops a company whose saved VAT ID the check reports invalid, which the issuer would book as a consumer", () => {
    // The issuer prints no VAT ID the check reports invalid, the opposite of what the company asked for.
    const details = { ...billing, details: { ...billing.details!, type: "company" as const, tax_id: "PL5250001009" }, vies: { status: "invalid" as const, checked_at: null } };
    for (const printed of [item.buyer!, { ...item.buyer!, tax_id: null }]) {
      const html = renderDialog(printed, details);
      expect(html).not.toContain("Ask for correction");
      expect(html).toContain("The VAT check did not confirm the saved VAT ID, so the corrected invoice would be issued without it.");
      expect(html).toContain('href="/support"');
    }
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
