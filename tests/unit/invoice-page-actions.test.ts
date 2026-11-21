import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askForInvoiceCorrection, loadOrganizationInvoicePage, requestInvoiceNow, saveInvoiceBillingDetails } from "@/app/invoice-page-actions";
import { GET } from "@/app/(app)/app/invoices/[documentId]/pdf/route";
import { createMockInvoiceService } from "@/lib/invoices/mock";
import { invoicePdfHref } from "@/lib/invoices/page-model";
import { MOCK_REFERENCE_TIME, sampleCustomer } from "@/lib/invoices/sample";
import { InvoiceConflict, InvoiceUnavailable, InvoiceValidation } from "@/lib/invoices/service";

const doubles = vi.hoisted(() => ({ member: vi.fn(), headers: vi.fn(), invoiceService: vi.fn(), url: "mock" as string | undefined }));
vi.mock("@/lib/workspace", async () => ({
  memberOrNull: doubles.member,
  allowed: (await import("@/lib/authz")).hasPermission,
}));
vi.mock("next/headers", () => ({ headers: doubles.headers }));
vi.mock("@/lib/env", () => ({ env: () => ({ INVOICE_SERVICE_URL: doubles.url }) }));
vi.mock("@/lib/invoices/service", async original => ({ ...await original<object>(), invoiceService: doubles.invoiceService }));

