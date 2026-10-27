import type { ServerEnv } from "../env-schema";
import { createServerClient } from "../supabase-client";
import { membersOf } from "./clerk";
import { linkSecret } from "./links";
import type { PostmarkConfig } from "./postmark";
import { rpcFromSupabase, type Rpc } from "./rpc";
import type { SenderDeps } from "./sender";
import type { TelegramConfig } from "./telegram";

/* Dashboard/local drill dependencies. The Worker builds its own dependencies in sender/worker.ts
   and holds only its restricted database login, never the Supabase service key. This adapter
   remains for immediate dashboard tests and the local Postmark drill; confirmation emails and
   bot links also use the transport config below. No server-only import because the drill bundles
   it outside Next; never import it from a browser module. */

/** Postmark's transactional stream on the `staygreen.io` server (owner, 2026-10-22). */
export const POSTMARK_STREAM = "outbound";

export function postmarkConfig(e: ServerEnv): PostmarkConfig | null {
  if (!e.POSTMARK_SERVER_TOKEN || !e.EMAIL_FROM) return null;
  return { token: e.POSTMARK_SERVER_TOKEN, from: e.EMAIL_FROM, stream: POSTMARK_STREAM, redirectTo: e.EMAIL_REDIRECT_TO ?? null };
}

export function telegramConfig(e: ServerEnv): TelegramConfig | null {
  return e.TELEGRAM_BOT_TOKEN ? { token: e.TELEGRAM_BOT_TOKEN } : null;
}

export function serverRpc(e: ServerEnv): Rpc {
  return rpcFromSupabase(createServerClient<never>(e.SUPABASE_URL, e.SUPABASE_SECRET_KEY));
}

export function senderDeps(e: ServerEnv, rpc: Rpc = serverRpc(e), log?: (line: string) => void): SenderDeps {
  return {
    rpc,
    postmark: postmarkConfig(e),
    telegram: telegramConfig(e),
    members: (orgId) => membersOf(e.CLERK_SECRET_KEY, orgId),
    linkSecret: e.ALERT_LINK_SECRET ? linkSecret(e.ALERT_LINK_SECRET) : null,
    appUrl: e.APP_URL,
    log,
  };
}
