import { expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
vi.mock("@clerk/nextjs/server", () => ({ clerkMiddleware: vi.fn() }));
import { config } from "@/proxy";
import { invoicePdfHref } from "@/lib/invoices/page-model";
it("keeps machine routes outside browser-session refresh and leaves public-page CSP intact", () => {
  for (const url of ["/mcp", "/mcp/", "/api/v1", "/api/v1/get_status", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
  expect(unstable_doesMiddlewareMatch({ config, url: "/api/scan" })).toBe(false);
  expect(unstable_doesMiddlewareMatch({ config, url: "/scan" })).toBe(true);
  for (const url of ["/", "/legal/privacy", "/app/agents", "/api/alerts/unsubscribe/token"]) expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
});

it("attaches Clerk to a PDF download even when the document id looks like a static file", () => {
  for (const id of ["doc_1", "invoice.csv", "invoice.docx", "a/b#1.csv"]) {
    expect(unstable_doesMiddlewareMatch({ config, url: invoicePdfHref(id) }), id).toBe(true);
  }
  expect(unstable_doesMiddlewareMatch({ config, url: "/app/invoices/invoice.csv" })).toBe(false);
});
