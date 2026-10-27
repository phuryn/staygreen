import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { MemberContact } from "./clerk";
import { composeOpened, composeResolved, composeTest, emailText, linksFor, whyLine, type Message } from "./compose";
import { unsubscribeToken, unsubscribeUrls } from "./links";
import type { SendResult } from "./outcome";
import { findSent, sendEmail, type PostmarkConfig } from "./postmark";
import type { Rpc } from "./rpc";
import { sendTelegram, telegramText, type TelegramConfig } from "./telegram";
import { open } from "../seal";
import { channelContext } from "./channel-input";
import { sendSlack, sendDiscord } from "./providers";
import { sendWebhook, webhookPayload, WEBHOOK_RETRY_MINUTES, type WebhookTransport } from "./webhook";

/* The alert sender (`docs/emails.md`, `docs/telegram.md`): one pass turns new events into
   receipts and delivers what is due, then stops at its deadline. Wherever it runs (the Worker
   cron each minute, a test sent from the dashboard, a
   Telegram chat just bound), it is this function, with its dependencies passed in.

   Exactly once, as far as each provider allows:
   - **Receipts first.** `alert_expand` writes one receipt per event, channel and recipient, unique
     in the table, before anything is sent; expanding twice adds nothing.
   - **One sender per receipt.** `alert_claim` hands a receipt to one claim at a time
     (`for update skip locked`), so two senders, or a scheduled run and a dashboard test, never
     both send it.
   - **A retry is a retry only when the provider said no.** A definite refusal, or a request that
     never left, goes back to `pending` with a backoff. An answer that never came (a timeout, a
     dropped connection, a crash between the provider's acceptance and our mark) is never sent
     blind again:
       - email: the receipt stays claimed; once the claim's lease (`LEASE_SEC`) is over, the next
         sender asks Postmark's message search for the receipt's id, marks it sent if Postmark has
         it, and sends it only if Postmark doesn't;
       - Telegram, which can't be asked: the receipt fails, in words saying it may have arrived.
   - **A stale claim never sends.** Each receipt is sent only within `FRESH_CLAIM_MS` of its claim,
     well inside the lease, so a sender that stalls can't send a receipt another sender has taken
     over.

   Postmark's search shows a message a few seconds after accepting it and flickers for a few
   seconds more (measured), so it is asked only once the lease is over: at least 170 s after
   Postmark could have accepted the message (sent within `FRESH_CLAIM_MS`, a 10 s timeout).

   What remains (said in `docs/emails.md`): a request Postmark accepts more than about three
   minutes after the sender gave up on it, or a search not settled by then, could still send an
   email twice; and a Telegram message whose answer was lost is reported as possibly sent, never
   retried. */

export const LEASE_SEC = 300;
export const FRESH_CLAIM_MS = 120_000;
export const MAX_ATTEMPTS = 8;
const BACKOFF_SEC = [30, 60, 120, 300, 600, 1800, 3600];

/** Seconds before a receipt's next try, after `attempts` tries. */
export const retryAfterSec = (attempts: number) => BACKOFF_SEC[Math.max(1, Math.min(attempts, BACKOFF_SEC.length)) - 1];

export type SenderDeps = {
  rpc: Rpc;
  /** Null when this server has no Postmark token: email receipts wait, and say why. */
  postmark: PostmarkConfig | null;
  /** Null when this server has no Telegram bot token. */
  telegram: TelegramConfig | null;
  /** The workspace's members who may read monitors, or null when Clerk couldn't be read. */
  members: (clerkOrgId: string) => Promise<MemberContact[] | null>;
  /** `ALERT_LINK_SECRET`, which signs every email's unsubscribe link. */
  linkSecret: Buffer | null;
  appUrl: string;
  now?: () => number;
  log?: (line: string) => void;
  /** Only the independent Worker gets the new transports and their decryption key. */
  channels?: { key: Buffer; fetch?: typeof fetch; webhook: WebhookTransport };
};

