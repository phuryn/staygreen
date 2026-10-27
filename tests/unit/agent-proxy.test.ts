import { expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
vi.mock("@clerk/nextjs/server", () => ({ clerkMiddleware: vi.fn() }));
import { config } from "@/proxy";
it("keeps machine routes outside browser-session refresh and leaves public-page CSP intact", () => {
  for (const url of ["/mcp", "/mcp/", "/api/v1", "/api/v1/get_status", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
  expect(unstable_doesMiddlewareMatch({ config, url: "/api/scan" })).toBe(false);
  expect(unstable_doesMiddlewareMatch({ config, url: "/scan" })).toBe(true);
  for (const url of ["/", "/legal/privacy", "/app/agents", "/api/alerts/unsubscribe/token"]) expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
});
