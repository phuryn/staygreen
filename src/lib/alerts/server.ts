import "server-only";
import { z } from "zod";
import { db } from "../db";
import { env } from "../env";
import type { Member } from "../workspace";
import { membersOf, type MemberContact } from "./clerk";
import { CONFIRM_MAX_AGE_SEC } from "./links";
import { rpcFromSupabase, type Rpc } from "./rpc";
import { runSender, type RunReport } from "./sender";
import { postmarkConfig, senderDeps, telegramConfig } from "./standalone";
import { TELEGRAM_LINK_MAX_AGE_SEC } from "./telegram";

/* Alerts as the dashboard's server sees them: the Alerts screen's read (`loadAlertsView`), and the
   sender run for one event right now (`deliverNow`), for a test sent from the screen and a Telegram
   chat just bound. Both through the same sender and receipts the scheduled run uses
   (`sender.ts`); this file only supplies the server's own client and keys. */

export const alertsRpc = (): Rpc => rpcFromSupabase(db() as never);

export const emailReady = () => !!postmarkConfig(env()) && !!env().ALERT_LINK_SECRET;
export const telegramReady = () => !!telegramConfig(env());

/** Sends one event's receipts now, inside a request: a few seconds, then the scheduled sender has
 *  whatever is left. */
export function deliverNow(eventId: string): Promise<RunReport> {
  return runSender(senderDeps(env(), alertsRpc()), { eventId, deadlineMs: 8_000 });
}

export type ChannelState = "on" | "waiting" | "expired" | "stopped";

export type ChannelView = {
  id: string;
  kind: "email" | "telegram" | "slack" | "discord" | "webhook";
  audience: "members" | "address" | null;
  label: string;
  state: ChannelState;
  /** When the confirmation email or the Telegram link was made, while it waits. */
  waitingSince: number | null;
  createdByYou: boolean;
  appsOff: string[];
};

export type MemberView = { userId: string; name: string; email: string | null; you: boolean; off: boolean };

export type DeliveryView = {
  id: string;
  event: "opened" | "resolved" | "test";
  status: "pending" | "sending" | "sent" | "failed" | "skipped";
  detail: string | null;
  attempts: number;
  providerId: string | null;
  redirected: boolean;
  channelId: string | null;
  kind: ChannelView["kind"] | null;
  /** Who it went to, in the screen's words: a member's name, an address, a chat. */
  to: string;
  incidentId: string | null;
  incidentTitle: string | null;
  at: number;
  sentAt: number | null;
};

export type AlertsView = {
  /** The base every link in a message starts with, for the preview. */
  appUrl: string;
  email: { ready: boolean; redirectTo: string | null };
  telegram: { ready: boolean };
  slack: { ready: boolean };
  routes: { appId: string; monitorId: string | null; severity: string; channelIds: string[] }[];
  channels: ChannelView[];
  /** Null when Clerk couldn't be read just now. */
  members: MemberView[] | null;
  deliveries: DeliveryView[];
};

const time = z.string().transform((t) => Date.parse(t));
const overviewDto = z.object({
  channels: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["email", "telegram", "slack", "discord", "webhook"]),
      audience: z.enum(["members", "address"]).nullable(),
      address: z.string().nullable(),
      label: z.string().nullable(),
      confirmedAt: time.nullable(),
      confirmSentAt: time.nullable(),
      unsubscribedAt: time.nullable(),
      createdAt: time,
      createdBy: z.string().nullable(),
      appsOff: z.array(z.string()),
      suppressed: z.array(z.string()),
    }),
  ),
  deliveries: z.array(
    z.object({
      id: z.string(),
      event: z.enum(["opened", "resolved", "test"]),
      status: z.enum(["pending", "sending", "sent", "failed", "skipped"]),
      detail: z.string().nullable(),
      attempts: z.number(),
      providerId: z.string().nullable(),
      redirected: z.boolean(),
      channelId: z.string().nullable(),
      recipient: z.string(),
      incidentId: z.string().nullable(),
      incidentTitle: z.string().nullable(),
      createdAt: time,
      sentAt: time.nullable(),
    }),
  ),
});
type Overview = z.infer<typeof overviewDto>;

