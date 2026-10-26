import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const cron = z.object({ name: z.string().min(1).max(80), schedule: z.string().min(1).max(100), tz: z.literal("UTC").default("UTC") });
export type Cron = z.infer<typeof cron>;
export async function readSmall(path: string) {
  const file = await open(path, "r");
  try {
    // Read one byte beyond the cap rather than trusting a stat that can race a write.
    const bytes = Buffer.alloc(262145); let total = 0;
    while (total < bytes.length) { const { bytesRead } = await file.read(bytes, total, bytes.length - total, total); if (!bytesRead) break; total += bytesRead; }
    if (total > 262144) throw Error("Configuration file exceeds 256 KiB.");
    return bytes.subarray(0, total).toString("utf8");
  } finally { await file.close(); }
}
export function vercelCrons(source: string): Cron[] {
  const input = z.object({ crons: z.array(z.object({ path: z.string().min(1).max(80), schedule: z.string().min(1).max(100) }).strict()).max(50).optional() }).passthrough().parse(JSON.parse(source));
  return (input.crons ?? []).map(c => cron.parse({ name: c.path, schedule: c.schedule }));
}
/** Deliberately accepts only literal schedule entries in named function tables. Any
 * unsupported schedule syntax fails visibly; we never silently provision half the jobs. */
export function netlifyCrons(source: string): Cron[] {
  const out: Cron[] = []; let section = ""; const seen = new Set<string>();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) { section = /^\[functions\.(?:"([^"\\]+)"|'([^']+)'|([A-Za-z0-9_-]+))\]\s*(?:#.*)?$/.exec(line)?.slice(1).find(Boolean) ?? ""; continue; }
    if (!/\bschedule\s*=/.test(line)) continue;
    const match = /^schedule\s*=\s*(?:"([^"\\]+)"|'([^']+)')\s*(?:#.*)?$/.exec(line);
    if (!section || !match || seen.has(section)) throw Error("Use one literal schedule in each [functions.\"job\"] table; unsupported or duplicate cron configuration.");
    seen.add(section); out.push(cron.parse({ name: section, schedule: match[1] ?? match[2] }));
  }
  if (out.length > 50) throw Error("At most 50 crons are supported.");
  return out;
}
export async function repositoryCrons(repo: string): Promise<Cron[]> {
  const out: Cron[] = []; let files = 0;
  for (const [name, parse] of [["vercel.json", vercelCrons], ["netlify.toml", netlifyCrons]] as const) {
    let source: string;
    try { source = await readSmall(join(repo, name)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw Error("Could not read a cron configuration file."); }
    files++; out.push(...parse(source));
  }
  if (!files) throw Error("No vercel.json or netlify.toml found in the repository path.");
  if (out.length > 50 || new Set(out.map(c => c.name)).size !== out.length) throw Error("Cron names must be unique, with at most 50 definitions.");
  return out;
}
export async function cronFindings(crons: Cron[], manifest?: string) {
  const configured = new Set<string>();
  if (manifest) {
    const data = z.object({ heartbeats: z.array(z.object({ name: z.string(), url: z.string() })) }).parse(JSON.parse(await readSmall(manifest)));
    for (const h of data.heartbeats) if (/^https:\/\/in\.staygreen\.io\/.+/.test(h.url)) configured.add(h.name);
  }
  return crons.map(c => ({ name: c.name, schedule: c.schedule, heartbeat: configured.has(c.name) ? "configured" as const : "not_found" as const }));
}
