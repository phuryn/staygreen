import "server-only";
import { parseServerEnv, type ServerEnv } from "./env-schema";

/* The parsed environment. Server-only: nothing here may reach a client bundle.
   Parsed once, on first read, so a missing variable fails the first request
   loudly rather than producing `undefined` deep inside a query. `next.config.ts`
   runs the same schema at build and dev start. */

let parsed: ServerEnv | null = null;

export function env(): ServerEnv {
  if (!parsed) parsed = parseServerEnv(process.env as Record<string, string | undefined>);
  return parsed;
}
