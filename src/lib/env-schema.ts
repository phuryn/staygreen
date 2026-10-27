import { z } from "zod";
import { hostnameSchema } from "./hostname";

/* The environment, as a shape. Pure and importable by tests and by
   `next.config.ts`; `env.ts` is the server-only module that parses
   `process.env` through it.

   `AGENTS.md § 1.7`: every variable has a placeholder in `.env.example`, a row
   in `docs/variables.md`, and a line here that fails when it is missing. The
   check runs from `next.config.ts` at build and dev start, because a
   `NEXT_PUBLIC_*` value is inlined into the client bundle when the build runs
   and a boot check would come after the leak. It checks each key's shape where
   the vendor gives one, and never echoes a value. */

/** An empty string is unset: `.env.example` ships `KEY=` lines, and `KEY=` must
 *  not satisfy a required key or be validated as a value. */
const unsetIfEmpty = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);

const required = <T extends z.ZodType>(schema: T) => z.preprocess(unsetIfEmpty, schema);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(unsetIfEmpty, schema.optional());

/** Vendor key shapes. A key in the wrong slot fails here, not as a 401 later. */
const CLERK_PUBLISHABLE = /^pk_(test|live)_[A-Za-z0-9$]+$/;
const CLERK_SECRET = /^sk_(test|live)_[A-Za-z0-9]+$/;
const SUPABASE_SECRET = /^sb_secret_[A-Za-z0-9_-]+$/;
const ANTHROPIC_KEY = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
/** A DNS name of two labels or more, or a local `wrangler dev` with an optional port. */
const HEARTBEAT_HOST = /^(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)$/;