export type RunOptions = {
  /** How long the pass may run, from its start. */
  deadlineMs?: number;
  /** Only this event: a test sent from the dashboard, or a Telegram chat's first message. */
  eventId?: string;
  batch?: number;
  claimId?: string;
};

export type RunReport = {
  expanded: number;
  sent: number;
  failed: number;
  skipped: number;
  retrying: number;
  reconciled: number;
  inDoubt: number;
  released: number;
  /** The provider's id for each message this pass sent or found already sent. */
  messageIds: string[];
  /** Our words for each receipt that failed, for a dashboard test to show. */
  failures: string[];
};

const pendingDto = z.array(
  z.object({ id: z.string(), kind: z.string(), workspaceId: z.string(), clerkOrgId: z.string(), needsMembers: z.boolean() }),
);
const expandDto = z.object({ status: z.enum(["missing", "done", "wait", "members_required", "expanded"]), deliveries: z.number().optional() });
const ms = z.string().transform((t) => Date.parse(t));
const claimedDto = z.array(
  z.object({
    id: z.string(),
    event: z.enum(["opened", "resolved", "test"]),
    eventId: z.string(),
    attempts: z.number(),
    inDoubt: z.boolean(),
    recipient: z.string(),
    workspaceId: z.string(),
    clerkOrgId: z.string(),
    createdAt: ms,
    channel: z
      .object({
        id: z.string(),
        kind: z.string(),
        audience: z.enum(["members", "address"]).nullable(),
        address: z.string().nullable(),
        chatId: z.string().nullable(),
        sealed: z.string().nullable().optional(),
      })
      .nullable(),
    why: z.enum(["channel_removed", "unsubscribed", "unconfirmed", "excluded"]).nullable(),
    stateAfter: z.string().nullable(),
    incident: z
      .object({
        id: z.string(),
        title: z.string(),
        severity: z.string(),
        openedAt: ms,
        resolvedAt: ms.nullable(),
        evidence: z.record(z.string(), z.unknown()),
      })
      .nullable(),
    monitor: z.object({ id: z.string(), name: z.string(), type: z.string() }).nullable(),
    app: z.object({ id: z.string(), name: z.string() }).nullable(),
    pageSlug: z.string().nullable(),
    parentProviderId: z.string().nullable().optional(),
    webhookBody: z.string().nullable().optional(),
    webhookStartedAt: ms.nullable().optional(),
    webhookAttempts: z.number().optional(),
  }),
);
export type Claimed = z.infer<typeof claimedDto>[number];

/** Why a claimed receipt can't be sent, in the words the deliveries list shows. */
export const SKIPPED: Record<NonNullable<Claimed["why"]>, string> = {
  channel_removed: "Its channel was removed before it went.",
  unsubscribed: "Unsubscribed before it went.",
  unconfirmed: "The channel isn't confirmed.",
  excluded: "This channel stopped alerting this app before it went.",
};

/** A Telegram send whose answer never came: it may have arrived, and Telegram can't be asked. */
export const TELEGRAM_IN_DOUBT = "Telegram didn't confirm it. It may have arrived, so it wasn't sent again.";

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The message a receipt carries, or null when what it is about is gone. */
export function messageFor(d: Claimed, appUrl: string, tz: string | null, now: number): Message | null {
  if (d.event === "test") return composeTest(appUrl, tz, now);
  if (!d.incident || !d.monitor || !d.app) return null;
  const e = d.incident.evidence;
  const incident = {
    ...d.incident,
    evidence: {
      request: str(e.request),
      summary: str(e.summary),
      status: typeof e.status === "number" ? e.status : undefined,
      assertion: str(e.assertion),
      got: typeof e.got === "boolean" || typeof e.got === "number" || e.got === null ? String(e.got) : str(e.got),
      locations: Array.isArray(e.locations) ? e.locations.filter((l): l is string => typeof l === "string") : [],
      snippet: str(e.snippet),
    },
  };
  const about = { appName: d.app.name, monitorName: d.monitor.name, monitorType: d.monitor.type, pageSlug: d.pageSlug };
  const links = linksFor(appUrl, d.incident.id, d.pageSlug);
  return d.event === "opened" ? composeOpened(incident, about, links, tz) : composeResolved(incident, about, links, d.stateAfter, tz);
}