function stateOf(c: Overview["channels"][number], now: number): ChannelState {
  if (c.unsubscribedAt) return "stopped";
  if (c.confirmedAt) return "on";
  const maxAge = c.kind === "telegram" ? TELEGRAM_LINK_MAX_AGE_SEC : CONFIRM_MAX_AGE_SEC;
  return c.confirmSentAt && now - c.confirmSentAt > maxAge * 1000 ? "expired" : "waiting";
}

function labelOf(c: Overview["channels"][number]): string {
  if (c.audience === "members") return "Workspace members";
  if (c.kind === "email") return c.address ?? "Email address";
  return c.label ?? (c.confirmedAt ? "Telegram chat" : "Telegram link");
}

export async function loadAlertsView(member: Member): Promise<AlertsView> {
  const e = env();
  const [overview, roster, routes, routeChannels] = await Promise.all([
    db().rpc("alert_overview", { p_workspace_id: member.workspace.id, p_limit: 50 }),
    membersOf(e.CLERK_SECRET_KEY, member.workspace.clerk_org_id).catch(() => null as MemberContact[] | null),
    db().from("alert_routes").select("id, app_id, monitor_id, severity").eq("workspace_id", member.workspace.id),
    db().from("alert_route_channels").select("route_id, channel_id").eq("workspace_id", member.workspace.id),
  ]);
  if (overview.error) throw new Error(`alert_overview failed: ${overview.error.code}`);
  if (routes.error || routeChannels.error) throw new Error("Alert routing could not be read");
  const o = overviewDto.parse(overview.data);
  const now = Date.now();
  const me = member.caller.userId;
  const membersChannel = o.channels.find((c) => c.audience === "members");
  const suppressed = new Set(membersChannel?.suppressed ?? []);
  const byId = new Map(o.channels.map((c) => [c.id, c]));
  const names = new Map((roster ?? []).map((m) => [m.userId, m.userId === me ? "You" : m.name]));

  return {
    appUrl: e.APP_URL,
    email: { ready: emailReady(), redirectTo: e.EMAIL_REDIRECT_TO ?? null },
    telegram: { ready: telegramReady() },
    slack: { ready: !!e.SLACK_CLIENT_ID && !!e.SLACK_CLIENT_SECRET },
    routes: (routes.data ?? []).map((r) => ({ appId: r.app_id, monitorId: r.monitor_id, severity: r.severity,
      channelIds: (routeChannels.data ?? []).filter((c) => c.route_id === r.id).map((c) => c.channel_id) })),
    channels: o.channels.map((c) => ({
      id: c.id,
      kind: c.kind,
      audience: c.audience,
      label: labelOf(c),
      state: stateOf(c, now),
      waitingSince: c.confirmedAt ? null : c.confirmSentAt,
      createdByYou: c.createdBy === me,
      appsOff: c.appsOff,
    })),
    members: roster
      ? roster.map((m) => ({ userId: m.userId, name: m.userId === me ? "You" : m.name, email: m.email, you: m.userId === me, off: suppressed.has(m.userId) }))
      : null,
    deliveries: o.deliveries.map((d) => {
      const c = d.channelId ? byId.get(d.channelId) : undefined;
      const to = !c ? "A removed channel" : c.audience === "members" ? (names.get(d.recipient) ?? "A former member") : labelOf(c);
      return {
        id: d.id,
        event: d.event,
        status: d.status,
        detail: d.detail,
        attempts: d.attempts,
        providerId: d.providerId,
        redirected: d.redirected,
        channelId: d.channelId,
        kind: c?.kind ?? null,
        to,
        incidentId: d.incidentId,
        incidentTitle: d.incidentTitle,
        at: d.createdAt,
        sentAt: d.sentAt,
      };
    }),
  };
}
