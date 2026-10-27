import { z } from "zod";
import { parseConfig } from "../probe/env";
import { serverEnvSchema } from "../src/lib/env-schema";

// Reuse vendor key shapes, but a deployed sender requires both transports. The dashboard's
// optional capabilities must not silently turn a cron into a successful no-op.
const fields = serverEnvSchema.shape;
const present = <T>(schema: z.ZodType<T | undefined>) => schema.transform((v, ctx): T => {
  if (v === undefined) { ctx.addIssue({ code: "custom" }); return z.NEVER; }
  return v;
});
export const configSchema = z.object({
  APP_URL: fields.APP_URL,
  CREDENTIALS_KEY: fields.CREDENTIALS_KEY,
  CLERK_SECRET_KEY: fields.CLERK_SECRET_KEY,
  POSTMARK_SERVER_TOKEN: present(fields.POSTMARK_SERVER_TOKEN),
  EMAIL_FROM: present(fields.EMAIL_FROM),
  EMAIL_REDIRECT_TO: fields.EMAIL_REDIRECT_TO,
  ALERT_LINK_SECRET: present(fields.ALERT_LINK_SECRET),
  TELEGRAM_BOT_TOKEN: present(fields.TELEGRAM_BOT_TOKEN),
  TELEGRAM_WEBHOOK_SECRET: present(fields.TELEGRAM_WEBHOOK_SECRET),
});
export type Config = z.infer<typeof configSchema>;
export const config = (env: unknown): Config => parseConfig(configSchema, env, "Sender");
