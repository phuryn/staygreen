/* The company behind Staygreen, and the few facts both legal pages share.

   The controller is the one behind AskOne, copied from its `src/lib/legal.ts` (fde-template,
   branch `askone`), which was verified on `2026-09-03` against the Polish register (KRS) rather
   than typed from memory: a privacy policy that names the wrong entity names nobody. These are
   public register facts and belong in the repository. Nothing here is a secret, and a legal page
   that read its own company details out of an environment variable would be a page nobody could
   review. Re-check them against the register when the company's details change. */

export const COMPANY = {
  name: "HURYN Sp. z o.o.",
  street: "ul. Hoża 29",
  postcode: "00-521",
  city: "Warszawa",
  country: "Poland",
  krs: "0000893173",
  nip: "7011027727",
  regon: "388627882",
} as const;

export const ADDRESS_LINE = `${COMPANY.street}, ${COMPANY.postcode} ${COMPANY.city}, ${COMPANY.country}`;

/** The supervisory authority a Polish controller's data subjects complain to. */
export const DPA = {
  name: "President of the Personal Data Protection Office (Prezes Urzędu Ochrony Danych Osobowych)",
  address: "ul. Stawki 2, 00-193 Warszawa, Poland",
  url: "https://uodo.gov.pl",
} as const;

/** Last substantive change to the privacy policy. The Terms have their own date so a change
 *  to only one page does not mark the other as revised. */
export const LEGAL_UPDATED = "27 October 2026";
export const TERMS_UPDATED = "24 October 2026";

/** Where a data request reaches a person, when one is configured (`docs/variables.md`). Empty
 *  means the pages give the postal address only and nothing links a mailto that goes nowhere.
 *  A `NEXT_PUBLIC_*` value is inlined at build; the env schema has checked its shape by then. */
export function legalContactEmail(): string {
  return process.env.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL?.trim() ?? "";
}

/** How many failed checks a monitor keeps. The number is the database's: the probes' commit
 *  functions delete all but the newest 20 (`probe_commit_monitor`, `probe_commit_heartbeat`,
 *  migrations 017 and 019). `tests/unit/legal-pages.test.ts` holds this copy to the SQL. */
export const FAILED_CHECKS_KEPT = 20;

/** The standing promise in case Staygreen closes, worded once for the terms and the pricing page
 *  (`docs/product/decisions.md`, 2026-10-21, "Sell a narrower V1 that works"). */
export const REFUND_IF_CLOSED = "If Staygreen shuts down, you get a refund for the unused part of your plan.";
