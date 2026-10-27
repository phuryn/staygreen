import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, webServer } from "./tests/e2e/web-server";
import { STATE } from "./tests/e2e/support/accounts";

/* The authenticated suite (`docs/TESTS.md § The authenticated mile`): the real Clerk development
   instance and real sessions. `globalSetup` fetches the testing token (before any worker exists,
   so every worker inherits it), finds or creates the two test accounts and their organizations,
   and deletes everything their workspaces own; the teardown deletes it again. The `sign-in`
   project then signs each account in through Clerk's own `<SignIn />` and saves the session the
   journeys run on. */

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/support/auth-setup.ts",
  globalTeardown: "./tests/e2e/support/auth-teardown.ts",
  fullyParallel: false,
  // The journeys share two accounts and their workspaces; one at a time keeps them honest.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/e2e-auth",
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Pinned for the same reason as the public suite: the palette is not left to a default.
    colorScheme: "light",
  },
  projects: [
    { name: "sign-in", testMatch: /sign-in\.setup\.ts/, use: { ...devices["Desktop Chrome"], colorScheme: "light" } },
    {
      name: "desktop",
      testMatch: /\.auth\.spec\.ts/,
      dependencies: ["sign-in"],
      use: { ...devices["Desktop Chrome"], colorScheme: "light", storageState: STATE.a },
    },
  ],
  webServer,
});
