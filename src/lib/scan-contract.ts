import { z } from "zod";
import { ipVersion, isLocalName, isPublicIp } from "./ip";
import { projectRef, restrictedKey } from "./service-monitor";
import { isPublishableKey } from "./supabase-detect";

export const scanUrl = z.string().trim().max(2048).refine(value => {
  try {
    const u = new URL(value); const host = u.hostname.replace(/^\[|\]$/g, "");
    return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash &&
      (!u.port || ["80", "443"].includes(u.port)) && !isLocalName(host) && (!ipVersion(host) || isPublicIp(host));
  } catch { return false; }
}, "Use a public HTTP(S) URL on port 80 or 443, without credentials, query parameters or a fragment.");
export const scanInput = z.object({
  url: scanUrl.describe("Public app URL. No credentials or query parameters."),
  stripe_key: z.string().max(220).refine(restrictedKey).optional().describe("Restricted Stripe key, used once and never stored."),
  supabase_url: z.string().max(100).refine(v => !!projectRef(v)).optional().describe("Supabase project URL; supply its publishable key too."),
  supabase_key: z.string().max(2000).optional().describe("Project publishable or matching legacy anon key. Used once, never stored."),
  crons: z.array(z.object({ name: z.string().min(1).max(80).describe("Cron job name from the repository."), schedule: z.string().min(1).max(100).describe("Cron schedule from the repository configuration."),
    heartbeat: z.enum(["configured", "not_found", "unknown"]).default("unknown").describe("Whether a matching heartbeat mapping was supplied; not a delivery test.") }).strict()).max(50).optional()
    .describe("Repository cron findings from the CLI. No file contents or local paths."),
}).strict().refine(v => !!v.supabase_url === !!v.supabase_key && (!v.supabase_key || isPublishableKey(v.supabase_key, projectRef(v.supabase_url!)!)),
  "Supply the Supabase project URL and its publishable key together.");
export type ScanInput = z.infer<typeof scanInput>;
const result = z.object({ state: z.enum(["ok", "issue", "unknown", "skipped"]), message: z.string(), expires_at: z.string().nullable().optional() });
const dependencyState = z.enum(["ok", "issue", "unknown", "skipped"]);
export const dependencyReport = z.object({
  checks: z.array(z.object({ provider: z.enum(["Clerk", "Supabase Auth", "Firebase Auth", "Auth0", "Auth.js", "First-party dependency"]),
    host: z.string(), url: z.string(), keyword: z.string(), purpose: z.string(), dns: dependencyState, tls: dependencyState, frontend: dependencyState,
    status: z.number().optional(), ms: z.number().optional(), reason: z.string().max(500).optional() })),
  dns: z.array(z.object({ kind: z.literal("dns"), record: z.enum(["NS", "CNAME"]), recordName: z.string(), expected: z.string(), name: z.string(), purpose: z.string() })),
});
export const scanOutput = z.object({
  checked_at: z.string(), certificate: result, domain: result,
  status_page: z.object({ state: z.enum(["found", "unknown"]), url: z.string().nullable(), message: z.string() }),
  dependencies: dependencyReport,
  supabase: result.extend({ steps: z.array(z.object({ name: z.string(), ok: z.boolean(), status: z.number().optional() })) }),
  stripe: result.extend({ failed_events: z.number().nullable(), pending_events: z.number().nullable() }),
  crons: z.array(z.object({ name: z.string(), schedule: z.string(), heartbeat: z.enum(["configured", "not_found", "unknown"]) })),
  crons_message: z.string(), mcp: z.literal("Coming soon"),
});
export type ScanResult = z.infer<typeof scanOutput>;
