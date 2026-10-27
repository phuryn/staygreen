import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { clerkHost, detectDependencies, MAX_DEPENDENCIES, registrableDomain, sameDomain } from "@/lib/dependency-detect";

// Synthetic fixtures following primary signatures, read 2026-10-23 (no live credentials):
// Clerk key encoding: https://clerk.com/blog/refactoring-our-api-keys
// Clerk script: https://clerk.com/docs/js-frontend/getting-started/quickstart
// AskOne's custom-domain shape and exact script path: docs/work/3.4c-dependencies.md.
// Firebase config/helper: https://firebase.google.com/docs/auth/web/redirect-best-practices
// and firebase/firebase-js-sdk packages/auth/src/platform_browser/iframe/iframe.ts.
// Auth0 config: https://github.com/auth0/auth0-spa-js#configure-the-sdk ; discovery:
// https://auth0.com/docs/get-started/applications/configure-applications-with-oidc-discovery
// Auth.js provider list/signinUrl: https://next-auth.js.org/getting-started/rest-api
// Supabase GoTrue health: https://github.com/supabase/auth/blob/master/internal/api/health.go
// First-party URLs are actual script/fetch addresses, not a provider signature.
const fixtures = JSON.parse(readFileSync("tests/fixtures/dependencies/catalog.json", "utf8")) as { provider: string; page: string; html: string; host: string; path: string; keyword: string }[];
const key = (host: string, mode = "live") => `pk_${mode}_${Buffer.from(host + "$").toString("base64")}`;
it.each(fixtures)("detects $provider from its documented page signature", f => {
  const found = detectDependencies(f.html.replace("CLERK_KEY", key(f.host)), f.page);
  expect(found).toContainEqual(expect.objectContaining({ provider: f.provider, host: f.host, url: `https://${f.host}${f.path}`, keyword: f.keyword }));
  expect(found.filter(t => t.provider === "Clerk")).toHaveLength(f.provider === "Clerk" ? 1 : 0);
  expect(JSON.stringify(found)).not.toContain("pk_live_");
});
it.each(["live", "test"])("finds a Clerk %s key in inline hydration, data attributes and script addresses", mode => {
  const token = key("clerk.askone.org", mode);
  for (const html of [`<script>self.__next_f.push([1,'{\\"publishableKey\\":\\"${token}\\"}'])</script>`, `<div data-clerk-publishable-key="${token}"></div>`, `<script src="https://cdn.example.com/load.js?key=${token}"></script>`]) {
    expect(detectDependencies(html, "https://askone.org")).toMatchObject([{ provider: "Clerk", host: "clerk.askone.org" }]);
  }
});
it("does not mistake prose, comments, generic domain config or a provider CDN for an installed tenant", () => {
  expect(detectDependencies(`<p>${key("clerk.askone.org")}</p><!-- <script>const k='${key("clerk.askone.org")}'</script> --><script>const config={domain:'other.example.com'};</script><script src="https://cdn.auth0.com/js/auth0-spa-js.js"></script>`, "https://askone.org")).toEqual([]);
});
it("reads Auth0 tenant URLs, Auth.js cookie names and first-party policy hosts without exposing cookie values", () => {
  expect(detectDependencies('<script>fetch("https://tenant.eu.auth0.com/authorize")</script>', "https://app.example.com")[0]).toMatchObject({ provider: "Auth0", host: "tenant.eu.auth0.com" });
  const result = detectDependencies("", "https://app.example.com", { "set-cookie": ["__Secure-authjs.session-token=secret; Secure"], "content-security-policy": "connect-src 'self' https://api.example.com" });
  expect(result.map(t => t.provider)).toEqual(["Auth.js"]);
  expect(JSON.stringify(result)).not.toContain("secret");
});
it("uses the suffix list for sibling hosts, including private hosting suffixes", () => {
  expect(registrableDomain("www.example.co.uk")).toBe("example.co.uk");
  expect(sameDomain("auth.example.co.uk", "app.example.co.uk")).toBe(true);
  expect(sameDomain("auth.attacker.co.uk", "app.example.co.uk")).toBe(false);
  expect(sameDomain("alice.github.io", "bob.github.io")).toBe(false);
  expect(detectDependencies('<script src="https://auth.attacker.co.uk/auth.js"></script>', "https://app.example.co.uk")).toEqual([]);
});
it("keeps first-party ownership with the original app after a hosted redirect", () => {
  const html = '<script src="https://auth.hosted.example/login.js"></script><script src="https://accounts.askone.org/login.js"></script>';
  expect(detectDependencies(html, "https://app.hosted.example/", {}, "https://askone.org/")).toMatchObject([{ provider: "First-party dependency", host: "accounts.askone.org" }]);
});
it("keeps an HTTP Auth.js provider route on the app's own origin", () => {
  expect(detectDependencies('<a href="/api/auth/signin">Sign in</a>', "http://app.example.com/")).toMatchObject([{ provider: "Auth.js", url: "http://app.example.com/api/auth/providers" }]);
});
it.each(["localhost", "10.0.0.1", "metadata.internal", "clerk.example.com:8443", "user:pass@example.com", "example.com/path", "example.com?key=x"])("refuses an unsafe encoded Clerk host: %s", host => {
  expect(clerkHost(key(host))).toBeNull();
  expect(detectDependencies(`<script>const key='${key(host)}'</script>`, "https://app.example.com")).toEqual([]);
});
it("refuses malformed keys and credential-bearing script URLs, and caps the catalogue", () => {
  expect(clerkHost("pk_live_" + Buffer.from("clerk.example.com").toString("base64"))).toBeNull();
  expect(detectDependencies('<script src="https://user:pass@clerk.example.com/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>', "https://app.example.com")).toEqual([]);
  const html = Array.from({ length: 20 }, (_, i) => `<script>const key='${key(`clerk${i}.example.com`)}'</script>`).join("");
  expect(detectDependencies(html, "https://app.example.com")).toHaveLength(MAX_DEPENDENCIES);
});
it("never reflects a Clerk key embedded in a first-party endpoint path", () => {
  const token = key("clerk.example.com");
  const found = detectDependencies(`<script src="https://api.example.com/load/${token}"></script>`, "https://app.example.com");
  expect(found).toMatchObject([{ provider: "Clerk", host: "clerk.example.com" }]);
  expect(JSON.stringify(found)).not.toContain(token);
});
