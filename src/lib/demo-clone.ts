import { z } from "zod";

export const demoSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/);
const monitorType = z.enum(["http", "ssl", "dns", "tcp", "heartbeat", "supabase", "stripe", "mcp"]);
/** Eligible targets are part of the copy. Excluded monitors carry no target, even if a
 * future source query accidentally returns one. Neither branch admits config or source ids. */
export const demoPreviewSchema = z.object({
  app: z.object({ name: z.string(), url: z.string().nullable(),
    accent: z.string().regex(/^#[0-9a-f]{6}$/i).nullable().default(null),
    logoUrl: z.string().regex(/^\/page-assets\/asset_[0-9a-f]{32}$/).nullable().default(null) }),
  page: z.object({ name: z.string() }),
  monitors: z.array(z.discriminatedUnion("copyable", [
    z.object({ name: z.string(), type: z.enum(["http", "ssl", "dns", "tcp"]), copyable: z.literal(true), target: z.string() }),
    z.object({ name: z.string(), type: monitorType, copyable: z.literal(false) }),
  ])),
});
export type DemoPreview = z.infer<typeof demoPreviewSchema>;
export const cloneReceiptSchema = z.object({
  appId: z.string().regex(/^app_[0-9a-f]{24}$/), pageId: z.string().regex(/^page_[0-9a-f]{24}$/),
  copied: z.array(z.string()),
  /** Monitors the copy made by itself, beside the copied ones: an HTTPS address's free certificate check. */
  added: z.array(z.string()).default([]),
  skipped: z.array(z.object({ name: z.string(), reason: z.enum(["needs_key", "monitor_limit", "host_limit", "assertion_limit"]) })),
});
export type CloneReceipt = z.infer<typeof cloneReceiptSchema>;
/** Names as a sentence's list: "A", "A and B", "A, B and C". */
export const nameList = (names: readonly string[]) =>
  names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
export const cloneSkipReason: Record<CloneReceipt["skipped"][number]["reason"], string> = {
  needs_key: "needs your own key", monitor_limit: "monitor limit reached",
  host_limit: "per-host limit reached", assertion_limit: "more assertions than your plan allows",
};
