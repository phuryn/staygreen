import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/* Two projects in one run (`docs/TESTS.md § Script contract`): `unit` fakes the
   database, identity and the browser; `integration` makes the development
   Postgres real and loads `.env` for it. A missing credential skips the
   integration files loudly, never silently (`§ Rules that came from bugs`). */

const src = fileURLToPath(new URL("./src", import.meta.url));
// `server-only` throws outside a React Server bundle; under Node it guards nothing.
const serverOnly = fileURLToPath(new URL("./tests/support/server-only.ts", import.meta.url));

const resolve = { alias: { "@": src, "server-only": serverOnly } };

// supabase-js builds its Realtime client on construction and needs a global WebSocket, which
// Node 20 has only behind a flag; the host runs Node 22 (`docs/integrations.md § Supabase`).
// The forked workers inherit NODE_OPTIONS.
if (typeof globalThis.WebSocket === "undefined" && !process.env.NODE_OPTIONS?.includes("--experimental-websocket")) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --experimental-websocket`.trim();
}

export default defineConfig({
  test: {
    projects: [
      { resolve, test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
      // `npm run golive:check` only (`docs/RELEASE.md § Go live`): development sells ahead of the code.
      { resolve, test: { name: "golive", include: ["tests/golive/**/*.test.ts"], environment: "node" } },
      // `npm run test:live` only (`docs/TESTS.md`): real sites over the network, never in the gate.
      { resolve, test: { name: "live", include: ["tests/live/**/*.test.ts"], environment: "node", testTimeout: 60_000, maxConcurrency: 3 } },
      {
        resolve,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/support/load-env.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          // One development database: files run one after another so fixtures never race.
          fileParallelism: false,
        },
      },
    ],
  },
});
