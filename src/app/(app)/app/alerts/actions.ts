"use server";

import { z } from "zod";
import { randomBytes } from "node:crypto";
import { seal } from "@/lib/credentials";
import { checkTarget } from "@/lib/targets";
import { channelInput, channelContext, discordUrl, routeInput } from "@/lib/alerts/channel-input";
import { slackAuthorize } from "@/lib/alerts/slack";
import type { Permission } from "@/lib/authz";
import { ALERT_CONFIRM_BUDGET, ALERT_TEST_BUDGET, alertBudgetSpent } from "@/lib/budgets";
import { db } from "@/lib/db";
import { describeDbError, isNotFound, type DbError } from "@/lib/db-errors";
import { env } from "@/lib/env";
import { holds } from "@/lib/plans";
import { assertSameOrigin, CrossOrigin } from "@/lib/request";
import { allowed, memberOrNull, type Member } from "@/lib/workspace";
import { membersOf } from "@/lib/alerts/clerk";
import { composeConfirm, emailText } from "@/lib/alerts/compose";
import { CONFIRM_MAX_AGE_SEC, confirmUrl, newConfirmToken } from "@/lib/alerts/links";
import { sendEmail } from "@/lib/alerts/postmark";
import { deliverNow, emailReady } from "@/lib/alerts/server";
import { postmarkConfig, telegramConfig } from "@/lib/alerts/standalone";
import { botUsername, deepLink, TELEGRAM_LINK_MAX_AGE_SEC } from "@/lib/alerts/telegram";
import type { Refusal, Result } from "../actions";

/* The Alerts screen's writes (`docs/flows.md § Alerts`). The same four steps as every dashboard
   write (`../actions.ts`): the Origin check, the member, the channel resolved by its id inside the
   member's workspace, and the permission there: `channels:manage` for everything that changes
   where alerts go, `monitors:read` for a member turning their own email off or on. A channel of
   another workspace, a missing one and a forbidden one are the same not found.

   What costs more than a row is budgeted per member and per workspace in Postgres
   (`spend_budget`): a test alert sends a real message, and a confirmation email goes to an
   address someone typed. */

const NOT_FOUND = { ok: false, reason: "That isn't here any more. Reload the page." } as const;
const SIGNED_OUT = { ok: false, reason: "Your session has ended. Sign in again to keep going." } as const;
const CROSS_ORIGIN = { ok: false, reason: "This request didn't come from Staygreen, so it was refused." } as const;
const EMAIL_OFF = { ok: false, reason: "Email isn't set up on this server yet, so nothing can be sent." } as const;
const TELEGRAM_OFF = { ok: false, reason: "Telegram isn't set up on this server yet." } as const;

async function begin(permission: Permission): Promise<Member | Refusal> {
  try {
    await assertSameOrigin();
  } catch (e) {
    if (e instanceof CrossOrigin) return CROSS_ORIGIN;
    throw e;
  }
  const member = await memberOrNull();
  if (!member) return SIGNED_OUT;
  return allowed(member.workspace, member.caller, permission) ? member : NOT_FOUND;
}

const isMember = (m: Member | Refusal): m is Member => "caller" in m;

function refused(e: DbError, member: Member): Refusal {
  if (isNotFound(e)) return NOT_FOUND;
  return { ok: false, reason: describeDbError(e, { entitlements: member.entitlements }) };
}

const CHANNEL_ID = /^chan_[0-9a-f]{24}$/;
const APP_ID = /^app_[0-9a-f]{24}$/;

type ChannelRow = { id: string; kind: string; audience: string | null; address: string | null; confirmed_at: string | null; unsubscribed_at: string | null };

/** A channel of the member's own workspace, or null. */
async function channelOf(member: Member, id: string): Promise<ChannelRow | null> {
  if (typeof id !== "string" || !CHANNEL_ID.test(id)) return null;
  const { data, error } = await db()
    .from("alert_channels")
    .select("id, kind, audience, address, confirmed_at, unsubscribed_at")
    .eq("id", id)
    .eq("workspace_id", member.workspace.id)
    .maybeSingle();
  if (error) throw new Error(`alert channel read failed: ${error.code}`);
  return data;
}

const budgetAnswer = z.object({ ok: z.boolean(), scope: z.enum(["member", "workspace"]).optional(), retryAfterSec: z.number().int().positive().optional() });

