import "server-only";
import { env } from "./env";
import * as cipher from "./seal";

/* Customer credentials at rest (`AGENTS.md § 2.8`, `docs/architecture.md §
   Customer credentials`). Every secret a builder gives Staygreen (a secret
   header value, Stripe and Supabase key, Slack bot token or webhook credential) is sealed here before it reaches the database, and is never returned
   to a screen after save. A heartbeat's ping URL, which Staygreen makes, is
   sealed here too, so its monitor's page can show it again (`heartbeat.ts`).
   The cipher is `seal.ts`, shared with the probes, which open the values with
   the same key. The dashboard opens a header in one place: testing a monitor
   being edited, with a header the builder didn't retype (`testMonitor`). */

function key(): Buffer {
  return Buffer.from(env().CREDENTIALS_KEY, "base64url");
}

/** `context` names where the value lives, e.g. `monitor:mon_x/header:Authorization`. */
export const seal = (plaintext: string, context: string, k: Buffer = key()) => cipher.seal(plaintext, context, k);

/** For a heartbeat's URL on its own page (`heartbeat.ts`), and a kept header for one test of its
 *  monitor (`testMonitor` in `actions.ts`), which never sends it back; the probes open headers
 *  through `seal.ts`. Throws on a value sealed for another context. */
export const open = (sealed: string, context: string, k: Buffer = key()) => cipher.open(sealed, context, k);
