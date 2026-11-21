import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PrivacyPage from "@/app/(public)/legal/privacy/page";
import TermsPage from "@/app/(public)/legal/terms/page";
import PricingPage from "@/app/(public)/pricing/page";

/* What the public pages say about invoices (2026-11-18). Invoices and billing details live in the
   invoice service, never in Staygreen's database; issued invoices are kept for the statutory
   period on legal obligation, and after it on legitimate interest, never on consent. A deployment
   without the service (the public export, a self-hosted copy) promises no invoice at all, so every
   sentence below appears only when `INVOICE_SERVICE_URL` is set (`src/lib/invoices/enabled.ts`). */
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&rsquo;|’/g, "'").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const render = (page: () => unknown) => text(renderToStaticMarkup(createElement(page as () => React.ReactElement)));
const migrations = new URL("../../supabase/migrations/", import.meta.url);

vi.mock("@clerk/nextjs", () => ({ PricingTable: () => null, useOrganization: () => ({ isLoaded: true, organization: null }) }));

afterEach(() => vi.unstubAllEnvs());

describe("with the invoice service connected", () => {
  const pages = () => { vi.stubEnv("INVOICE_SERVICE_URL", "https://invoices.example.test"); return { privacy: render(PrivacyPage), terms: render(TermsPage), pricing: render(PricingPage) }; };

  it("keeps billing details and invoices out of Staygreen's own database, as the privacy page says", () => {
    expect(pages().privacy).toContain("Staygreen's own database stores none of them");
    for (const name of readdirSync(migrations).filter(file => file.endsWith(".sql")))
      expect(readFileSync(new URL(name, migrations), "utf8"), name).not.toMatch(/billing_details|vat_id|buyer_name|invoice_number/i);
  });

  it("names every party an invoice reaches, and only Fakturownia as a processor among the new ones", () => {
    const { privacy } = pages();
    for (const party of ["Fakturownia", "VIES", "VAT White List", "KSeF", "Stripe"]) expect(privacy).toContain(party);
    expect(privacy).toContain("Fakturownia: issues and stores invoices");
    expect(privacy).toContain("are not our processors");
  });

  it("rests invoices on legal obligation and legitimate interest, never on consent", () => {
    const basis = pages().privacy.match(/Invoices and billing details([\s\S]*?)None of this relies on your consent/)?.[1] ?? "";
    expect(basis).toContain("Art. 6(1)(c) GDPR");
    expect(basis).toContain("Art. 6(1)(f) GDPR");
    expect(basis).not.toMatch(/6\(1\)\(a\)/);
  });

  it("promises no deletion of an issued invoice, because nothing deletes one", () => {
    const { privacy } = pages();
    const kept = privacy.match(/Invoices, including the buyer details printed on them, are kept for([^.]*\.[^.]*\.)/)?.[1] ?? "";
    expect(kept).toContain("at least five years");
    expect(kept).not.toMatch(/deleted|removed|erased/);
    expect(privacy).toContain("We cannot delete an issued invoice on request");
  });

  it("tells a paying workspace in the terms and on pricing that an invoice follows every payment", () => {
    const { terms, pricing } = pages();
    expect(terms).toContain("We issue an invoice for every payment");
    expect(terms).toContain("download it as a PDF");
    // The 90 days are a deadline to ask, not a promise: the service closes the window on a fully refunded
    // invoice (`correctable_until` in the contract). Since contract 1.2.0 the VAT ID and the country may change too, a
    // replacement invoice keeps the first one's deadline, and the service refuses a 51st request in 12 months.
    for (const page of [terms, pricing]) {
      expect(page).toContain("Within 90 days of an invoice's date (for a replacement invoice, the date of the first one), they can ask for its buyer details to be corrected");
      expect(page).toContain("up to 50 such requests in any 12 months");
      expect(page).toContain("unless it has been fully refunded");
      expect(page).toContain("the VAT ID and the country included");
      expect(page).not.toMatch(/goes through support/);
      expect(page).not.toMatch(/can be corrected to those details|have an invoice corrected/);
    }
    expect(pricing).toContain("Yes, for every payment");
    // The issuer never reads an individual's tax ID, so the form asks only a company for one (`buyerTaxId`).
    expect(pricing).toContain("save the company or personal details they are issued to, with a company's VAT ID.");
    expect(pages().privacy).toContain("and, for a company, optionally a VAT ID. For an individual, those are your own name and address, and no VAT ID is asked for.");
    expect(pages().privacy).not.toMatch(/no VAT ID is asked for or kept/);
    expect(pricing).not.toContain("available on request");
  });
});

describe("without the invoice service", () => {
  it("promises no invoice page, names no invoicing party, and keeps the invoice-on-request answer", () => {
    vi.stubEnv("INVOICE_SERVICE_URL", "");
    const privacy = render(PrivacyPage), terms = render(TermsPage), pricing = render(PricingPage);
    for (const party of ["Fakturownia", "VIES", "White List", "KSeF", "Invoices and billing details"]) expect(privacy).not.toContain(party);
    expect(terms).not.toContain("We issue an invoice for every payment");
    expect(pricing).toContain("available on request");
    expect(pricing).not.toContain("Yes, for every payment");
  });
});