async function spend(member: Member, action: "alert_test" | "alert_confirm"): Promise<Refusal | null> {
  const b = action === "alert_test" ? ALERT_TEST_BUDGET : ALERT_CONFIRM_BUDGET;
  const { data, error } = await db().rpc("spend_budget", {
    p_workspace_id: member.workspace.id,
    p_action: action,
    p_user_id: member.caller.userId,
    p_member_limit: b.member.limit,
    p_member_window_sec: b.member.windowSec,
    p_workspace_limit: b.workspace.limit,
    p_workspace_window_sec: b.workspace.windowSec,
  });
  if (error) return refused(error, member);
  const r = budgetAnswer.parse(data);
  return r.ok ? null : { ok: false, reason: alertBudgetSpent(action, r.scope ?? "member"), retryAfterSec: r.retryAfterSec ?? 60 };
}

/** The confirmation email, through the same Postmark path as alerts (redirected in development). */
async function sendConfirmation(member: Member, channelId: string, address: string, token: string): Promise<{ sent: boolean; detail?: string }> {
  const cfg = postmarkConfig(env());
  if (!cfg) return { sent: false, detail: EMAIL_OFF.reason };
  const { data: apps } = await db().from("apps").select("name").eq("workspace_id", member.workspace.id).order("created_at");
  const message = composeConfirm((apps ?? []).map((a) => a.name), confirmUrl(env().APP_URL, token), Math.round(CONFIRM_MAX_AGE_SEC / 86_400));
  const r = await sendEmail(cfg, {
    to: address,
    subject: message.subject,
    text: [...message.lines, ""].join("\n"),
    tag: "confirm",
    metadata: { channel: channelId },
  });
  return r.kind === "sent" ? { sent: true } : { sent: false, detail: r.kind === "unknown" ? "Postmark didn't answer, so the email may or may not have gone. Send it again if it doesn't arrive." : r.detail };
}

// ── email addresses ─────────────────────────────────────────────────────────

const addressSchema = z.object({ address: z.email("That address is missing something. It should look like oncall@yourapp.com.").max(254) });

/** An address that isn't a member's, on Builder (`notify_teammates`): it gets nothing until its
 *  owner follows the link in the confirmation email. */
export async function addAlertAddress(input: { address: string }): Promise<Result<{ id: string; sent: boolean; detail?: string }>> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  if (!holds(member.entitlements, "notify_teammates")) return { ok: false, reason: "Teammates without an account come with Builder." };
  if (!emailReady()) return EMAIL_OFF;
  const parsed = addressSchema.safeParse({ address: typeof input?.address === "string" ? input.address.trim().toLowerCase() : "" });
  if (!parsed.success) return { ok: false, reason: "Check the address.", fieldErrors: { address: parsed.error.issues[0].message } };
  const address = parsed.data.address;
  const roster = await membersOf(env().CLERK_SECRET_KEY, member.workspace.clerk_org_id);
  if (roster?.some((m) => m.email?.toLowerCase() === address)) {
    return { ok: false, reason: "Check the address.", fieldErrors: { address: "That's a member's address. Members get alerts already." } };
  }
  const over = await spend(member, "alert_confirm");
  if (over) return over;
  const token = newConfirmToken();
  const { data, error } = await db().rpc("create_alert_address", {
    p_workspace_id: member.workspace.id,
    p_address: address,
    p_confirm_hash: token.hash,
    p_created_by: member.caller.userId,
    p_notify_teammates: holds(member.entitlements, "notify_teammates"),
  });
  if (error) return refused(error, member);
  return { ok: true, id: data.id, ...(await sendConfirmation(member, data.id, address, token.token)) };
}

/** A new confirmation link for an address still waiting; the old link stops working. */
export async function resendAlertConfirmation(channelId: string): Promise<Result<{ sent: boolean; detail?: string }>> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  const c = await channelOf(member, channelId);
  if (!c || c.audience !== "address") return NOT_FOUND;
  if (c.confirmed_at) return { ok: false, reason: "That address is already confirmed." };
  if (!emailReady()) return EMAIL_OFF;
  const over = await spend(member, "alert_confirm");
  if (over) return over;
  const token = newConfirmToken();
  const { data, error } = await db()
    .from("alert_channels")
    .update({ confirm_hash: token.hash, confirm_sent_at: new Date().toISOString() })
    .eq("id", c.id)
    .eq("workspace_id", member.workspace.id)
    .is("confirmed_at", null)
    .select("id");
  if (error) return refused(error, member);
  if (!data?.length) return NOT_FOUND;
  return { ok: true, ...(await sendConfirmation(member, c.id, c.address ?? "", token.token)) };
}

// ── every channel ───────────────────────────────────────────────────────────

/** Removes an address or a Telegram chat. Its receipts stay in the log; nothing more is sent there.
 *  The members' channel is the workspace's own and can't be removed. */
