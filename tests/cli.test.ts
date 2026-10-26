import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { netlifyCrons, vercelCrons } from "../src/crons";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "staygreen-cli-"));
  const result = await build({ absWorkingDir: packageRoot, entryPoints: ["src/cli.ts"], bundle: true, platform: "node", format: "esm", target: "node22", write: false, metafile: true });
  for (const input of Object.keys(result.metafile!.inputs)) {
    const path = resolve(packageRoot, input);
    // Only package source and dependencies may enter the public executable.
    expect(path.startsWith(resolve(packageRoot, "src")) || path.includes("node_modules")).toBe(true);
  }
  await writeFile(join(directory, "cli.mjs"), result.outputFiles![0].contents);
});
afterAll(async () => {
  if (directory && resolve(directory).startsWith(resolve(tmpdir(), "staygreen-cli-"))) await rm(directory, { recursive: true, force: true });
});
function run(args: string[], stdin = "", token = "", entry = "cli.mjs") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(directory, entry), ...args], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "test", STAYGREEN_API_TOKEN: token }, windowsHide: true });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(Error("CLI did not exit")); }, 5000);
    child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject); child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}
it("the built executable discovers tools over stdout with no banner, token or app code", async () => {
  const result = await run(["mcp"], '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  expect(result.code).toBe(0); expect(result.stderr).toBe("");
  const message = JSON.parse(result.stdout); expect(message.jsonrpc).toBe("2.0"); expect(message.result.tools).toHaveLength(11);
});
it("runs when started through a link to the file, as npm installs the command on macOS and Linux", async (context) => {
  try { await symlink(join(directory, "cli.mjs"), join(directory, "staygreen")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip(); throw error; }
  const result = await run(["mcp"], '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n', "", "staygreen");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).result.tools).toHaveLength(11);
});
it("lists all three commands in help", async () => {
  const result = await run(["--help"]); expect(result.code).toBe(0);
  for (const command of ["mcp", "scan", "provision"]) expect(result.stdout).toContain(`staygreen ${command}`);
});
it("rejects command-line tokens and malformed environment values without echoing either", async () => {
  for (const result of [await run(["mcp", "--token", "sg_argument_secret"]), await run(["mcp"], "", "sg_environment_secret")]) {
    expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(result.stderr).toContain("Staygreen command failed"); expect(result.stderr).not.toContain("secret");
  }
});
it("keeps local cron parsing standalone and never executes repository code", () => {
  expect(vercelCrons('{"crons":[{"path":"/api/job","schedule":"0 0 * * *"}]}')).toEqual([{ name: "/api/job", schedule: "0 0 * * *", tz: "UTC" }]);
  expect(netlifyCrons('[build]\ncommand = "do not execute"\n[functions."job"]\nschedule = "0 0 * * *"')).toEqual([{ name: "job", schedule: "0 0 * * *", tz: "UTC" }]);
  expect(() => netlifyCrons('schedule = "unsupported"')).toThrow();
});
it("ships an FSL-1.1-MIT package with no installed runtime dependencies", async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  expect(manifest.license).toBe("FSL-1.1-MIT"); expect(manifest.dependencies).toBeUndefined();
  expect(await readFile(join(packageRoot, "LICENSE"), "utf8")).toContain("Pawel Huryn");
});