/** Postmark's server tokens are UUIDs. */
const POSTMARK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An address, optionally behind a display name: `alerts@staygreen.io` or `Staygreen alerts <alerts@staygreen.io>`. */
const EMAIL_FROM = /^(?:[^<>@\r\n]{1,64} <[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/;

/** A Telegram bot token: the bot's id, a colon, and its secret. */
const TELEGRAM_TOKEN = /^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$/;

/** Anything that looks like a secret. A `NEXT_PUBLIC_*` value is in every
 *  visitor's browser, so a secret there is published the moment it is built. */
const SECRET_SHAPED = /^(sk_(test|live)_|sb_secret_|whsec_|re_[A-Za-z0-9]{8,}|rk_(test|live)_|sk-ant-|[0-9]{6,12}:[A-Za-z0-9_-]{30,})/;

const noSecret = (value: string) => !SECRET_SHAPED.test(value);
const NO_SECRET = "holds a secret-shaped value; a NEXT_PUBLIC_ variable is published to every browser";

/** AES-256-GCM wants exactly 32 bytes. */
const isKey32 = (value: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  return Buffer.from(value, "base64url").length === 32;
};

/** The half a browser bundle can see. Checked on every build, keys or not. */
export const publicEnvSchema = z.object({
  NEXT_PUBLIC_STATUS_HOST: required(hostnameSchema.default("status.staygreen.io")),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: required(
    z.string().refine(noSecret, NO_SECRET).refine((v) => CLERK_PUBLISHABLE.test(v), "is not a Clerk publishable key (pk_test_… or pk_live_…)"),
  ),
  /** Microsoft Clarity project id. Absent = no analytics script at all. */
  NEXT_PUBLIC_CLARITY_PROJECT_ID: optional(z.string().refine(noSecret, NO_SECRET).refine((v) => /^[a-z0-9]{6,16}$/.test(v), "is not a Clarity project id")),
  /** Where a data request reaches a human (`/legal/privacy`). */
  NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: optional(z.email().refine(noSecret, NO_SECRET)),
});

export const serverEnvSchema = publicEnvSchema
  .extend({
    /** Absolute base URL. Used for links that leave the request, like a heartbeat URL. */
    APP_URL: required(z.url().refine((v) => /^https?:\/\//.test(v), "must start with https:// (or http:// for localhost)")),

    SUPABASE_URL: required(z.url().refine((v) => /^https:\/\/[a-z0-9]{20}\.supabase\.co\/?$/.test(v) || /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(v), "is not a Supabase project URL (https://<ref>.supabase.co)")),
    /** The secret key. The browser never holds a Supabase key (`AGENTS.md § 1.4`). */
    SUPABASE_SECRET_KEY: required(z.string().refine((v) => SUPABASE_SECRET.test(v), "is not a Supabase secret key (sb_secret_…)")),

    CLERK_SECRET_KEY: required(z.string().refine((v) => CLERK_SECRET.test(v), "is not a Clerk secret key (sk_test_… or sk_live_…)")),

    /** The heartbeat Worker's host, the one every ping URL names (`src/lib/heartbeat.ts`,
     *  `ingest/`): `in.staygreen.io` in production, its own Worker's host in development. A
     *  host only, no scheme or path; a local `wrangler dev` (localhost or 127.0.0.1, with its
     *  port) is the one served over http. */
    HEARTBEAT_HOST: required(z.string().refine((v) => HEARTBEAT_HOST.test(v), "is a host name like in.staygreen.io (no scheme, no path), or localhost/127.0.0.1 with a port")),

    /** HMAC-SHA256 key that tags every heartbeat token (`src/lib/heartbeat-token.ts`), so the
     *  receiver refuses a made-up token without a database call. The Worker holds the same value
     *  as a secret (`ingest/README.md`). */
    HEARTBEAT_TOKEN_KEY: required(z.string().refine(isKey32, "must be 32 random bytes, base64url")),

    /** AES-256-GCM key for every credential a builder gives us (`AGENTS.md § 2.8`,
     *  `docs/architecture.md § Customer credentials`). */
    CREDENTIALS_KEY: required(z.string().refine(isKey32, "must be 32 random bytes, base64url")),

    /** Alert email through Postmark (`docs/emails.md`). The server token, the sender, and the
     *  secret that signs every unsubscribe link: all three set, or none, which turns alert
     *  email off (the Alerts screen says so, and the sender retries email receipts until its last
     *  try, about two hours, then marks them failed). */
    POSTMARK_SERVER_TOKEN: optional(z.string().refine((v) => POSTMARK_TOKEN.test(v), "is not a Postmark server token (a UUID)")),
    EMAIL_FROM: optional(z.string().refine((v) => EMAIL_FROM.test(v), "is a sender like Staygreen alerts <alerts@staygreen.io>")),
    ALERT_LINK_SECRET: optional(z.string().refine(isKey32, "must be 32 random bytes, base64url")),
    /** For development and test deployments, though nothing checks the environment: when set, every
     *  email the app and the sender send goes to this one address instead of its recipient. */
    EMAIL_REDIRECT_TO: optional(z.email("is not an email address")),
    /** Alerts on Telegram through the Staygreen bot (`docs/telegram.md`). Unset, the Alerts
     *  screen offers no Telegram link and the sender retries Telegram receipts as it does email's. Each
     *  environment has its own bot and sender Worker webhook. */
    TELEGRAM_BOT_TOKEN: optional(z.string().refine((v) => TELEGRAM_TOKEN.test(v), "is not a Telegram bot token (<bot id>:<secret>)")),
    /** Sender Worker only: Telegram's setWebhook secret_token, required by sender/config.ts.
     *  Kept here as the shared validation shape; Next has no Telegram webhook route. */
    TELEGRAM_WEBHOOK_SECRET: optional(z.string().refine(isKey32, "must be 32 random bytes, base64url")),
    /** Optional together until the owner creates Staygreen's Slack app. */
    SLACK_CLIENT_ID: optional(z.string().regex(/^\d+\.\d+$/, "is not a Slack client id")),
    SLACK_CLIENT_SECRET: optional(z.string().regex(/^[a-f0-9]{32,64}$/i, "is not a Slack client secret")),
    /** Operator enables only after the edge health and domain drill pass. */
    STATUS_EDGE_ENABLED: optional(z.enum(["on", "off"])),
    // Leave room for the random 32-character claim label and its dot.
    STATUS_DOMAIN_SUFFIX: required(hostnameSchema.max(220).default("domains.staygreen.io")),
    EDGE_CONTROL_SECRET: optional(z.string().refine(isKey32, "must be 32 random bytes, base64url")),
    /** API-token HMAC, request fingerprints and machine admission counters. */
    API_TOKEN_PEPPER: required(z.string().refine(isKey32, "must be 32 random bytes, base64url")),
    /** Clerk webhook signing secret (Phase 4). */
    CLERK_WEBHOOK_SECRET: optional(z.string().refine((v) => v.startsWith("whsec_"), "is not a webhook signing secret (whsec_…)")),
    SENTRY_DSN: optional(z.url()),
    /** Claude API key for the one model call an app's suggested checks make (`site-model.ts`).
     *  Absent, the suggestions are made without it, the same way and with nothing said. */
    ANTHROPIC_API_KEY: optional(z.string().refine((v) => ANTHROPIC_KEY.test(v), "is not a Claude API key (sk-ant-…)")),
    /** Development only: `on` lets a cookie simulate the Builder plan (`session.ts`).
     *  Ignored unless NODE_ENV is development, so it does nothing in production. */
    DEV_PLAN_OVERRIDE: optional(z.string().refine((v) => v === "on" || v === "off", "is on or off (development only)")),
  })
  .superRefine((value, context) => {
    if (value.STATUS_EDGE_ENABLED === "on" && !value.EDGE_CONTROL_SECRET)
      context.addIssue({ code: "custom", path: ["EDGE_CONTROL_SECRET"], message: "is required when STATUS_EDGE_ENABLED is on" });
    const email = [value.POSTMARK_SERVER_TOKEN, value.EMAIL_FROM, value.ALERT_LINK_SECRET];
    if (!!value.SLACK_CLIENT_ID !== !!value.SLACK_CLIENT_SECRET)
      context.addIssue({ code: "custom", path: ["SLACK_CLIENT_ID"], message: "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are set together or not at all" });
    if (email.some(Boolean) && !email.every(Boolean)) {
      context.addIssue({ code: "custom", path: ["POSTMARK_SERVER_TOKEN"], message: "POSTMARK_SERVER_TOKEN, EMAIL_FROM and ALERT_LINK_SECRET are set together or not at all" });
    }
    if (value.TELEGRAM_WEBHOOK_SECRET && !value.TELEGRAM_BOT_TOKEN) {
      context.addIssue({ code: "custom", path: ["TELEGRAM_WEBHOOK_SECRET"], message: "is set without TELEGRAM_BOT_TOKEN" });
    }
  });

export type PublicEnv = z.infer<typeof publicEnvSchema>;
export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

/** Our words for an issue. Never the input: only text written in this file, so
 *  a value cannot reach a log through a vendor's message. */
function describe(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return "is missing"; // every env value is a string, so a wrong type is an absent one
    case "custom":
    case "too_small":
      return issue.message; // the refinements and minimums above, all ours
    case "invalid_format":
      return `is not a valid ${issue.format}`;
    default:
      return "has the wrong shape";
  }
}

/** One message listing every failure by name. */
function fail(issues: z.core.$ZodIssue[]): never {
  const names = new Map<string, string>();
  for (const issue of issues) {
    const name = issue.path.join(".") || "(root)";
    if (!names.has(name)) names.set(name, describe(issue));
  }
  const lines = [...names].map(([name, why]) => `  ${name} ${why}`).join("\n");
  throw new EnvError(
    `Staygreen refuses to start on a partial configuration (AGENTS.md § 1.4).\n${lines}\n` +
      `Every variable has a placeholder in .env.example and a row in docs/variables.md.`,
  );
}

export function parsePublicEnv(source: Record<string, string | undefined>): PublicEnv {
  const parsed = publicEnvSchema.safeParse(source);
  if (!parsed.success) fail(parsed.error.issues);
  return parsed.data;
}

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const parsed = serverEnvSchema.safeParse(source);
  if (!parsed.success) fail(parsed.error.issues);
  return parsed.data;
}
