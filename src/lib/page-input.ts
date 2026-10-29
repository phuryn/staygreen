import { statusHost } from "./status-host";
import { z } from "zod";

/* What the status page editor and the incident note form send, validated the
   same way in the browser and in `actions.ts` (`AGENTS.md § 1.2`). The table
   checks in `supabase/migrations/` hold the same rules a third time, for a
   write that skips both. Pure and browser-safe. */

export const NOTE_STATES = ["investigating", "identified", "monitoring", "resolved"] as const;

/** Names Staygreen's own hosts use; SQL also refuses the fixed names; the configured host label is reserved here. */
export const RESERVED_SLUGS = [...new Set(["www", "api", "app", "admin", "domains", "edge", "in", "mail", "mcp", "status", "staygreen", "help", "docs", "health", "ask", "page-assets", "w", "robots", "favicon", "summary", "badge", statusHost().split(".")[0]])];

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** What's wrong with a link, or null. It fails closed: an address a browser can't parse can't be
 *  checked for credentials, so it isn't stored either (`https://user:pass@host:99999`). */
function linkProblem(v: string): string | null {
  if (v === "") return null;
  if (!/^https?:\/\/\S+$/.test(v)) return "Start with https://, or leave it empty";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "That isn't an address a browser can open. Check it for a typo";
  }
  if (u.username || u.password) return "Leave the credentials out: everyone who opens the status page gets this link";
  return null;
}

/** An address visitors are handed: an app's, which its new status page takes as the homepage
 *  link, and the homepage link itself. Case-sensitive, like the tables' own checks (`apps.url`,
 *  `status_pages.homepage`): the two must agree. No credentials, because everyone who opens the
 *  page gets the link in full, whatever it shows of it. */
export const linkSchema = z
  .string()
  .trim()
  .max(2048, "Addresses run to 2,048 characters")
  .superRefine((v, ctx) => {
    const problem = linkProblem(v);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export const pageDraftSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG, "Up to 40 lowercase letters, digits and dashes, starting and ending with a letter or digit")
    .refine((s) => !RESERVED_SLUGS.includes(s), "That address is reserved. Pick another"),
  name: z.string().trim().min(1, "Give the page a name").max(80, "Names run to 80 characters"),
  logoText: z.string().trim().max(40, "Logo text runs to 40 characters"),
  homepage: linkSchema,
  accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "A colour like #1F2DE6"),
  theme: z.enum(["light", "dark", "visitor"]),
  poweredBy: z.boolean(),
  noindex: z.boolean(),
  membersOnly: z.boolean().optional(),
  demo: z.boolean().optional(),
  historyDays: z.union([z.literal(30), z.literal(90)]),
  components: z
    .array(
      z.object({
        name: z.string().trim().min(1, "Every component needs a name").max(80, "Component names run to 80 characters"),
        inApp: z.boolean(),
        monitorIds: z.array(z.string().regex(/^mon_[0-9a-f]{24}$/)).max(50),
      }),
    )
    .max(50, "A page shows at most 50 components"),
});

export type PageDraft = z.input<typeof pageDraftSchema>;

/** The first problem per field, keyed the way the editor names its fields. */
export function pageDraftErrors(draft: unknown): Record<string, string> {
  const r = pageDraftSchema.safeParse(draft);
  if (r.success) return {};
  const out: Record<string, string> = {};
  for (const issue of r.error.issues) out[String(issue.path[0] ?? "form")] ??= issue.message;
  return out;
}
