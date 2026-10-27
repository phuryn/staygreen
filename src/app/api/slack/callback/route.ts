import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { allowed, memberOrNull } from "@/lib/workspace";
import { seal } from "@/lib/credentials";
import { channelContext } from "@/lib/alerts/channel-input";
import { hashConfirmToken } from "@/lib/alerts/links";
import { exchangeSlack } from "@/lib/alerts/slack";

/** No code, token, state or provider error is reflected, logged or rendered. The one-use state
 *  binds this cross-site callback to the same verified user and workspace that began it. */
export async function GET(req: Request) {
  const e = env();
  const finish = (status: string) => {
    const r = NextResponse.redirect(new URL(`/app/alerts?slack=${status}`, e.APP_URL), 303);
    r.headers.set("Cache-Control", "no-store");
    r.headers.set("Referrer-Policy", "no-referrer");
    return r;
  };
  const q = new URL(req.url).searchParams;
  const state = q.get("state");
  const code = q.get("code");
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || !e.SLACK_CLIENT_ID || !e.SLACK_CLIENT_SECRET) return finish("failed");
  const member = await memberOrNull();
  if (!member || !allowed(member.workspace, member.caller, "channels:manage")) return finish("failed");
  const { data, error } = await db().rpc("consume_slack_install", { p_hash: hashConfirmToken(state), p_workspace_id: member.workspace.id, p_user_id: member.caller.userId });
  if (error || !data) return finish("failed");
  if (q.has("error")) return finish("cancelled");
  if (!code || code.length > 512 || !/^[A-Za-z0-9_.-]+$/.test(code)) return finish("failed");
  const auth = await exchangeSlack(e.SLACK_CLIENT_ID, e.SLACK_CLIENT_SECRET, e.APP_URL, code);
  if (!auth) return finish("failed");
  const id = `chan_${randomBytes(12).toString("hex")}`;
  const { error: saved } = await db().from("alert_channels").insert({ id, workspace_id: member.workspace.id,
    kind: "slack", label: auth.label, confirmed_at: new Date().toISOString(), created_by: member.caller.userId,
    sealed: seal(JSON.stringify({ token: auth.token, channel: auth.channel }), channelContext(member.workspace.id, id)) });
  return finish(saved ? "failed" : "connected");
}
