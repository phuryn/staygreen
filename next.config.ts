import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { parsePublicEnv, parseServerEnv } from "./src/lib/env-schema";
import { KEPT_SCREEN_S } from "./src/lib/poll";

/* `AGENTS.md § 1.7`: the env schema runs here, at build and at dev start, not
   only on the first request. A `NEXT_PUBLIC_*` value is inlined into the client
   bundle while the build runs, so a check at boot would come after the leak.

   The public half is checked on every run. The server half is checked at dev
   start, and at build whenever the build can see server keys: a host that
   scopes secrets away from the build (Netlify's variable scopes) still has them
   checked on the first request, by `src/lib/env.ts` (`docs/variables.md`). */

const SERVER_KEYS = ["APP_URL", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "CLERK_SECRET_KEY", "CREDENTIALS_KEY", "HEARTBEAT_HOST", "HEARTBEAT_TOKEN_KEY"];

export default function config(phase: string): NextConfig {
  const source = process.env as Record<string, string | undefined>;
  parsePublicEnv(source);
  if (phase === PHASE_DEVELOPMENT_SERVER || SERVER_KEYS.some((key) => source[key]?.trim())) parseServerEnv(source);

  return {
    reactStrictMode: true,
    // `next dev` otherwise appends to AGENTS.md and writes a CLAUDE.md (`AGENTS.md § 1.8`).
    agentRules: false,
    devIndicators: false,
    // A Cloudflare quick tunnel shares `next dev` with the owner (`docs/environments.md`); without
    // this, `next dev` refuses its scripts to the tunnel's address and the page never hydrates.
    allowedDevOrigins: ["*.trycloudflare.com"],
    // The browser suites build into their own directory, so they never fight an open `next dev`.
    distDir: process.env.NEXT_DIST_DIR ?? ".next",
    // A dashboard screen visited in the last 30 seconds opens from the router's copy, with no
    // server round trip (`docs/architecture.md § Feeds and polling`). Every `router.refresh()` drops
    // all those copies at once (the poll's, and the one after each write in `useActs`), and so does
    // Clerk on an organization switch, so a kept screen never predates a write or shows another
    // workspace. `KEPT_SCREEN_S` is under the poll's minute (`src/lib/poll.ts`).
    experimental: { staleTimes: { dynamic: KEPT_SCREEN_S } },
    async headers() {
      return [
        {
          // The CSP is Clerk's middleware's (`src/proxy.ts`); these are the static rest.
          source: "/:path*",
          headers: [
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
            { key: "X-Frame-Options", value: "DENY" },
          ],
        },
      ];
    },
  };
}