export async function removeAlertChannel(channelId: string): Promise<Result> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  const c = await channelOf(member, channelId);
  if (!c) return NOT_FOUND;
  if (c.audience === "members") return { ok: false, reason: "Members always get alerts. Each member can turn their own email off." };
  const { error } = await db().from("alert_channels").delete().eq("id", c.id).eq("workspace_id", member.workspace.id).or("audience.is.null,audience.neq.members");
  if (error) return refused(error, member);
  return { ok: true };
}

/** Whether a channel alerts an app. Every channel alerts every app, new ones included, until it is
 *  turned off for one here. */
export async function setAlertRoute(channelId: string, appId: string, on: boolean): Promise<Result> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  const c = await channelOf(member, channelId);
  if (!c || typeof appId !== "string" || !APP_ID.test(appId) || typeof on !== "boolean") return NOT_FOUND;
  const { data: app, error: appError } = await db().from("apps").select("id").eq("id", appId).eq("workspace_id", member.workspace.id).maybeSingle();
  if (appError) return refused(appError, member);
  if (!app) return NOT_FOUND;
  const { error } = on
    ? await db().from("alert_exclusions").delete().eq("channel_id", c.id).eq("app_id", appId).eq("workspace_id", member.workspace.id)
    : await db().from("alert_exclusions").upsert({ channel_id: c.id, app_id: appId, workspace_id: member.workspace.id }, { onConflict: "channel_id,app_id", ignoreDuplicates: true });
  if (error) return refused(error, member);
  return { ok: true };
}

/** A test through the same path as an alert: an event, its receipt, the sender. On the members'
 *  channel it goes to the member who asked, never to everyone. */
export async function sendTestAlert(channelId: string): Promise<Result<{ sent: boolean; detail: string | null; messageId: string | null }>> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  const c = await channelOf(member, channelId);
  if (!c) return NOT_FOUND;
  if (!c.confirmed_at) return { ok: false, reason: c.kind === "telegram" ? "This chat isn't connected yet." : "This address isn't confirmed yet." };
  if (c.unsubscribed_at) return { ok: false, reason: c.kind === "telegram" ? "This chat sent /stop. Connect it again to get alerts there." : "This address unsubscribed. Remove it and add it again to ask once more." };
  if (c.kind === "email" && !emailReady()) return EMAIL_OFF;
  if (c.kind === "telegram" && !telegramConfig(env())) return TELEGRAM_OFF;
  if (c.audience === "members") {
    const { data: off } = await db().from("alert_suppressions").select("recipient").eq("channel_id", c.id).eq("recipient", member.caller.userId).maybeSingle();
    if (off) return { ok: false, reason: "You turned your own alert email off. Turn it on to get a test." };
  }
  const over = await spend(member, "alert_test");
  if (over) return over;
  const { data: ev, error } = await db()
    .from("alert_events")
    .insert({ workspace_id: member.workspace.id, kind: "test", channel_id: c.id, requested_by: member.caller.userId })
    .select("id")
    .single();
  if (error) return refused(error, member);
  if (["slack", "discord", "webhook"].includes(c.kind)) return { ok: true, sent: false, detail: "It's queued and goes out within a minute.", messageId: null };
  const r = await deliverNow(ev.id);
  if (r.sent || r.reconciled) return { ok: true, sent: true, detail: null, messageId: r.messageIds[0] ?? null };
  const detail = r.failures[0] ?? (r.skipped ? "It was skipped: the member who asked can't be reached by email." : "It's queued and goes out within a minute.");
  return { ok: true, sent: false, detail, messageId: null };
}

/** A member's own alert email on the members' channel, off or back on. Anyone who can read the
 *  workspace may choose this for themselves, and only for themselves. */
export async function setMyAlertEmail(on: boolean): Promise<Result> {
  const member = await begin("monitors:read");
  if (!isMember(member)) return member;
  if (typeof on !== "boolean") return NOT_FOUND;
  const { data: c, error } = await db().from("alert_channels").select("id").eq("workspace_id", member.workspace.id).eq("audience", "members").maybeSingle();
  if (error) return refused(error, member);
  if (!c) return NOT_FOUND;
  const q = on
    ? await db().from("alert_suppressions").delete().eq("channel_id", c.id).eq("recipient", member.caller.userId)
    : await db().from("alert_suppressions").upsert({ channel_id: c.id, workspace_id: member.workspace.id, recipient: member.caller.userId }, { onConflict: "channel_id,recipient", ignoreDuplicates: true });
  if (q.error) return refused(q.error, member);
  return { ok: true };
}

