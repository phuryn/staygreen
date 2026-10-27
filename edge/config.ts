import { z } from "zod";
import { databaseUrl, parseConfig, key32 } from "../probe/env";
import { hostnameSchema } from "../src/lib/hostname";

export const edgeSchema = z.object({
  EDGE_STATUS_HOST: hostnameSchema.default("status.staygreen.io"),
  EDGE_DATABASE_URL: databaseUrl,
  EDGE_ZONE_ID: z.string().regex(/^[a-f0-9]{32}$/),
  EDGE_PURGE_TOKEN: z.string().min(20).regex(/^[^\s\0]+$/),
  EDGE_RELEASE: z.string().regex(/^[a-f0-9]{64}$/),
  EDGE_CONTROL_SECRET: key32,
});

export const config = (env: Record<string, string | undefined>) => parseConfig(edgeSchema, env, "edge");
export const POLL_MS = 30_000;
