import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import * as schemas from "@/lib/invoices/contract";
import { createHttpInvoiceService, invoiceService, InvoiceUnavailable, safePdfFilename } from "@/lib/invoices/service";
import { createMockInvoiceService, mockVies } from "@/lib/invoices/mock";
import { sampleCustomer, contractCustomer, emptyMockCustomer, samplePdf, MOCK_REFERENCE_TIME, MOCK_INVALID_VAT_ID, MOCK_UNAVAILABLE_VAT_ID } from "@/lib/invoices/sample";
import { correctionDeadline, warsawDate } from "@/lib/invoices/calendar";
import { allInvoiceDocuments } from "@/lib/invoices/documents";
import { CONTRACT_CUSTOMER, invoiceServiceBehavior } from "../contracts/invoice-service.behavior";
import { invoiceHttpServer } from "../contracts/invoice-http-server";
import { invoiceContractTarget } from "../contracts/invoice-target";

const config = vi.hoisted(() => ({ INVOICE_SERVICE_URL: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({ env: () => config }));

const at = new Date(MOCK_REFERENCE_TIME), seed = sampleCustomer(at), issued = seed.documents.find(d => d.status === "issued" && d.kind === "invoice")!;
// A buyer correction asked for and priced by the service before it is issued:
// v1's own example of a reverse-charge change, gross 0.
const pendingPricedCorrection = { ...seed.documents.find(d => d.kind === "correction" && d.reason === "buyer")!, status: "pending" as const,
  number: null, issue_date: null, correctable_until: null, net: 1127, tax: -1127, gross: 0 };

// 2026-11-18: every response object refused a field it did not know, so a
// field the service adds, additive in any reading of a contract, would make
// every organization's page unavailable until Staygreen shipped, the same failure
// as the "other" reason. Responses drop what they don't know; what Staygreen
// sends stays strict, as the service's own request schemas are.
describe("an added response field is ignored, never refused", () => {
  const FUTURE = "x_future_field";
  const withFuture = (value: unknown): unknown => Array.isArray(value) ? value.map(withFuture)
    : value && typeof value === "object" ? { ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withFuture(v)])), [FUTURE]: "later" } : value;
  const correction = { ...seed.documents.find(d => d.kind === "correction" && d.status === "issued")!, buyer: issued.buyer };
  const state = { ...seed.billing, vies: { status: "valid" as const, checked_at: "2026-11-17T12:00:00Z" } };
  it.each([
    ["Document", schemas.documentSchema, correction],
    ["BillingDetailsState", schemas.billingResponseSchema, state],
    ["DocumentPage", schemas.documentsResponseSchema, { documents: [issued, correction], next_cursor: null }],
    ["DocumentResult", schemas.documentResultSchema, { document: correction }],
  ] as const)("%s, at every object level", (name, zod, base) => {
    const parsed = (zod as z.ZodType).safeParse(withFuture(base));
    expect(parsed.success).toBe(true); expect(JSON.stringify(parsed.data)).not.toContain(FUTURE);
  });
  it("Error, whose field messages stay a record", () => {
    const parsed = schemas.errorResponseSchema.safeParse(withFuture({ error: { code: "invalid_fields", message: "Check the fields.", fields: { name: "Required" } } }));
    expect(parsed.success).toBe(true); expect(Object.keys(parsed.data!)).toEqual(["error"]); expect(Object.keys(parsed.data!.error).sort()).toEqual(["code", "fields", "message"]);
  });
  it("what Staygreen sends stays strict", () => {
    expect(schemas.billingDetailsSchema.safeParse({ ...seed.billing.details!, [FUTURE]: 1 }).success).toBe(false);
  });
});

