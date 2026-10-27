import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DomainSteps, PageDomain } from "@/components/PageDomain";
import { NOW, page } from "./fixtures";

vi.mock("@/lib/workspace-store", () => ({ useActs: () => ({}) }));
vi.mock("@/components/Copy", () => ({
  Copy: ({ text, label }: { text: string; label: string }) => createElement("button", { "data-copies": text }, label),
}));

const target = `${"a".repeat(32)}.domains.staygreen.io`;
const domain = (step: 1 | 4) => ({ host: "status.askone.org", name: "status", cnameTarget: target, step, startedAt: NOW });
const steps = (p: Partial<Parameters<typeof DomainSteps>[0]>) =>
  renderToStaticMarkup(createElement(DomainSteps, { domain: domain(1), verified: false, expired: false, checking: false, live: null, canVerify: true, ...p }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

describe("the custom domain card", () => {
  it("lists the record vertically with the name a provider asks for, and copies name and target", () => {
    const html = steps({});
    expect(html).not.toContain("<table");
    expect(html).toContain(`data-copies="status"`);
    expect(html).toContain(`data-copies="${target}"`);
    expect(text(html)).toContain("Some providers want the full name, status.askone.org.");
    expect(text(html)).toMatch(/Add this DNS record , in progress/);
    expect(text(html)).toMatch(/Certificate , next/);
    expect(text(html)).toMatch(/Switch your links , next/);
  });
  it("says the certificate is under way once DNS is verified, and claims live only when the edge answered", () => {
    const issuing = text(steps({ domain: domain(4), verified: true, live: false }));
    expect(issuing).toMatch(/DNS record found , done/);
    expect(issuing).toMatch(/Issuing the certificate , in progress/);
    expect(issuing).not.toContain("Certificate issued");
    expect(issuing).not.toContain("Live");
    // Nothing links the address before the edge answers: this browser may still resolve the old one.
    expect(steps({ domain: domain(4), verified: true, live: false })).not.toContain("href=");
    expect(issuing).toContain("Staygreen's check makes the first visit");
    const live = steps({ domain: domain(4), verified: true, live: true });
    expect(text(live)).toMatch(/Certificate issued , done/);
    // Switching links is the owner's to do whenever they like, so a live domain leaves no step open.
    expect(text(live)).toMatch(/Ready to share , done/);
    expect(live).not.toContain('aria-current');
    expect(live).toContain(`href="https://status.askone.org"`);
    expect(live).toContain(`data-copies="https://status.askone.org"`);
  });
  it("tells the owner the Staygreen address keeps working and that domain changes need no save", () => {
    for (const d of [domain(1), domain(4), null]) {
      const html = text(renderToStaticMarkup(createElement(PageDomain, { page: page({ slug: "askone", domain: d }), canVerify: true })));
      expect(html).toContain("status.staygreen.io/askone keeps working");
      expect(html).toContain("They don't need Save changes.");
    }
  });
  it("never says the Staygreen address keeps working on a members-only page, which it doesn't serve", () => {
    const html = text(renderToStaticMarkup(createElement(PageDomain, { page: page({ slug: "askone", membersOnly: true, domain: domain(4) }), canVerify: true })));
    expect(html).toContain("The domain is removed from this page.");
    expect(html).not.toContain("keeps working");
  });
});
