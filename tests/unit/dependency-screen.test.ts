import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DependencyResults } from "@/components/scan/Scan";
it("shows unknown/failed frontend evidence and the precise suggested checks, with no claim to have signed in", () => {
  const html = renderToStaticMarkup(createElement(DependencyResults, { report: {
    checks: [{ provider: "Clerk", host: "clerk.askone.org", url: "https://clerk.askone.org/script.js", keyword: "Clerk", purpose: "Catches a missing script.", dns: "issue", tls: "unknown", frontend: "issue" }],
    dns: [{ kind: "dns", record: "NS", recordName: "askone.org", expected: "ns1.example.net, ns2.example.net", name: "Domain nameservers", purpose: "Catches a DNS move." }],
  } }));
  expect(html).toContain("DNS: issue. TLS: unknown. Frontend: issue.");
  expect(html).toContain("NS askone.org"); expect(html).toContain("ns1.example.net, ns2.example.net");
  expect(html).toContain("without signing in"); expect(html).toContain("2xx after redirects");
});
it("does not turn absent evidence into an all-clear", () => {
  const html = renderToStaticMarkup(createElement(DependencyResults, { report: { checks: [], dns: [] } }));
  expect(html).toContain("No sign-in provider could be identified"); expect(html).toContain("unread scripts can hide one");
});
