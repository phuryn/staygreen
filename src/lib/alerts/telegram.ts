import { timingSafeEqual } from "node:crypto";
import { hashConfirmToken, isConfirmToken } from "./links";
import { neverLeft, type SendResult } from "./outcome";
import type { Message } from "./compose";
import type { Rpc } from "./rpc";

/* Telegram's Bot API, with plain `fetch` (`docs/telegram.md`): the bot sends alerts to the chats
   bound to a workspace's Telegram channels, and reads the updates that bind and unbind them.

   Binding (`spec.md § 5`): the Alerts screen makes a link `t.me/<bot>?start=<code>` whose code is
   256 random bits, good once and for `TELEGRAM_LINK_MAX_AGE_SEC`; only its SHA-256 is stored. The
   builder presses Start, Telegram sends the bot `/start <code>` from that chat, and
   `handleUpdate` binds the chat and queues a test alert to it, which is the message that says it
   worked. `/stop`, or removing the bot from the chat, stops every channel bound to the chat.

   Updates arrive at the sender Worker's webhook in both environments. Telegram sends the
   registered secret in its header, checked before any body read or database call. Each
   environment has a separate bot (`docs/telegram.md`).


   Telegram has no idempotency key and no way to ask whether a message arrived, so a send whose
   answer never came is never repeated: its receipt fails with words saying it may have arrived
   (`sender.ts`). Pure: the token is passed in, never read from the environment here, and never
   appears in what this returns or logs. */

export const TELEGRAM_API = "https://api.telegram.org";

/** How long a Telegram link works, from when the Alerts screen made it. */
export const TELEGRAM_LINK_MAX_AGE_SEC = 60 * 60;

/** Telegram's limit on a message's text. */
const MAX_TEXT = 4096;

export type TelegramConfig = { token: string; timeoutMs?: number; fetch?: typeof fetch };

type ApiAnswer = { ok?: unknown; result?: unknown; error_code?: unknown; description?: unknown; parameters?: { retry_after?: unknown } };

const SEND_TIMEOUT_MS = 10_000;

