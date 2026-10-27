import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, webServer } from "./tests/e2e/web-server";

/* The public suite (`docs/TESTS.md`): the anonymous journey, no account. Nothing from the
   authenticated suite (testing token, test accounts, workspace reset) runs here. Fixtures that
   need rows use the development project's secret key (`tests/e2e/support/rest.ts`). */

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: ["**/*.auth.spec.ts", "**/*.setup.ts"],
  globalSetup: "./tests/e2e/support/public-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/e2e",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    // Pinned: Playwright's default would decide the palette of every assertion that reads one.
    // The product renders both; dark is held by the contrast floors (`tests/unit/tokens-contrast.test.ts`)
    // and by eye until the visual captures exist.
    colorScheme: "light",
  },
  projects: [{ name: "phone", use: { ...devices["Pixel 7"], colorScheme: "light" } }],
  webServer,
});