// ── Telegram ────────────────────────────────────────────────────────────────

/** A one-time deep link to the bot. Pressing Start in Telegram binds that chat, and a test alert
 *  arrives in it (`docs/telegram.md`). */
export async function connectTelegram(): Promise<Result<{ id: string; link: string; expiresInMin: number }>> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  const cfg = telegramConfig(env());
  if (!cfg) return TELEGRAM_OFF;
  const username = await botUsername(cfg);
  if (!username) return { ok: false, reason: "Telegram didn't answer. Try again in a moment." };
  const code = newConfirmToken();
  const { data, error } = await db().rpc("create_telegram_link", { p_workspace_id: member.workspace.id, p_code_hash: code.hash, p_created_by: member.caller.userId });
  if (error) return refused(error, member);
  return { ok: true, id: data, link: deepLink(username, code.token), expiresInMin: TELEGRAM_LINK_MAX_AGE_SEC / 60 };
}

/** Whether the link's chat has been bound yet, for the dialog that waits on it. */
export async function telegramLinkState(channelId: string): Promise<Result<{ state: "waiting" | "bound" | "gone"; label: string | null }>> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  if (typeof channelId !== "string" || !CHANNEL_ID.test(channelId)) return NOT_FOUND;
  const { data, error } = await db().from("alert_channels").select("confirmed_at, label").eq("id", channelId).eq("workspace_id", member.workspace.id).eq("kind", "telegram").maybeSingle();
  if (error) return refused(error, member);
  // A chat already bound in this workspace keeps its channel and the link's is dropped: "gone".
  if (!data) return { ok: true, state: "gone", label: null };
  return { ok: true, state: data.confirmed_at ? "bound" : "waiting", label: data.label };
}

/** A pasted credential is write-only. The name, never its URL, is the browser's saved view. */
export async function addWebhookChannel(input: unknown): Promise<Result<{ id: string }>> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  const parsed = channelInput.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "Check the channel details.", fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])) };
  const v = parsed.data;
  const over = await spend(member, "alert_confirm");
  if (over) return over;
  if (v.kind === "webhook") {
    const checked = await checkTarget(new URL(v.url).hostname.replace(/^\[|\]$/g, ""));
    if (!checked.ok) return { ok: false, reason: "The webhook must resolve only to public addresses. Check the address and try again." };
  }
  const id = `chan_${randomBytes(12).toString("hex")}`;
  const credential = v.kind === "discord" ? { url: discordUrl(v.url)!.href } : { url: v.url, secret: v.secret };
  const { error } = await db().from("alert_channels").insert({ id, workspace_id: member.workspace.id,
    kind: v.kind, label: v.label, sealed: seal(JSON.stringify(credential), channelContext(member.workspace.id, id)),
    confirmed_at: new Date().toISOString(), created_by: member.caller.userId });
  if (error) return refused(error, member);
  return { ok: true, id };
}

export async function connectSlack(): Promise<Result<{ url: string }>> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  const e = env();
  if (!e.SLACK_CLIENT_ID || !e.SLACK_CLIENT_SECRET) return { ok: false, reason: "Slack isn't configured yet." };
  const over = await spend(member, "alert_confirm");
  if (over) return over;
  const state = newConfirmToken();
  await db().from("slack_installs").delete().eq("workspace_id", member.workspace.id).lt("created_at", new Date(Date.now() - 600_000).toISOString());
  const { error } = await db().from("slack_installs").insert({ state_hash: state.hash, workspace_id: member.workspace.id, user_id: member.caller.userId });
  if (error) return refused(error, member);
  return { ok: true, url: slackAuthorize(e.SLACK_CLIENT_ID, e.APP_URL, state.token) };
}

export async function saveAlertRouting(input: unknown): Promise<Result> {
  const member = await begin("channels:manage");
  if (!isMember(member)) return member;
  const parsed = routeInput.safeParse(input);
  if (!parsed.success) return NOT_FOUND;
  const v = parsed.data;
  if (v.severity !== "all" && !holds(member.entitlements, "alert_rules")) return { ok: false, reason: "Routing incidents and warnings separately comes with Builder." };
  // The type generator marks every SQL argument without a default non-null; 028's function takes
  // null for the app's own rule (no monitor) and for no channels (the rule is removed).
  const { error } = await db().rpc("set_alert_routing", { p_workspace_id: member.workspace.id, p_app_id: v.appId,
    p_monitor_id: v.monitorId as string, p_severity: v.severity, p_channels: v.channelIds as string[],
    p_alert_rules: holds(member.entitlements, "alert_rules") });
  if (error) return refused(error, member);
  return { ok: true };
}