function call(cfg: TelegramConfig, method: string, body: unknown, timeoutMs = cfg.timeoutMs ?? SEND_TIMEOUT_MS) {
  return (cfg.fetch ?? fetch)(`${TELEGRAM_API}/bot${cfg.token}/${method}`, {
    method: "POST",
    // A failure on a redirected hop says nothing about whether the first POST arrived.
    redirect: "manual",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function answer(r: Response): Promise<ApiAnswer | null> {
  try {
    const body = (await r.json()) as ApiAnswer;
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** Telegram's refusal of one message, in our words. The description is matched, never shown. */
function refusal(status: number, description: string): string {
  const d = description.toLowerCase();
  if (status === 403) return "The chat blocked the bot or removed it, so the chat was stopped.";
  if (d.includes("chat not found")) return "Telegram can't find this chat any more.";
  if (d.includes("upgraded to a supergroup")) return "The group became a supergroup; connect it again from the Alerts screen.";
  if (d.includes("too long")) return "Telegram refused the message as too long.";
  return `Telegram refused the message (HTTP ${status}).`;
}

/** Sends `text` to a chat. `gone` is set when Telegram says the bot can't write there any more. */
export async function sendTelegram(cfg: TelegramConfig, chatId: string, text: string): Promise<SendResult & { gone?: boolean }> {
  let r: Response;
  try {
    r = await call(cfg, "sendMessage", { chat_id: chatId, text: text.slice(0, MAX_TEXT), link_preview_options: { is_disabled: true } });
  } catch (e) {
    return neverLeft(e, "manual")
      ? { kind: "retry", detail: "Couldn't reach Telegram." }
      : { kind: "unknown", detail: "Telegram didn't answer in time." };
  }
  if (r.status >= 300 && r.status < 400) return { kind: "unknown", detail: "Telegram redirected the send; it may have arrived." };
  const body = await answer(r);
  if (r.ok) {
    const id = (body?.result as { message_id?: unknown } | undefined)?.message_id;
    if (body?.ok === true && typeof id === "number") return { kind: "sent", messageId: String(id), redirected: false };
    return { kind: "unknown", detail: "Telegram answered without a message id." };
  }
  if (r.status === 429) {
    const after = body?.parameters?.retry_after;
    return { kind: "retry", detail: "Telegram asked us to slow down.", retryAfterSec: typeof after === "number" && after > 0 ? Math.ceil(after) : undefined };
  }
  if (r.status >= 500) return { kind: "retry", detail: `Telegram answered ${r.status}.` };
  if (r.status === 401 || r.status === 404) return { kind: "retry", detail: "Telegram refused the bot's token." };
  const description = typeof body?.description === "string" ? body.description : "";
  return { kind: "rejected", code: r.status, detail: refusal(r.status, description), gone: r.status === 403 };
}

/** The bot's @username, for its deep links, or null when Telegram couldn't be asked. */
export async function botUsername(cfg: TelegramConfig): Promise<string | null> {
  try {
    const r = await call(cfg, "getMe", {});
    const body = await answer(r);
    const username = (body?.result as { username?: unknown } | undefined)?.username;
    return r.ok && body?.ok === true && typeof username === "string" && /^[A-Za-z0-9_]{3,64}$/.test(username) ? username : null;
  } catch {
    return null;
  }
}

export const deepLink = (username: string, code: string) => `https://t.me/${username}?start=${code}`;



/** The plain text an alert carries in Telegram: the subject first, then the body and why. */
export function telegramText(m: Message, why: string): string {
  const text = [m.subject, "", ...m.lines, "", "--", why, "Send /stop to stop Staygreen alerts in this chat."].join("\n");
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`;
}

/** Whether a webhook call carries the secret token the webhook was registered with. */
export function webhookAuthorized(header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

type Chat = { id?: unknown; type?: unknown; title?: unknown; username?: unknown; first_name?: unknown; last_name?: unknown };
type Update = {
  message?: { chat?: Chat; text?: unknown };
  my_chat_member?: { chat?: Chat; new_chat_member?: { status?: unknown } };
};

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** What the Alerts screen calls a chat: a group's title, or the person's @username or name. */
export function chatLabel(chat: Chat): string | null {
  if (chat.type === "private") {
    const user = str(chat.username);
    if (user) return `@${user}`;
    return [str(chat.first_name), str(chat.last_name)].filter(Boolean).join(" ") || null;
  }
  return str(chat.title);
}

/** `/start <code>`, `/start`, `/stop`, each optionally addressed `/start@bot`. */
export function parseCommand(text: unknown): { cmd: "start"; code: string | null } | { cmd: "stop" } | null {
  if (typeof text !== "string") return null;
  const m = /^\/(start|stop)(?:@[A-Za-z0-9_]{3,64})?(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!m) return null;
  return m[1] === "stop" ? { cmd: "stop" } : { cmd: "start", code: m[2] ?? null };
}

/** A chat id as the Bot API gives it: an integer within 52 bits, possibly negative. */
const chatIdOf = (chat: Chat | undefined) =>
  typeof chat?.id === "number" && Number.isSafeInteger(chat.id) && chat.id !== 0 ? String(chat.id) : null;

export type UpdateDeps = {
  rpc: Rpc;
  telegram: TelegramConfig;
  /** Delivers one event now: the sender, narrowed to the bound chat's test. */
  deliver: (eventId: string) => Promise<unknown>;
  appUrl: string;
  log?: (line: string) => void;
};

export type Handled = "bound" | "rebound" | "expired" | "missing" | "help" | "stopped" | "not_stopped" | "removed" | "ignored";

/** One update, from the webhook or a poll. Replies only to the chat that wrote to the bot. */
export async function handleUpdate(deps: UpdateDeps, raw: unknown): Promise<Handled> {
  const u = (raw && typeof raw === "object" ? raw : {}) as Update;
  const alerts = `${deps.appUrl.replace(/\/+$/, "")}/app/alerts`;
  const reply = async (chatId: string, text: string) => {
    const r = await sendTelegram(deps.telegram, chatId, text);
    if (r.kind !== "sent") deps.log?.(`telegram reply not sent: ${r.detail}`);
  };

  // The bot removed from a group, or blocked in a private chat: nothing can reach it any more.
  if (u.my_chat_member) {
    const chatId = chatIdOf(u.my_chat_member.chat);
    const status = u.my_chat_member.new_chat_member?.status;
    if (chatId && (status === "kicked" || status === "left")) {
      await deps.rpc("telegram_stop", { p_chat_id: Number(chatId) });
      return "removed";
    }
    return "ignored";
  }

  const chat = u.message?.chat;
  const chatId = chatIdOf(chat);
  const command = parseCommand(u.message?.text);
  if (!chatId || !chat || !command) return "ignored";

  if (command.cmd === "stop") {
    const n = Number(await deps.rpc("telegram_stop", { p_chat_id: Number(chatId) }));
    await reply(
      chatId,
      n > 0
        ? `Stopped. This chat gets no more Staygreen alerts. Connect it again from the Alerts screen any time: ${alerts}`
        : "This chat isn't getting Staygreen alerts.",
    );
    return n > 0 ? "stopped" : "not_stopped";
  }

  if (!command.code || !isConfirmToken(command.code)) {
    await reply(chatId, `To get Staygreen alerts here, open the Alerts screen and choose Connect Telegram: ${alerts}`);
    return "help";
  }

  const r = (await deps.rpc("bind_telegram_chat", {
    p_code_hash: hashConfirmToken(command.code),
    p_max_age_sec: TELEGRAM_LINK_MAX_AGE_SEC,
    p_chat_id: Number(chatId),
    p_label: chatLabel(chat),
  })) as { status?: string; eventId?: string | null };

  if (r?.status === "bound" || r?.status === "rebound") {
    if (r.eventId) {
      // The test alert is the reply: it goes through the receipts like any alert. If it can't
      // go now, the scheduled sender sends it within the minute.
      await deps.deliver(r.eventId).catch(() => deps.log?.("telegram: the test alert waits for the next sender pass"));
    } else {
      await reply(chatId, "Connected. This chat gets Staygreen alerts.");
    }
    return r.status;
  }
  if (r?.status === "expired") {
    await reply(chatId, `This link has expired. Make a new one on the Alerts screen: ${alerts}`);
    return "expired";
  }
  await reply(chatId, `This link was already used, or isn't one Staygreen made. Make a new one on the Alerts screen: ${alerts}`);
  return "missing";
}
