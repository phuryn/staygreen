import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({ envDir: false, test: { environment: "node", include: ["tests/contracts/invoice-service.live.test.ts"], setupFiles: [], fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000 },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } } });
