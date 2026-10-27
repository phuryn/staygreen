import { clerkMiddleware } from "@clerk/nextjs/server";

/* Next 16's middleware. It attaches the Clerk session and writes the CSP, and
   decides nothing else (`AGENTS.md § 1.5`): every page and every action checks
   for itself.

   `strict: true` issues a nonce per request with `'strict-dynamic'`, and sets
   the policy on the request headers too, so Next's own scripts carry the same
   nonce. The root layout hands it to `<ClerkProvider>` from `x-nonce`
   (`docs/integrations.md § Clerk › The CSP header`). */

export default clerkMiddleware({
  contentSecurityPolicy: {
    strict: true,
    directives: {
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      // Clerk's sign-in and sign-up draw a background pattern as a `data:` SVG; without this the
      // browser refuses it and logs an error on every visit. An image can't run script.
      // Page assets are served by this host; no wildcard or new external image origin.
      "img-src": ["'self'", "data:"],
    },
  },
});

export const config = {
  matcher: [
    // Assets have their own restrictive CSP and never need a nonce. Random page-asset paths attach
    // a session, since a members-only page's images authorize in their route; the sessionless badge
    // keeps its own policy. Machine routes verify their own Bearer credential: session refresh must
    // never redirect a 401 or OAuth discovery to a browser sign-in page.
    "/((?!_next|mcp(?:/|$)|api/(?:v1|scan)(?:/|$)|\\.well-known/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/api/((?!(?:v1|scan)(?:/|$)).*)",
    "/trpc(.*)",
  ],
};
