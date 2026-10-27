import type { PlaywrightTestConfig } from "@playwright/test";

/* The one server every browser suite runs against (`docs/TESTS.md`): the public suite and the
   authenticated one. Port, build directory, `APP_URL` and every optional
   configuration a suite's meaning depends on are declared here and nowhere else, so the suites
   can't drift apart and a developer's `.env` can't decide what they assert. A server started by
   hand copies `env` below, not memory. */

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3101);
export const BASE_URL = `http://localhost:${E2E_PORT}`;

export const webServer: PlaywrightTestConfig["webServer"] = {
  command: `npx next build && npx next start -p ${E2E_PORT}`,
  url: `${BASE_URL}/health`,
  // A reused server can be a build from before your change; a busy port fails loudly instead.
  reuseExistingServer: false,
  timeout: 300_000,
  stdout: "ignore",
  stderr: "pipe",
  env: {
    // Its own build directory, so the suite never fights an open `next dev`.
    NEXT_DIST_DIR: ".next-e2e",
    // Links to the app that leave the request are built from this: the README badge's Markdown,
    // which `journeys.auth.spec.ts` reads back against `BASE_URL`.
    APP_URL: BASE_URL,
    // Every ping URL a suite sees names production's host, whatever a developer's `.env` says.
    HEARTBEAT_HOST: "in.staygreen.io",
    // Empty, so the day a component reads these a developer's `.env` still can't change a run.
    // Nothing reads either yet (`docs/variables.md`).
    NEXT_PUBLIC_CLARITY_PROJECT_ID: "",
    NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "",
    // Off: no simulated plan. `next start` runs in production mode, where the override is
    // ignored anyway; the unit suite covers both sides (`tests/unit/dev-plan.test.ts`).
    DEV_PLAN_OVERRIDE: "",
    // Exercise the local status routes without reaching a deployed renderer.
    STATUS_EDGE_ENABLED: "off",
    NEXT_PUBLIC_STATUS_HOST: "status.staygreen.io",
    STATUS_DOMAIN_SUFFIX: "domains.staygreen.io",
    EDGE_CONTROL_SECRET: "",
    // Alerts off: a browser suite never reaches Postmark or Telegram, whatever `.env` holds, and
    // the Alerts screen renders its "not set up" state (`docs/emails.md`, `docs/telegram.md`).
    POSTMARK_SERVER_TOKEN: "",
    EMAIL_FROM: "",
    ALERT_LINK_SECRET: "",
    EMAIL_REDIRECT_TO: "",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_WEBHOOK_SECRET: "",
    SLACK_CLIENT_ID: "",
    SLACK_CLIENT_SECRET: "",
  },
};
