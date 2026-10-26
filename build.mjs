import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL(".", import.meta.url)),
  entryPoints: ["src/cli.ts"], outfile: "dist/cli.js", bundle: true,
  platform: "node", format: "esm", target: "node22",
  banner: { js: "#!/usr/bin/env node" }, logLevel: "warning",
});
