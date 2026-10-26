import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { inputs, outputs } from "./contract";
import { serveMcp } from "./mcp";
import { call } from "./client";
import { repositoryCrons, cronFindings, readSmall } from "./crons";
import { cliEnv } from "./env";

export async function main(args = process.argv.slice(2), env: Record<string, string | undefined> = process.env) {
  const { positionals, values: v } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: "string" }, heartbeats: { type: "string" }, output: { type: "string" }, name: { type: "string" },
    "api-origin": { type: "string", default: "https://staygreen.io" }, "request-id": { type: "string" },
    "supabase-url": { type: "string" }, "supabase-key-env": { type: "string" }, "stripe-key-env": { type: "string" }, help: { type: "boolean" },
  } });
  if (v.help) { console.log("staygreen mcp [--api-origin <origin>]\nstaygreen scan <url> [--repo .] [--heartbeats private.json]\nstaygreen provision <url> --repo . --output private.json\nOptions: --name, --request-id <uuid>, --api-origin <origin>, --supabase-url, --supabase-key-env <variable>, --stripe-key-env <variable>.\nProvision requires STAYGREEN_API_TOKEN with write scope. MCP calls require STAYGREEN_API_TOKEN except the public scan. Keys are read from environment variables, never command-line values."); return; }
  const [command, url] = positionals;
  if (command === "mcp") {
    if (positionals.length !== 1 || Object.keys(v).some(key => key !== "api-origin")) throw Error("Use staygreen mcp [--api-origin <origin>].");
    await serveMcp({ input: process.stdin, output: process.stdout, origin: v["api-origin"], env }); return;
  }
  if (!["scan", "provision"].includes(command) || !url || positionals.length !== 2) throw Error("Use staygreen mcp, staygreen scan <url> or staygreen provision <url>; see --help.");
  const token = cliEnv.parse(env).STAYGREEN_API_TOKEN;
  if (command === "provision" && (!token || !v.output)) throw Error("Provision requires STAYGREEN_API_TOKEN and --output <private-file> for heartbeat credentials.");
  const secret = (name: string | undefined) => { if (!name) return undefined; if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !env[name]) throw Error("A named credential environment variable is missing."); return env[name]; };
  const common = { url, ...(v["supabase-url"] ? { supabase_url: v["supabase-url"] } : {}),
    ...(v["supabase-key-env"] ? { supabase_key: secret(v["supabase-key-env"]) } : {}), ...(v["stripe-key-env"] ? { stripe_key: secret(v["stripe-key-env"]) } : {}) };
  const crons = v.repo ? await repositoryCrons(resolve(v.repo)) : undefined;
  if (command === "scan") {
    const input = inputs.scan_app.parse({ ...common, ...(crons ? { crons: await cronFindings(crons, v.heartbeats) } : {}) });
    const result = outputs.scan_app.parse(await call(v["api-origin"]!, "scan_app", input, token));
    console.log(JSON.stringify(result, null, 2)); return;
  }
  // Store only the request id before the first request. A lost answer must retry the
  // creating receipt; a new id for the existing URL cannot retrieve heartbeat secrets.
  const output = resolve(v.output!); const requestFile = `${output}.request-id`;
  await mkdir(dirname(output), { recursive: true });
  let requestId = v["request-id"];
  if (!requestId) {
    try { requestId = (await readSmall(requestFile)).trim(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; requestId = randomUUID(); await writeFile(requestFile, requestId, { flag: "wx", mode: 0o600 }); }
  }
  const input = inputs.provision_app.parse({ ...common, request_id: z.uuid().parse(requestId), ...(v.name ? { name: v.name } : {}), ...(crons ? { crons_from: crons } : {}) });
  const result = outputs.provision_app.parse(await call(v["api-origin"]!, "provision_app", input, token));
  // Never overwrite a previous manifest with an existing-app response without credentials.
  if (!result.created) { console.log("App already provisioned. Existing heartbeat credentials remain in the original private output file."); return; }
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  console.log("Monitoring provisioned. Private setup and heartbeat URLs saved to the output file.");
}
// npm starts the command through a link to this file (a symlink on macOS and Linux), so compare
// real paths: comparing the link's own path never matched there, and the command did nothing.
const real = (path: string) => { try { return realpathSync(path); } catch { return null; } };
const invoked = process.argv[1] ? real(resolve(process.argv[1])) : null;
if (invoked && invoked === real(fileURLToPath(import.meta.url)))
  main().catch(() => { console.error("Staygreen command failed. Check --help, inputs, credentials and plan limits. Retry provisioning with the same output file and unchanged inputs."); process.exitCode = 1; });
