import { describe, expect, it } from "vitest";
import { Rdap, guardedFetch } from "../../src/checks/rdap";

/* The real RDAP services, by hand only (`docs/TESTS.md`, outside the gate): it reaches IANA,
   Public Interest Registry (`.org`) and Verisign (`.com`) over the network, through the production
   address guard. Skipped unless `RDAP_LIVE=1`:

     RDAP_LIVE=1 npx vitest run --project unit --configLoader runner tests/unit/rdap-live.test.ts

   It pins what the recorded fixtures were taken from, so a registry that changes its answers
   (PIR's 400 for a subdomain, the expiration event's name) shows here first. */

const live = process.env.RDAP_LIVE === "1" ? describe : describe.skip;

live("RDAP, live", () => {
  const rdap = new Rdap(guardedFetch());

  it("finds askone.org from www.askone.org at PIR, with its expiry and registrar", async () => {
    const r = await rdap.lookup("www.askone.org");
    expect(r).toMatchObject({ status: "found", domain: "askone.org", registrar: expect.any(String) });
    if (r.status === "found") expect(r.expiresAt).toBeGreaterThan(Date.now());
    console.log("[rdap live] www.askone.org", JSON.stringify(r));
  }, 60_000);

  it("finds vercel.com from www.vercel.com at Verisign", async () => {
    const r = await rdap.lookup("www.vercel.com");
    expect(r).toMatchObject({ status: "found", domain: "vercel.com", registrar: expect.any(String) });
    if (r.status === "found") expect(r.expiresAt).toBeGreaterThan(Date.now());
    console.log("[rdap live] www.vercel.com", JSON.stringify(r));
  }, 60_000);

  it("says .io has no RDAP service in IANA's file", async () => {
    expect(await rdap.lookup("staygreen.io")).toEqual({ status: "no_rdap", domain: "staygreen.io" });
  }, 60_000);
});
