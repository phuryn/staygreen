import { z } from "zod";

export const probeId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const databaseUrl = z.string().url().refine((v) => ["postgres:", "postgresql:"].includes(new URL(v).protocol));
export const key32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine((v) => Buffer.from(v, "base64url").length === 32);
export const peerSecret = z.string().min(32).max(512).regex(/^[^\r\n\0]+$/);
export const runtimeSchema = z.object({
  DATABASE_URL: databaseUrl,
  PROBE_ID: probeId,
  PROBE_LOCATION: z.enum(["tor1", "sfo3", "fra1"]),
  PROBE_URL: z.string().url().refine((v) => { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash; }),
  PROBE_BUILDER_ONLY: z.enum(["true", "false"]).default("false"),
  PROBE_PORT: z.coerce.number().int().min(1).max(65535).default(7070),
  PROBE_PEER_SECRET: peerSecret,
  CREDENTIALS_KEY: key32,
  PROBE_WORKSPACES: z.string().regex(/^[a-zA-Z0-9_, -]*$/).optional(),
  PROBE_RELEASE: z.string().regex(/^[a-f0-9]{64}$/),
}).refine((e) => e.PROBE_LOCATION !== "fra1" || e.PROBE_BUILDER_ONLY === "true", { path: ["PROBE_BUILDER_ONLY"] });

export class ConfigError extends Error {}

/** Zod's messages can contain user input. Print field names only, for every runtime and script. */
export function parseConfig<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ConfigError(`${label}: missing or invalid ${[...new Set(r.error.issues.map((i) => i.path.join(".")))].join(", ")}`);
  return r.data;
}
