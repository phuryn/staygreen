"use server";

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/lib/db";
import { describeDbError, isNotFound } from "@/lib/db-errors";
import { cloneReceiptSchema, demoSlugSchema, type CloneReceipt } from "@/lib/demo-clone";
import { loadDemoPreview } from "@/lib/demo-clone-data";
import { pageSlugBase } from "@/lib/page-slug";
import { holds } from "@/lib/plans";
import { assertSameOrigin, CrossOrigin } from "@/lib/request";
import { allowed, memberOrNull } from "@/lib/workspace";
import type { Refusal } from "../../actions";

export type CloneResult = ({ ok: true } & CloneReceipt) | (Refusal & { duplicateAppId?: string; appLimit?: boolean });

/** Only the source slug comes from the browser. Identity, destination, quotas and all fields
 * copied are re-read on the server; the RPC commits the entire copy or nothing. */
export async function cloneDemo(slug: string): Promise<CloneResult> {
  try { await assertSameOrigin(); }
  catch (e) {
    if (e instanceof CrossOrigin) return { ok: false, reason: "This request didn't come from Staygreen, so it was refused." };
    throw e;
  }
  const member = await memberOrNull();
  if (!member) return { ok: false, reason: "Your session has ended. Sign in again to keep going." };
  const missing = { ok: false, reason: "That demo isn't here any more. Reload the page." } as const;
  if (!allowed(member.workspace, member.caller, "monitors:write") || !allowed(member.workspace, member.caller, "pages:manage")
    || !demoSlugSchema.safeParse(slug).success) return missing;
  const preview = await loadDemoPreview(slug);
  if (!preview) return missing;
  const q = db();
  const budget = await q.rpc("spend_budget", { p_workspace_id: member.workspace.id, p_user_id: member.caller.userId,
    p_action: "demo_clone", p_member_limit: 5, p_member_window_sec: 60, p_workspace_limit: 20, p_workspace_window_sec: 60 });
  if (budget.error) return { ok: false, reason: "That didn't save. Try again in a moment." };
  const admission = z.object({ ok: z.boolean(), retryAfterSec: z.number().optional() }).parse(budget.data);
  if (!admission.ok) return { ok: false, reason: "Wait a moment before cloning again.", retryAfterSec: admission.retryAfterSec };
  const L = member.entitlements.limits;
  const base = pageSlugBase(preview.app.name);
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await q.rpc("clone_demo_page", {
      p_workspace_id: member.workspace.id, p_source_slug: slug,
      p_slug: attempt === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`,
      p_max_apps: L.apps, p_max_pages: L.statusPages, p_max_monitors: L.monitors, p_max_assertions: L.assertions,
      p_per_host: typeof L.perHost === "number" ? L.perHost : L.monitors,
      p_http_interval_sec: L.httpIntervalMin * 60, p_white_label: holds(member.entitlements, "white_label"),
    });
    if (!error) {
      const duplicate = z.object({ duplicateAppId: z.string().regex(/^app_[0-9a-f]{24}$/) }).safeParse(data);
      if (duplicate.success) return { ok: false, reason: "You already have an app with that name. Open it to manage its checks.", ...duplicate.data };
      return { ok: true, ...cloneReceiptSchema.parse(data) };
    }
    // Retrying a slug collision retries a rolled-back transaction; no partial app is left.
    if (error.code === "23505" && /status_pages_slug_key/.test(error.message)
      || error.code === "23514" && /status_pages_(edge_)?slug_check/.test(error.message)) continue;
    if (isNotFound(error)) return missing;
    return { ok: false, reason: describeDbError(error, { entitlements: member.entitlements }), appLimit: error.message === "app_limit" };
  }
  return { ok: false, reason: "Couldn't find a free address for this page. Try again." };
}
