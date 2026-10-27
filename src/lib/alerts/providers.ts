import { mask } from "../../checks/mask";
import type { Message } from "./compose";
import { discordUrl } from "./channel-input";
import { neverLeft, type SendResult } from "./outcome";

/** Provider JSON is bounded and never copied into errors or logs. */
export async function smallJson(r: Response): Promise<Record<string, unknown> | null> {
  const reader = r.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 64 * 1024) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}

const text = (m: Message) => mask([m.subject, "", ...m.lines].join("\n"));
/** Composer messages end with a blank line and their incident/status links. Keep that
 *  footer whole when Discord's single-embed limit requires shortening the evidence. */
function discordText(m: Message): string {
  const whole = text(m);
  if (whole.length <= 4096) return whole;
  const footer = mask(m.lines.slice(-3).join("\n"));
  const prefix = mask([m.subject, "", ...m.lines.slice(0, -3)].join("\n"));
  return `${prefix.slice(0, Math.max(0, 4096 - footer.length - 3))}\n…\n${footer}`;
}
const uncertain = (name: string): SendResult => ({ kind: "unknown", detail: `${name} didn't confirm acceptance.` });

export async function sendSlack(token: string, channel: string, message: Message, thread: string | null, doFetch: typeof fetch = fetch): Promise<SendResult> {
  try {
    const r = await doFetch("https://slack.com/api/chat.postMessage", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ channel, text: text(message).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"), mrkdwn: false, parse: "none", unfurl_links: false,
        unfurl_media: false, ...(thread ? { thread_ts: thread } : {}) }),
    });
    if (r.status === 429) { await r.body?.cancel(); return { kind: "retry", detail: "Slack asked us to wait.", retryAfterSec: Number(r.headers.get("retry-after")) || 60 }; }
    const data = await smallJson(r);
    if (r.ok && data?.ok === true && typeof data.ts === "string" && /^\d+\.\d+$/.test(data.ts))
      return { kind: "sent", messageId: data.ts, redirected: false };
    // Slack's internal/fatal errors may have performed part of the operation. No blind retry.
    if (r.status >= 500 || !data || data.ok !== false || ["internal_error", "fatal_error"].includes(String(data.error))) return uncertain("Slack");
    return { kind: "rejected", code: r.status, detail: "Slack refused this message. Check the app's access to the selected channel." };
  } catch (e) {
    return neverLeft(e, "manual") ? { kind: "retry", detail: "The Slack request never left." } : uncertain("Slack");
  }
}

export async function sendDiscord(url: string, message: Message, doFetch: typeof fetch = fetch): Promise<SendResult> {
  const u = discordUrl(url);
  if (!u) return { kind: "rejected", code: 400, detail: "The Discord webhook is invalid. Remove this channel and add it again." };
  u.searchParams.set("wait", "true");
  try {
    const r = await doFetch(u, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { "content-type": "application/json" },
      // One message, no chunk sends that could succeed only halfway. Embeds allow the evidence
      // and links to fit together; mentions are disabled even in customer-supplied text.
      body: JSON.stringify({ embeds: [{ description: discordText(message) }], allowed_mentions: { parse: [] } }),
    });
    const data = await smallJson(r);
    if (r.status === 429) return { kind: "retry", detail: "Discord asked us to wait.", retryAfterSec: typeof data?.retry_after === "number" ? Math.ceil(data.retry_after) : 60 };
    if (r.ok && typeof data?.id === "string" && /^\d{1,22}$/.test(data.id)) return { kind: "sent", messageId: data.id, redirected: false };
    if (r.status >= 400 && r.status < 500) return { kind: "rejected", code: r.status, detail: "Discord refused this message. Check or replace the channel webhook." };
    return uncertain("Discord");
  } catch (e) {
    return neverLeft(e, "manual") ? { kind: "retry", detail: "The Discord request never left." } : uncertain("Discord");
  }
}