const seed = sampleCustomer();
const issued = seed.documents.find(d => d.kind === "invoice" && d.status === "issued")!;
const pending = seed.documents.find(d => d.kind === "invoice" && d.status === "pending")!;
const foreign = { ...issued, id: "doc_foreign", payment_ref: "pay_foreign" };
const caller = { userId: "user_admin", orgId: "org_a", orgRole: "org:admin" };
const workspace = { id: "workspace_a", clerk_org_id: "org_a" };
const bound = { organization: "org_a" };
const request_id = "00000000-0000-4000-8000-000000000001";
const expediteId = "00000000-0000-4000-8000-000000000002";
const details = { details: seed.billing.details, version: seed.billing.version };
const correction = { documentId: issued.id, request_id };
const mutations = (binding: object = bound) => [
  () => saveInvoiceBillingDetails({ ...details, ...binding }),
  () => askForInvoiceCorrection({ ...correction, ...binding }),
  () => requestInvoiceNow({ request_id, ...binding }),
];
const pdf = (id: string) => GET(new Request(`http://localhost${invoicePdfHref(id)}`), { params: Promise.resolve({ documentId: id }) });
let service: ReturnType<typeof createMockInvoiceService>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(MOCK_REFERENCE_TIME));
  doubles.url = "mock";
  doubles.member.mockResolvedValue({ workspace, caller });
  doubles.headers.mockResolvedValue(new Headers({ "Sec-Fetch-Site": "same-origin", Origin: "null" }));
  service = createMockInvoiceService({ customers: { org_a: seed, org_b: { ...seed, documents: [foreign] } } });
  doubles.invoiceService.mockResolvedValue(service);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("invoice page actions", () => {
  it("never sends an individual's VAT ID, which the issuer would not read", async () => {
    const write = vi.spyOn(service, "saveBillingDetails");
    const person = { ...details.details!, type: "person" as const, tax_id: "PL7011027727" };
    expect(await saveInvoiceBillingDetails({ ...bound, ...details, details: person })).toMatchObject({ saved: true, billing: { details: { type: "person", tax_id: null } } });
    expect(write).toHaveBeenCalledExactlyOnceWith("org_a", { ...person, tax_id: null }, details.version);
  });

  it("uses only the authorized workspace customer on every service call", async () => {
    const read = vi.spyOn(service, "listDocuments"), getBilling = vi.spyOn(service, "getBillingDetails");
    const write = vi.spyOn(service, "saveBillingDetails"), ask = vi.spyOn(service, "requestBuyerCorrection"), expedite = vi.spyOn(service, "requestInvoiceNow");
    const supplied = { customer: "org_b", workspaceId: "workspace_b" };
    expect(await loadOrganizationInvoicePage({ ...supplied, kind: "invoice" })).toMatchObject({ organization: "org_a", canManage: true, sample: true, items: expect.any(Array), billing: seed.billing });
    expect(read.mock.calls).toEqual([["org_a", { kind: "invoice" }], ["org_a", {}]]);
    expect(getBilling).toHaveBeenCalledExactlyOnceWith("org_a");
    expect(await saveInvoiceBillingDetails({ ...bound, ...details, ...supplied })).toMatchObject({ saved: true });
    expect(write).toHaveBeenCalledExactlyOnceWith("org_a", seed.billing.details, seed.billing.version);
    expect(await askForInvoiceCorrection({ ...bound, ...correction, ...supplied })).toMatchObject({ document: { status: "pending" } });
    expect(ask).toHaveBeenCalledExactlyOnceWith("org_a", issued.id, request_id);
    expect(await requestInvoiceNow({ ...bound, request_id: expediteId, payment_ref: pending.payment_ref, ...supplied })).toMatchObject({ document: { id: pending.id } });
    expect(expedite).toHaveBeenCalledExactlyOnceWith("org_a", expediteId, pending.payment_ref);
    expect(doubles.headers).toHaveBeenCalledTimes(3);
  });

  it.each([
    { label: "signed out", member: null },
    { label: "foreign workspace", member: { workspace, caller: { ...caller, orgId: "org_b" } } },
    { label: "non-admin", member: { workspace, caller: { ...caller, orgRole: "org:member" } } },
    { label: "no active organization", member: { workspace, caller: { ...caller, orgId: null } } },
  ])("refuses all five entry points before the invoice service when $label", async ({ member }) => {
    doubles.member.mockResolvedValue(member);
    expect(await loadOrganizationInvoicePage()).toMatchObject({ code: "permission" });
    for (const mutate of mutations({ organization: "org_b" })) expect(await mutate()).toMatchObject({ code: "permission" });
    const response = await pdf(issued.id);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Document not found.");
    expect(doubles.invoiceService).not.toHaveBeenCalled();
  });

  it("treats disabled invoices as absent, even for an administrator", async () => {
    doubles.url = undefined;
    expect(await loadOrganizationInvoicePage()).toMatchObject({ code: "permission" });
    for (const mutate of mutations()) expect(await mutate()).toMatchObject({ code: "permission" });
    expect((await pdf(issued.id)).status).toBe(404);
    expect(doubles.member).not.toHaveBeenCalled();
    expect(doubles.invoiceService).not.toHaveBeenCalled();
  });

  it("checks Origin before permission and binding on each write", async () => {
    doubles.member.mockResolvedValue(null);
    doubles.headers.mockResolvedValue(new Headers({ "Sec-Fetch-Site": "cross-site" }));
    for (const mutate of mutations({})) expect(await mutate()).toMatchObject({ code: "origin" });
    expect(doubles.member).not.toHaveBeenCalled();
    expect(doubles.invoiceService).not.toHaveBeenCalled();
  });

  it("rejects stale or missing bindings before contacting the service", async () => {
    const page = await loadOrganizationInvoicePage();
    doubles.invoiceService.mockClear();
    doubles.member.mockResolvedValue({ workspace: { id: "workspace_b", clerk_org_id: "org_b" }, caller: { ...caller, orgId: "org_b" } });
    for (const binding of [{ organization: page.organization }, {}, { organization: null }]) {
      for (const mutate of mutations(binding)) expect(await mutate()).toMatchObject({ code: "organization_changed" });
    }
    expect(doubles.invoiceService).not.toHaveBeenCalled();
  });

  it("refuses correction and issue requests for another customer's document and payment", async () => {
    expect(await askForInvoiceCorrection({ ...bound, documentId: foreign.id, request_id })).toMatchObject({ code: "not_found" });
    expect(await requestInvoiceNow({ ...bound, payment_ref: foreign.payment_ref, request_id })).toMatchObject({ code: "not_found" });
  });

  it("shows empty history and allows creating billing details without a version", async () => {
    doubles.member.mockResolvedValue({ workspace: { ...workspace, clerk_org_id: "org_new" }, caller: { ...caller, orgId: "org_new" } });
    expect(await loadOrganizationInvoicePage()).toMatchObject({ items: [], billing: { details: null, vies: null, version: null, updated_at: null } });
    expect(await saveInvoiceBillingDetails({ ...details, organization: "org_new", version: null })).toMatchObject({ saved: true });
  });

  it("uses unfiltered history to hide Correct when search omits a pending correction", async () => {
    await service.requestBuyerCorrection("org_a", issued.id, request_id);
    const result = await loadOrganizationInvoicePage({ kind: "invoice" });
    expect(result.items!.find(d => d.id === issued.id)).toMatchObject({ canCorrect: false, corrections: [] });
  });

  it("rejects invalid filters and write input before calling the service", async () => {
    expect(await loadOrganizationInvoicePage({ from: "yesterday" })).toMatchObject({ code: "invalid_filter" });
    expect(await saveInvoiceBillingDetails({ ...bound, ...details, details: { ...details.details, customer: "org_b" } })).toMatchObject({ code: "validation" });
    expect(await askForInvoiceCorrection({ ...bound, ...correction, documentId: "" })).toMatchObject({ code: "validation" });
    expect(await requestInvoiceNow({ ...bound, request_id: "invalid" })).toMatchObject({ code: "validation" });
    expect(doubles.invoiceService).not.toHaveBeenCalled();
  });

  it("forwards a listed payment reference at the Unicode length limit", async () => {
    const expedite = vi.spyOn(service, "requestInvoiceNow"), ref = `${"x".repeat(127)}\u{1F4C4}`;
    await requestInvoiceNow({ ...bound, request_id, payment_ref: ref });
    expect(expedite).toHaveBeenCalledExactlyOnceWith("org_a", request_id, ref);
  });

  it("returns stable conflict codes and maps service fields to local messages", async () => {
    const ask = vi.spyOn(service, "requestInvoiceNow");
    for (const code of ["version_conflict", "correction_pending", "pending", "already_invoiced", "request_open", "nothing_to_correct", "not_correctable", "correction_limit"] as const) {
      ask.mockRejectedValueOnce(new InvoiceConflict(code));
      expect(await requestInvoiceNow({ ...bound, request_id })).toMatchObject({ code, error: expect.any(String) });
    }
    vi.spyOn(service, "saveBillingDetails").mockRejectedValueOnce(new InvoiceValidation("invalid_fields", { city: "future_code", name: "required", country: "invalid_country", tax_id: "invalid_format" }));
    expect(await saveInvoiceBillingDetails({ ...bound, ...details })).toMatchObject({ code: "invalid_fields", fields: {
      city: "Check this field's format and length.", name: "Enter this field.", country: "Choose a valid country.", tax_id: "Check the VAT ID and its country prefix.",
    } });
    ask.mockRejectedValueOnce(new InvoiceValidation("invalid_request", { request_id: "invalid_format" }));
    expect(await requestInvoiceNow({ ...bound, request_id })).toMatchObject({ code: "invalid_request", fields: { request_id: "Check this field's format and length." } });
    await expect(saveInvoiceBillingDetails({ ...bound, ...details, version: "stale" })).resolves.toMatchObject({ code: "version_conflict" });
    vi.spyOn(service, "getBillingDetails").mockRejectedValueOnce(new Error("private upstream detail"));
    expect(await loadOrganizationInvoicePage()).toEqual({ code: "unavailable", error: new InvoiceUnavailable().message });
  });
});

