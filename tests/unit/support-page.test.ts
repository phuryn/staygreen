import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import SupportPage from "@/app/(public)/support/page";
import { ADDRESS_LINE, COMPANY } from "@/lib/legal";
import { AGENT_DOCS, GITHUB_REPO, NEW_ISSUE, OWN_STATUS_PAGE, SECURITY_REPORT } from "@/lib/site-links";

/* `/support`, the one page the public footer and the app's rail both send people to: public
   questions to the issue tracker, private ones to the mailbox, and the warning that issues are
   public before anyone pastes a credential into one. */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(ROOT + path, "utf8");

function render(email: string) {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", email);
  return renderToStaticMarkup(createElement(SupportPage));
}

afterEach(() => vi.unstubAllEnvs());

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("the support page", () => {
  it("sends bugs and ideas to the public issue tracker, and warns before a secret goes there", () => {
    const html = render("help@example.com");
    expect(NEW_ISSUE.startsWith(`${GITHUB_REPO}/issues/`)).toBe(true);
    expect(html).toContain(`href="${NEW_ISSUE}"`);
    expect(html).toContain("Issues are public.");
    expect(html).toContain("heartbeat URL");
    expect(html).toContain("signing secret");
    expect(html).toContain("service-role");
    // A leaked secret must stop being accepted by whatever checks it: a new API token leaves the
    // old one live, and removing a channel leaves its signing secret valid at the receiver. The
    // page names no per-credential procedure: four review rounds found each list incomplete.
    expect(html).toContain("make sure the old value stops working wherever it is accepted");
    expect(html).toContain("issuing a new one doesn’t always retire it");
    expect(html).not.toContain("replace it");
    // The warning comes first, then what never to paste, then what to do after posting one.
    expect(html.indexOf("Issues are public.")).toBeLessThan(html.indexOf("heartbeat URL"));
    expect(html.indexOf("heartbeat URL")).toBeLessThan(html.indexOf("make sure the old value stops working"));
    expect(html).toContain(`href="${AGENT_DOCS}"`);
  });

  it("sends a security problem to private reporting before it offers the public tracker", () => {
    const html = render("help@example.com");
    expect(SECURITY_REPORT).toBe(`${GITHUB_REPO}/security/advisories/new`);
    expect(html.indexOf(`href="${SECURITY_REPORT}"`)).toBeGreaterThan(-1);
    expect(html.indexOf(`href="${SECURITY_REPORT}"`)).toBeLessThan(html.indexOf(`href="${NEW_ISSUE}"`));
  });

  it("gives the mailbox when one is configured, and the postal address when not", () => {
    expect(render("help@example.com")).toContain('Write to <a href="mailto:help@example.com">help@example.com</a> about');
    const without = render("");
    expect(without).not.toContain("mailto:");
    // The contact sentence itself, not the Company line that always names the address.
    expect(without).toContain(`Write to ${escapeHtml(`${COMPANY.name}, ${ADDRESS_LINE}`)} about`);
  });

  it("links the privacy policy, the terms and Staygreen's status page, saying the page runs on Staygreen", () => {
    const html = render("");
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
    expect(html).toContain(`href="${OWN_STATUS_PAGE}"`);
    // It is served and fed by Staygreen, so it can't vouch for Staygreen in an outage.
    expect(html).toContain("It runs on Staygreen itself");
    expect(html).not.toContain("watched from outside");
  });

  it("is linked from the public footer, beside the repository and the status page, and from the app's rail", () => {
    const frame = read("src/components/landing/SiteFrame.tsx");
    expect(frame).toContain('href="/support"');
    expect(frame).toMatch(/href=\{GITHUB_REPO\}[^>]*>GitHub</);
    expect(frame).toMatch(/href=\{OWN_STATUS_PAGE\}[^>]*>Status</);
    expect(read("src/components/Shell.tsx")).toContain('href="/support"');
  });
});