const zero = (): RunReport => ({ expanded: 0, sent: 0, failed: 0, skipped: 0, retrying: 0, reconciled: 0, inDoubt: 0, released: 0, messageIds: [], failures: [] });

type Mark = { providerId?: string; detail?: string; retrySec?: number; redirected?: boolean };
type Channel = NonNullable<Claimed["channel"]>;

export async function runSender(deps: SenderDeps, opts: RunOptions = {}): Promise<RunReport> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const deadline = now() + (opts.deadlineMs ?? 20_000);
  const claimId = opts.claimId ?? `snd_${randomBytes(12).toString("base64url")}`;
  const report = zero();
  const roster = new Map<string, Promise<MemberContact[] | null>>();
  const membersOf = (org: string) => {
    if (!roster.has(org)) roster.set(org, deps.members(org).catch(() => null));
    return roster.get(org)!;
  };

  // ── receipts first ──────────────────────────────────────────────────────
  const events = pendingDto.parse(await deps.rpc("alert_pending_events", { p_limit: 100, p_event_id: opts.eventId ?? null }));
  for (const e of events) {
    if (now() > deadline) break;
    let ids: string[] | null = null;
    if (e.needsMembers) {
      const members = await membersOf(e.clerkOrgId);
      // Not now: the event stays unexpanded and the next pass reads Clerk again.
      if (!members) {
        log(`event ${e.id}: members unreadable, left for the next pass`);
        continue;
      }
      ids = members.map((m) => m.userId);
    }
    const r = expandDto.parse(await deps.rpc("alert_expand", { p_event_id: e.id, p_members: ids }));
    if (r.status === "expanded") report.expanded++;
  }

  // ── then deliver ────────────────────────────────────────────────────────
  const mark = async (d: Claimed, status: "sent" | "failed" | "skipped" | "pending", extra: Mark = {}) => {
    const settled = await deps.rpc("alert_mark", {
      p_id: d.id,
      p_claim: claimId,
      p_status: status,
      p_provider_id: extra.providerId ?? null,
      p_detail: extra.detail ?? null,
      p_retry_sec: extra.retrySec ?? null,
      p_redirected: extra.redirected ?? null,
    });
    if (settled !== true) log(`delivery ${d.id}: another sender holds it now`);
    return settled === true;
  };
  const fail = async (d: Claimed, detail: string) => {
    await mark(d, "failed", { detail });
    report.failed++;
    report.failures.push(detail);
  };
  const skip = async (d: Claimed, detail: string) => {
    await mark(d, "skipped", { detail });
    report.skipped++;
  };
  const later = async (d: Claimed, detail: string, retrySec = retryAfterSec(d.attempts)) => {
    if (d.channel?.kind === "webhook") {
      const attempts = d.webhookAttempts ?? 0;
      if (attempts >= 6) return fail(d, `Gave up after the initial delivery and five retries. ${detail}`);
      const due = (d.webhookStartedAt ?? now()) + WEBHOOK_RETRY_MINUTES[Math.max(0, attempts - 1)] * 60_000;
      await mark(d, "pending", { retrySec: Math.max(1, Math.ceil((due - now()) / 1000)), detail });
      report.retrying++;
      return;
    }
    if (d.attempts >= MAX_ATTEMPTS) return fail(d, `Gave up after ${d.attempts} tries. ${detail}`);
    await mark(d, "pending", { retrySec, detail });
    report.retrying++;
  };

  /** What the provider answered, recorded on the receipt. */
  const settle = async (d: Claimed, result: SendResult) => {
    switch (result.kind) {
      case "sent":
        report.sent++;
        report.messageIds.push(result.messageId);
        try {
          await mark(d, "sent", { providerId: result.messageId, redirected: result.redirected });
        } catch {
          // Sent, and not marked: the receipt stays claimed. Email is settled by the search once
          // the lease is over; Telegram's fails as possibly sent, and is never sent again.
          report.inDoubt++;
        }
        return;
      case "rejected":
        return fail(d, result.detail);
      case "retry":
        return later(d, result.detail, Math.max(retryAfterSec(d.attempts), result.retryAfterSec ?? 0));
      case "unknown":
        if (d.channel?.kind === "telegram") return fail(d, TELEGRAM_IN_DOUBT);
        if (d.channel?.kind === "slack" || d.channel?.kind === "discord") return fail(d, `${d.channel.kind === "slack" ? "Slack" : "Discord"} didn't confirm it. It may have arrived, so it wasn't sent again.`);
        if (d.channel?.kind === "webhook") return later(d, result.detail);
        log(`delivery ${d.id}: ${result.detail}`);
        report.inDoubt++;
        return;
    }
  };

  const deliverEmail = async (d: Claimed, channel: Channel) => {
    if (!deps.postmark || !deps.linkSecret) return later(d, "Email isn't set up on this server yet.");
    let to: string | null;
    let tz: string | null = null;
    if (channel.audience === "members") {
      const members = await membersOf(d.clerkOrgId);
      if (!members) return later(d, "Couldn't read the workspace's members from Clerk.", 60);
      const m = members.find((x) => x.userId === d.recipient);
      if (!m) return skip(d, "No longer a member who can see monitors.");
      if (!m.email) return skip(d, "Has no verified email address.");
      to = m.email;
      tz = m.timezone;
    } else {
      to = channel.address;
    }
    const message = messageFor(d, deps.appUrl, tz, now());
    if (!to || !message) return skip(d, "What it was about is gone.");

    const urls = unsubscribeUrls(deps.appUrl, unsubscribeToken(deps.linkSecret, d.id));
    const text = emailText(message, { why: whyLine(channel.audience ?? "address", d.app?.name ?? null), unsubscribeUrl: urls.page });
    let result: SendResult;
    try {
      result = await sendEmail(deps.postmark, {
        to,
        subject: message.subject,
        text,
        tag: d.event === "test" ? "test" : "alert",
        metadata: { delivery: d.id, event: d.event },
        headers: [
          { Name: "List-Unsubscribe", Value: `<${urls.oneClick}>` },
          { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
        ],
      });
    } catch {
      result = { kind: "unknown", detail: "The send stopped before Postmark answered." };
    }
    await settle(d, result);
  };

  const deliverTelegram = async (d: Claimed, channel: Channel) => {
    if (!deps.telegram) return later(d, "Telegram isn't set up on this server yet.");
    if (!channel.chatId) return skip(d, SKIPPED.unconfirmed);
    const message = messageFor(d, deps.appUrl, null, now());
    if (!message) return skip(d, "What it was about is gone.");
    let result: Awaited<ReturnType<typeof sendTelegram>>;
    try {
      result = await sendTelegram(deps.telegram, channel.chatId, telegramText(message, whyLine("chat", d.app?.name ?? null)));
    } catch {
      result = { kind: "unknown", detail: "The send stopped before Telegram answered." };
    }
    await settle(d, result);
    // Blocked or removed: every channel bound to that chat stops, as `/stop` would.
    if (result.kind === "rejected" && result.gone) await deps.rpc("telegram_stop", { p_chat_id: Number(channel.chatId) });
  };

  const deliver = async (d: Claimed) => {
    if (d.inDoubt) {
      // A claim older than the lease: its sender may have reached the provider. Ask before sending.
      if (d.channel?.kind === "telegram") return fail(d, TELEGRAM_IN_DOUBT);
      if (d.channel?.kind === "slack" || d.channel?.kind === "discord") return settle(d, { kind: "unknown", detail: "The previous send was not confirmed." });
      if (d.channel?.kind === "email" && !deps.postmark) {
        report.inDoubt++; // no way to ask Postmark from here: left claimed for a sender that can
        return;
      }
      if (d.channel?.kind === "email" && deps.postmark) {
        const found = await findSent(deps.postmark, "delivery", d.id);
        if (found.kind === "found") {
          await mark(d, "sent", { providerId: found.messageId, redirected: !!deps.postmark.redirectTo });
          report.reconciled++;
          report.messageIds.push(found.messageId);
          return;
        }
        if (found.kind === "error") {
          if (d.attempts >= MAX_ATTEMPTS) return fail(d, "Postmark couldn't say whether it had been sent, so it wasn't sent again.");
          report.inDoubt++; // still claimed; the lease brings it back to the next sender
          return;
        }
        // `none`: Postmark never got it. It is sent below, once.
      }
    }
    if (d.why || !d.channel) return skip(d, SKIPPED[d.why ?? "channel_removed"]);
    if (d.channel.kind === "telegram") return deliverTelegram(d, d.channel);
    if (d.channel.kind === "email") return deliverEmail(d, d.channel);
    if (deps.channels && ["slack", "discord", "webhook"].includes(d.channel.kind)) {
      if (!d.channel.sealed) return fail(d, "This channel has no credential. Remove it and add it again.");
      let credential: { token?: string; channel?: string; url?: string; secret?: string };
      try {
        credential = z.object({ token: z.string().optional(), channel: z.string().optional(), url: z.string().optional(), secret: z.string().optional() })
          .parse(JSON.parse(open(d.channel.sealed, channelContext(d.workspaceId, d.channel.id), deps.channels.key)));
      } catch { return fail(d, "This channel's credential could not be opened."); }
      const message = messageFor(d, deps.appUrl, null, now());
      if (!message) return skip(d, "What it was about is gone.");
      if (d.channel.kind === "slack") {
        if (!credential.token || !credential.channel) return fail(d, "Slack needs to be connected again.");
        if (d.event === "resolved" && !d.parentProviderId) return skip(d, "The opening message wasn't confirmed, so no thread reply was sent.");
        return settle(d, await sendSlack(credential.token, credential.channel, message, d.event === "resolved" ? d.parentProviderId! : null, deps.channels.fetch));
      }
      if (d.channel.kind === "discord") return settle(d, await sendDiscord(credential.url ?? "", message, deps.channels.fetch));
      if (!credential.url || !credential.secret) return fail(d, "The webhook needs to be added again.");
      if ((d.webhookAttempts ?? 0) >= 6) return fail(d, "The webhook exhausted its five retries.");
      const prepared = await deps.rpc("alert_prepare_webhook", { p_id: d.id, p_claim: claimId, p_body: webhookPayload(d, deps.appUrl) });
      if (prepared === null) return; // Another sender owns the claim. No network request.
      const saved = z.object({ body: z.string(), startedAt: ms, attempts: z.number() }).parse(prepared);
      d.webhookStartedAt = saved.startedAt;
      d.webhookAttempts = saved.attempts;
      return settle(d, await sendWebhook(deps.channels.webhook, credential.url, credential.secret, d.id, saved.body, now()));
    }
    return fail(d, "This kind of channel can't send yet.");
  };

  while (now() < deadline) {
    const batch = claimedDto.parse(
      await deps.rpc(deps.channels ? "alert_claim_channels" : "alert_claim", { p_claim: claimId, p_limit: opts.batch ?? 10, p_lease_sec: LEASE_SEC, p_event_id: opts.eventId ?? null }),
    );
    if (!batch.length) break;
    const claimedAt = now();
    for (const d of batch) {
      // Past the deadline, or slow enough that the claim is getting old: hand it back untouched.
      // Our own clock is the point: a receipt claimed too long ago may by now belong to another
      // sender, and only a fresh claim is safe to send on.
      if (now() > deadline || now() - claimedAt > FRESH_CLAIM_MS) {
        if (!d.inDoubt) {
          await mark(d, "pending", { retrySec: 0 });
          report.released++;
        }
        continue;
      }
      try {
        await deliver(d);
      } catch (e) {
        // The database or a provider failed under us. The receipt stays claimed, so the lease
        // brings it back to a later sender, which reconciles it before sending.
        log(`delivery ${d.id}: stopped (${e instanceof Error ? e.name : "error"})`);
        report.inDoubt++;
      }
    }
  }
  return report;
}
