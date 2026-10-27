import { smallJson } from "./providers";

export const SLACK_SCOPES = "incoming-webhook,chat:write";
export const slackRedirect = (appUrl: string) => `${appUrl.replace(/\/$/, "")}/api/slack/callback`;
export function slackAuthorize(clientId: string, appUrl: string, state: string): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.search = new URLSearchParams({ client_id: clientId, scope: SLACK_SCOPES, redirect_uri: slackRedirect(appUrl), state }).toString();
  return url.href;
}

export async function exchangeSlack(clientId: string, clientSecret: string, appUrl: string, code: string, doFetch: typeof fetch = fetch) {
  try {
    const r = await doFetch("https://slack.com/api/oauth.v2.access", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: slackRedirect(appUrl) }),
    });
    const data = await smallJson(r);
    const hook = data?.incoming_webhook as Record<string, unknown> | undefined;
    const scopes = typeof data?.scope === "string" ? data.scope.split(",") : [];
    if (!r.ok || data?.ok !== true || !scopes.includes("chat:write") || !scopes.includes("incoming-webhook") ||
        typeof data.access_token !== "string" || !/^xoxb-[A-Za-z0-9-]+$/.test(data.access_token) ||
        typeof hook?.channel_id !== "string" || !/^[CG][A-Z0-9]{1,30}$/.test(hook.channel_id)) return null;
    return { token: data.access_token, channel: hook.channel_id,
      label: typeof hook.channel === "string" ? hook.channel.slice(0, 120) || "Slack channel" : "Slack channel" };
    // The unused incoming webhook URL is deliberately discarded; only the bot token is stored.
  } catch { return null; }
}