describe("document validation", () => {
  it("parses both sample histories and enforces nullable pending/issued invariants and field limits", () => {
    for (const customer of [seed, contractCustomer(at), emptyMockCustomer()]) { customer.documents.forEach(d => expect(schemas.documentSchema.safeParse(d).success).toBe(true)); expect(schemas.billingResponseSchema.safeParse(customer.billing).success).toBe(true); }
    expect(schemas.documentSchema.safeParse({ ...issued, number: null }).success).toBe(false);
    // 2026-11-17: the client also demanded nulls v1 never states (a deadline on
    // a correction or a pending document, a number or date while pending,
    // corrects/reason on an invoice), so one such document made the whole page
    // unavailable. Only v1's two invariants may fail a document.
    const correction = seed.documents.find(d => d.kind === "correction" && d.status === "issued")!, pending = seed.documents.find(d => d.status === "pending")!;
    for (const permitted of [{ ...correction, correctable_until: "2027-01-14" }, { ...pending, correctable_until: "2027-01-14" },
      { ...pending, number: "ASK/2026/11/009", issue_date: "2026-11-16" }, { ...issued, corrects: correction.id, reason: "buyer" as const }])
      expect(schemas.documentSchema.safeParse(permitted).success).toBe(true);
    expect(schemas.documentSchema.safeParse({ ...correction, corrects: null }).success).toBe(false);
    expect(schemas.documentSchema.safeParse({ ...correction, reason: null }).success).toBe(false);
    expect(schemas.documentSchema.safeParse({ ...issued, description: "x".repeat(300) }).success).toBe(true);
    expect(schemas.documentSchema.safeParse({ ...issued, description: "x".repeat(301) }).success).toBe(false);
    // 2026-11-17: v1 lets a pending document carry amounts (only an issued one
    // must). A pending buyer correction priced in advance must not take the
    // whole list down.
    expect(schemas.documentSchema.safeParse(pendingPricedCorrection).success).toBe(true);
    for (const [field, length] of [["postal_code", 21], ["tax_id", 33]] as const) expect(schemas.billingDetailsSchema.safeParse({ ...seed.billing.details!, [field]: "x".repeat(length) }).success).toBe(false);
  });
});
invoiceServiceBehavior("memory mock consumer contract", () => createMockInvoiceService({ customers: { [CONTRACT_CUSTOMER]: contractCustomer(at) }, now: () => at }));
describe("buyer-correction refusals follow v1.0.4's order", () => {
  it("answers correction_pending before nothing_to_correct, and nothing_to_correct without saved details", async () => {
    const base = contractCustomer(at), original = base.documents.find(d => d.kind === "invoice" && d.status === "issued")!;
    const withPending = createMockInvoiceService({ customers: { c1: base }, now: () => at });
    await expect(withPending.requestBuyerCorrection("c1", original.id, randomUUID())).rejects.toMatchObject({ status: 409, code: "correction_pending" });
    const settled = { ...base, documents: base.documents.filter(d => !(d.kind === "correction" && d.status === "pending")) };
    const withoutPending = createMockInvoiceService({ customers: { c2: settled }, now: () => at });
    await expect(withoutPending.requestBuyerCorrection("c2", original.id, randomUUID())).rejects.toMatchObject({ status: 409, code: "nothing_to_correct" });
  });
});
describe("HTTP consumer contract", () => {
  let server: Awaited<ReturnType<typeof invoiceHttpServer>>;
  beforeAll(async () => { server = await invoiceHttpServer(createMockInvoiceService({ customers: { [CONTRACT_CUSTOMER]: contractCustomer(at) }, now: () => at })); });
  afterAll(async () => { await server.close(); });
  invoiceServiceBehavior("identical suite through HTTP", () => createHttpInvoiceService(server.baseUrl, "unit-app-key"));
  it("sends the bearer header, omits If-Match for create and supplies it for updates", () => {
    expect(server.requests.every(r => r.authorization === "Bearer unit-app-key")).toBe(true);
    const saves = server.requests.filter(r => r.method === "PUT");
    expect(saves.some(r => r.match === undefined)).toBe(true); expect(saves.some(r => typeof r.match === "string")).toBe(true);
  });
  it("answers non-JSON mutation bodies with 422 invalid_request", async () => {
    for (const [method, suffix] of [["PUT", "billing-details"], ["POST", "invoice-requests"], ["POST", "documents/doc_unknown/corrections"]]) {
      const response = await fetch(`${server.baseUrl}/v1/customers/${CONTRACT_CUSTOMER}/${suffix}`, { method, headers: { Authorization: "Bearer unit-app-key", "Content-Type": "application/json" }, body: "{broken" });
      expect(response.status).toBe(422); expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
  });
});

describe("mock rules", () => {
  it("reuses one store across simultaneous first calls, and requires an enabled configuration", async () => {
    await expect(invoiceService()).rejects.toBeInstanceOf(InvoiceUnavailable);
    config.INVOICE_SERVICE_URL = "mock";
    try {
      const [first, second] = await Promise.all([invoiceService(), invoiceService()]);
      expect(first).toBe(second);
      const { documents } = await first.listDocuments("org_local_mock");
      expect(documents.filter(d => d.kind === "invoice").map(d => d.gross)).toEqual(expect.arrayContaining([900, 9000]));
    } finally {
      config.INVOICE_SERVICE_URL = undefined;
    }
  });
  it("treats well-formed customer ids inherited from Object.prototype as empty", async () => {
    const service = createMockInvoiceService({ customers: { a: seed } });
    expect(await service.listDocuments("constructor")).toEqual({ documents: [], next_cursor: null });
  });
  it("keeps all pending documents pending across time and returns a detached immutable first receipt", async () => {
    let now = at;
    const service = createMockInvoiceService({ customers: { a: seed }, now: () => now });
    const key = randomUUID(), first = await service.requestBuyerCorrection("a", issued.id, key);
    expect(first.document).toMatchObject({ status: "pending", number: null, issue_date: null, net: null, tax: null, gross: null });
    const copy = structuredClone(first); first.document.description = "client mutation";
    now = new Date("2027-12-31T12:00:00Z");
    expect(await service.requestBuyerCorrection("a", "different-document", key)).toEqual(copy);
    expect(await service.requestInvoiceNow("a", key, "x".repeat(1000))).toEqual(copy);
    expect((await service.listDocuments("a")).documents.filter(d => d.status === "pending")).toHaveLength(2);
  });
  it("includes the whole last Warsaw day, through the following UTC midnight offset", async () => {
    expect(warsawDate(new Date("2026-11-16T22:59:59.999Z"))).toBe("2026-11-16");
    expect(warsawDate(new Date("2026-11-16T23:00:00Z"))).toBe("2026-11-17");
    const original = { ...issued, issue_date: "2026-08-18", correctable_until: correctionDeadline("2026-08-18") };
    expect(original.correctable_until).toBe("2026-11-16");
    for (const [date, allowed] of [["2026-11-16T22:59:59.999Z", true], ["2026-11-16T23:00:00Z", false]] as const) {
      const service = createMockInvoiceService({ customers: { a: { ...seed, documents: [original] } }, now: () => new Date(date) });
      const call = service.requestBuyerCorrection("a", original.id, randomUUID());
      if (allowed) expect((await call).status).toBe(202); else await expect(call).rejects.toMatchObject({ code: "not_correctable" });
    }
  });
  it("enforces one pending correction under concurrent requests and scopes replay to the customer", async () => {
    const service = createMockInvoiceService({ customers: { a: seed, b: seed }, now: () => at }), key = randomUUID();
    const results = await Promise.allSettled([service.requestBuyerCorrection("a", issued.id, key), service.requestBuyerCorrection("a", issued.id, randomUUID())]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await service.requestBuyerCorrection("b", issued.id, key)).status).toBe(202);
    await expect(service.getDocumentPdf("b", (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<schemas.InvoiceReceipt>).value.document.id)).rejects.toMatchObject({ status: 404 });
  });
  it("keeps offline VIES deterministic, versions nullable initially, and paginates filtered results", async () => {
    for (const [id, status] of [["PL5250001009", "valid"], [MOCK_INVALID_VAT_ID, "invalid"], [MOCK_UNAVAILABLE_VAT_ID, "unavailable"]]) expect(mockVies({ ...seed.billing.details!, tax_id: id }, at.toISOString()).status).toBe(status);
    expect(mockVies({ ...seed.billing.details!, country: "US" }, at.toISOString()).status).toBe("not_applicable");
    const service = createMockInvoiceService({ customers: { a: { ...seed, documents: Array.from({ length: 51 }, (_, i) => ({ ...issued, id: `doc_${i}`, number: `NUMBER-${i}` })) } } });
    const first = await service.listDocuments("a", { kind: "invoice", number: "NUMBER-" }); expect(first.documents).toHaveLength(50);
    expect((await service.listDocuments("a", { kind: "invoice", number: "NUMBER-", cursor: first.next_cursor! })).documents).toHaveLength(1);
    expect(await allInvoiceDocuments(service, "a", { number: "NUMBER-" })).toHaveLength(51);
    const cyclic = { ...service, listDocuments: vi.fn().mockResolvedValue({ documents: [], next_cursor: "repeat" }) };
    await expect(allInvoiceDocuments(cyclic, "a")).rejects.toBeInstanceOf(InvoiceUnavailable);
  });
  it("produces a valid small sample PDF with consistent xref offsets", () => {
    const bytes = samplePdf(issued), text = new TextDecoder().decode(bytes);
    expect(schemas.pdfBytesSchema.safeParse(bytes).success).toBe(true); expect(text).toContain("SAMPLE \\227 not a real invoice");
    expect(text).toContain("Staygreen Builder \\(month\\)");
    expect(text).toContain("Total: 9.00 USD");
    const xref = Number(text.match(/startxref\n(\d+)/)![1]); expect(text.slice(xref)).toMatch(/^xref/);
    [...text.matchAll(/(\d{10}) 00000 n/g)].forEach((match, i) => expect(text.slice(Number(match[1]))).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
});

describe("HTTP boundaries and both deadlines", () => {
  let server: Awaited<ReturnType<typeof invoiceHttpServer>>;
  beforeAll(async () => {
    server = await invoiceHttpServer(createMockInvoiceService(), (req, res) => {
      const mode = req.url!.split("/")[1];
      if (mode === "timeout") return true;
      if (mode === "redirect") { res.writeHead(302, { Location: "/redirect-target" }); res.end(); return true; }
      if (mode === "pdf") { res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", "attachment; filename*=UTF-8''STG%2F2026%2F11%2F001.pdf"); res.end(samplePdf(issued)); return true; }
      if (mode === "pdf-fallback") { res.setHeader("Content-Type", "application/pdf"); res.end(samplePdf(issued)); return true; }
      if (mode === "pdf-upper") { res.setHeader("Content-Type", "Application/PDF; charset=binary"); res.end(samplePdf(issued)); return true; }
      if (mode === "malformed-pdf") { res.setHeader("Content-Type", "application/pdf"); res.end("not a PDF"); return true; }
      if (mode === "malformed") { res.statusCode = req.method === "POST" ? 202 : 200; res.end("{}"); return true; }
      if (mode.startsWith("error_")) {
        const [, status, code] = mode.split("_"); res.statusCode = Number(status); res.setHeader("Content-Type", "application/json");
        const fullCode = mode.slice(`error_${status}_`.length); res.end(JSON.stringify({ error: { code: fullCode, message: "private provider detail", fields: { city: "future_field_code" } } })); return true;
      }
      if (mode === "bad-error") { res.statusCode = 404; res.end("{}"); return true; }
      if (mode === "pending-priced") {
        res.statusCode = req.method === "POST" ? 202 : 200; res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(req.method === "POST" ? { document: pendingPricedCorrection } : { documents: [pendingPricedCorrection], next_cursor: null })); return true;
      }
      return false;
    });
  });
  afterAll(async () => { await server.close(); }); afterEach(() => vi.restoreAllMocks());
  const client = (mode: string) => createHttpInvoiceService(`${server.baseUrl}/${mode}`, "unit-app-key");
  it("maps every v1 409 and 422 code, 401, 404 and 5xx", async () => {
    for (const code of schemas.conflictCodeSchema.options) await expect(client(`error_409_${code}`).requestInvoiceNow("a", randomUUID())).rejects.toMatchObject({ status: 409, code });
    for (const code of ["invalid_request", "invalid_fields", "invalid_filter"]) await expect(client(`error_422_${code}`).listDocuments("a")).rejects.toMatchObject({ status: 422, code, fields: { city: "future_field_code" } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(client("error_401_unauthorized").listDocuments("a")).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    expect(log).toHaveBeenCalledWith("Invoice service authentication failed.");
    await expect(client("error_404_not_found").listDocuments("a")).rejects.toMatchObject({ status: 404, code: "not_found" });
    await expect(client("error_503_unavailable").listDocuments("a")).rejects.toMatchObject({ status: 503, code: "unavailable" });
  });
  it("accepts a pending correction that already carries amounts, from the list and from the request", async () => {
    expect((await client("pending-priced").listDocuments("a")).documents).toEqual([pendingPricedCorrection]);
    expect((await client("pending-priced").requestBuyerCorrection("a", issued.id, randomUUID())).document).toEqual(pendingPricedCorrection);
  });
  it("fails closed on malformed bodies for every response shape and refuses redirects", async () => {
    const bad = client("malformed");
    await Promise.all([bad.listDocuments("a"), bad.getBillingDetails("a"), bad.saveBillingDetails("a", seed.billing.details!, null), bad.requestInvoiceNow("a", randomUUID()), bad.requestBuyerCorrection("a", issued.id, randomUUID()), client("malformed-pdf").getDocumentPdf("a", issued.id), client("bad-error").listDocuments("a"), client("redirect").listDocuments("a")].map(request => expect(request).rejects.toBeInstanceOf(InvoiceUnavailable)));
    expect(server.requests.some(r => r.url === "/redirect-target")).toBe(false);
  });
  it("returns sanitized Content-Disposition filenames, with an invoice.pdf fallback", async () => {
    expect((await client("pdf").getDocumentPdf("a", issued.id)).filename).toBe("STG_2026_11_001.pdf");
    expect((await client("pdf-fallback").getDocumentPdf("a", issued.id)).filename).toBe("invoice.pdf");
    expect(safePdfFilename("../a\r\n\"b.pdf")).not.toMatch(/[\/\r\n"]/);
  });
  it("accepts a PDF whose media type is written in any case, as HTTP allows", async () => {
    // "Application/PDF" made a valid PDF unavailable; media types are case-insensitive (RFC 9110 8.3.1).
    expect((await client("pdf-upper").getDocumentPdf("a", issued.id)).filename).toBe("invoice.pdf");
  });
  it("uses no-store, refuses redirects, and aborts at 5 seconds versus 10 seconds for PUT", async () => {
    const real = globalThis.fetch, fetch = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => real(url, init));
    const started = Date.now(), elapsed: number[] = [];
    const service = client("timeout");
    await Promise.all([
      service.listDocuments("a").catch(error => { expect(error).toBeInstanceOf(InvoiceUnavailable); elapsed[0] = Date.now() - started; }),
      service.saveBillingDetails("a", seed.billing.details!, null).catch(error => { expect(error).toBeInstanceOf(InvoiceUnavailable); elapsed[1] = Date.now() - started; }),
    ]);
    expect(elapsed[0]).toBeGreaterThanOrEqual(4900); expect(elapsed[0]).toBeLessThan(7000);
    expect(elapsed[1]).toBeGreaterThanOrEqual(9900); expect(elapsed[1]).toBeLessThan(12_000);
    expect(fetch.mock.calls.every(([, init]) => init?.cache === "no-store" && init.redirect === "error" && !!init.signal)).toBe(true);
  }, 15_000);
});
describe("opt-in live target guard", () => {
  it.each([{}, { INVOICE_SERVICE_URL: "mock", INVOICE_SERVICE_KEY: "unit" }, { INVOICE_SERVICE_URL: "https://example.invalid" }, { INVOICE_SERVICE_URL: "http://localhost:1", INVOICE_SERVICE_KEY: "unit" }])("refuses missing configuration or mock without skipping", source => { expect(() => invoiceContractTarget(source)).toThrow(); });
  it("uses only explicitly supplied process configuration", () => { expect(invoiceContractTarget({ INVOICE_SERVICE_URL: "https://example.invalid", INVOICE_SERVICE_KEY: "unit" })).toEqual({ baseUrl: "https://example.invalid", key: "unit" }); });
});