describe("invoice PDF route", () => {
  it("makes one scoped service call for an opaque id and returns a safe attachment", async () => {
    // The longest id contract 1.1.3 allows, 128 characters, with a dot in it.
    const id = `${"x".repeat(124)}.csv`;
    const original = await service.getDocumentPdf("org_a", issued.id);
    const read = vi.spyOn(service, "getDocumentPdf").mockResolvedValue({ ...original, filename: 'a/../bad"name.pdf' });
    const list = vi.spyOn(service, "listDocuments");
    const response = await pdf(id);
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledExactlyOnceWith("org_a", id);
    expect(list).not.toHaveBeenCalled();
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="a_.._bad_name.pdf"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original.bytes);
  });

  it("uses the same plain response for empty, foreign, unknown, pending and denied PDFs", async () => {
    const responses = await Promise.all(["", "x".repeat(129), foreign.id, "doc_unknown", pending.id].map(pdf));
    doubles.member.mockResolvedValue(null);
    responses.push(await pdf(issued.id));
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Document not found.");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.has("Content-Disposition")).toBe(false);
    }
  });

  it("returns a plain 503 for other failures without exposing the upstream error", async () => {
    vi.spyOn(service, "getDocumentPdf").mockRejectedValueOnce(new Error("private upstream detail"));
    const response = await pdf(issued.id);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(new InvoiceUnavailable().message);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
